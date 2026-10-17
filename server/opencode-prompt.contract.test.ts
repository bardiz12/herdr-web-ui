import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createServer } from "./index.ts";
import { herdrRpc, sessionSnapshot, workspaceClose, workspaceCreate } from "./herdr/client.ts";
import { opencodeAuthHeader } from "./opencode-service.ts";
import type { InteractivePrompt } from "../shared/protocol.ts";

const root = mkdtempSync(join(tmpdir(), "herdr-web-ui-opencode-prompt-contract-"));
const fakeOpencode = join(root, "bin", "opencode");
const workspaces: string[] = [];
let server: ReturnType<typeof createServer>;
let mockService: ReturnType<typeof Bun.serve>;
let mockPort = 0;
const PASSWORD = "test-secret-password";
const SESSION_SINGLE = "ses_opencodeQuestion01";
const SESSION_MULTI = "ses_opencodeQuestion02";

let pendingForms: Record<string, any[]> = {};
let receivedReplies: Array<{ sessionID: string; formID: string; answer: any; auth: string }> = [];

beforeAll(async () => {
  mkdirSync(join(root, "bin"), { recursive: true });
  writeFileSync(fakeOpencode, "#!/bin/sh\nsleep 600\n");
  chmodSync(fakeOpencode, 0o755);

  mockService = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const auth = req.headers.get("authorization") ?? "";

      // List forms: GET /api/session/{sessionID}/form
      const listMatch = url.pathname.match(/^\/api\/session\/([^/]+)\/form$/);
      if (req.method === "GET" && listMatch) {
        const sessionID = decodeURIComponent(listMatch[1]!);
        const forms = pendingForms[sessionID] ?? [];
        return new Response(JSON.stringify({ data: forms }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      // Reply form: POST /api/session/{sessionID}/form/{formID}/reply
      const replyMatch = url.pathname.match(/^\/api\/session\/([^/]+)\/form\/([^/]+)\/reply$/);
      if (req.method === "POST" && replyMatch) {
        const sessionID = decodeURIComponent(replyMatch[1]!);
        const formID = decodeURIComponent(replyMatch[2]!);
        const body = (await req.json()) as { answer: any };
        receivedReplies.push({ sessionID, formID, answer: body.answer, auth });
        // remove pending form
        pendingForms[sessionID] = (pendingForms[sessionID] ?? []).filter((f) => f.id !== formID);
        return new Response(null, { status: 204 });
      }

      return new Response("Not found", { status: 404 });
    },
  });

  mockPort = mockService.port ?? 0;

  // Write service.json into state dir
  writeFileSync(
    join(root, "service.json"),
    JSON.stringify({
      url: `http://127.0.0.1:${mockPort}`,
      pid: process.pid,
      password: PASSWORD,
    }),
  );

  server = createServer({
    port: 0,
    hostname: "127.0.0.1",
    token: "",
    stateDir: join(root, "server-state"),
    openCodeStateDir: root,
  });
  await server.statusReady;
});

afterAll(async () => {
  mockService?.stop(true);
  server?.stop();
  for (const id of workspaces) await workspaceClose(id).catch(() => {});
  rmSync(root, { recursive: true, force: true });
});

async function setupOpencodePane(sessionID: string, label: string): Promise<string> {
  const created = await workspaceCreate({ cwd: root, label: `test-opencode-${label}` });
  workspaces.push(created.workspace.workspace_id);
  const paneId = created.root_pane.pane_id;

  await herdrRpc("pane.send_text", { pane_id: paneId, text: `${fakeOpencode}\n` });
  for (const deadline = Date.now() + 10_000;;) {
    const pane = (await sessionSnapshot()).panes.find((candidate) => candidate.pane_id === paneId);
    if (pane?.agent === "opencode") break;
    if (Date.now() > deadline) throw new Error("test opencode did not start");
    await Bun.sleep(50);
  }

  // Report OpenCode session and blocked status to herdr
  await herdrRpc("pane.report_agent_session", {
    pane_id: paneId,
    source: "herdr:opencode",
    agent: "opencode",
    agent_session_id: sessionID,
    session_start_source: "select",
  });
  await herdrRpc("pane.report_agent", {
    pane_id: paneId,
    source: "herdr:opencode",
    agent: "opencode",
    agent_session_id: sessionID,
    state: "blocked",
  });

  for (let i = 0; i < 40; i++) {
    const pane = (await sessionSnapshot()).panes.find((p) => p.pane_id === paneId);
    if (pane?.agent_session?.agent === "opencode" && pane?.agent_status === "blocked") break;
    await Bun.sleep(50);
  }
  return paneId;
}

describe("opencode prompt contract", () => {
  it("detects single question form and answers it via native HTTP API", async () => {
    pendingForms[SESSION_SINGLE] = [
      {
        id: "form_single_1",
        sessionID: SESSION_SINGLE,
        title: "Configuration",
        metadata: { kind: "question" },
        fields: [
          {
            key: "q0",
            type: "string",
            title: "Color choice",
            description: "What is your favorite color?",
            options: [
              { value: "blue", label: "Blue", description: "The ocean" },
              { value: "red", label: "Red", description: "The fire" },
            ],
            custom: true,
          },
        ],
      },
    ];

    const paneId = await setupOpencodePane(SESSION_SINGLE, "single");

    // Poll GET /api/pane/prompt
    let prompt: InteractivePrompt | null = null;
    for (let i = 0; i < 50; i++) {
      const promptRes = await fetch(`http://127.0.0.1:${server.port}/api/pane/prompt?pane_id=${encodeURIComponent(paneId)}`);
      expect(promptRes.status).toBe(200);
      const promptBody = (await promptRes.json()) as { prompt: InteractivePrompt | null };
      if (promptBody.prompt) {
        prompt = promptBody.prompt;
        break;
      }
      await Bun.sleep(50);
    }
    expect(prompt).not.toBeNull();
    expect(prompt!.agent).toBe("opencode");
    expect(prompt!.kind).toBe("question");
    expect(prompt!.question).toBe("What is your favorite color?");
    expect(prompt!.options.length).toBe(3); // Blue, Red, Type your own answer
    expect(prompt!.custom_option_index).toBe(2);

    // Answer with "Red" (option_index 1)
    const answerRes = await fetch(`http://127.0.0.1:${server.port}/api/pane/prompt/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pane_id: paneId,
        prompt_id: prompt!.id,
        option_index: 1,
      }),
    });
    expect(answerRes.status).toBe(200);
    const answerBody = await answerRes.json();
    expect(answerBody).toEqual({ ok: true });

    // Verify mock server received reply with Basic auth and answer
    expect(receivedReplies.length).toBe(1);
    const reply = receivedReplies[0]!;
    expect(reply.sessionID).toBe(SESSION_SINGLE);
    expect(reply.formID).toBe("form_single_1");
    expect(reply.answer).toEqual({ q0: "red" });
    expect(reply.auth).toBe(opencodeAuthHeader(PASSWORD));
  });

  it("handles multi-question form sequentially with server-side buffering", async () => {
    receivedReplies = [];
    pendingForms[SESSION_MULTI] = [
      {
        id: "form_multi_1",
        sessionID: SESSION_MULTI,
        title: "Project Setup",
        metadata: { kind: "question" },
        fields: [
          {
            key: "framework",
            type: "string",
            title: "Framework",
            description: "Which frontend framework?",
            options: [
              { value: "react", label: "React" },
              { value: "vue", label: "Vue" },
            ],
            custom: false,
          },
          {
            key: "tools",
            type: "multiselect",
            title: "Tools",
            description: "Select tooling",
            options: [
              { value: "eslint", label: "ESLint" },
              { value: "prettier", label: "Prettier" },
              { value: "tailwind", label: "Tailwind CSS" },
            ],
          },
        ],
      },
    ];

    const paneId = await setupOpencodePane(SESSION_MULTI, "multi");

    // 1. Fetch step 1
    let step1: InteractivePrompt | null = null;
    for (let i = 0; i < 50; i++) {
      const res1 = await fetch(`http://127.0.0.1:${server.port}/api/pane/prompt?pane_id=${encodeURIComponent(paneId)}`);
      const body1 = (await res1.json()) as { prompt: InteractivePrompt | null };
      if (body1.prompt) {
        step1 = body1.prompt;
        break;
      }
      await Bun.sleep(50);
    }
    expect(step1).not.toBeNull();
    expect(step1!.question).toBe("Which frontend framework?");
    expect(step1!.steps).toBeDefined();
    expect(step1!.steps?.length).toBe(2);
    expect(step1!.steps?.[0]?.current).toBe(true);
    expect(step1!.steps?.[0]?.answered).toBe(false);

    // Answer step 1 with "React" (index 0)
    const ansRes1 = await fetch(`http://127.0.0.1:${server.port}/api/pane/prompt/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pane_id: paneId,
        prompt_id: step1!.id,
        option_index: 0,
      }),
    });
    expect(ansRes1.status).toBe(200);
    // Mock server must NOT have received reply yet!
    expect(receivedReplies.length).toBe(0);

    // 2. Fetch step 2
    let step2: InteractivePrompt | null = null;
    for (let i = 0; i < 50; i++) {
      const res2 = await fetch(`http://127.0.0.1:${server.port}/api/pane/prompt?pane_id=${encodeURIComponent(paneId)}`);
      const body2 = (await res2.json()) as { prompt: InteractivePrompt | null };
      if (body2.prompt && body2.prompt.question === "Select tooling") {
        step2 = body2.prompt;
        break;
      }
      await Bun.sleep(50);
    }
    expect(step2).not.toBeNull();
    expect(step2!.question).toBe("Select tooling");
    expect(step2!.multi_select).toBe(true);
    expect(step2!.steps?.[0]?.answered).toBe(true);
    expect(step2!.steps?.[1]?.current).toBe(true);

    // Answer step 2 with ESLint (0) and Tailwind (2)
    const ansRes2 = await fetch(`http://127.0.0.1:${server.port}/api/pane/prompt/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pane_id: paneId,
        prompt_id: step2!.id,
        option_indices: [0, 2],
      }),
    });
    expect(ansRes2.status).toBe(200);

    // Mock server must NOW have received the consolidated reply!
    expect(receivedReplies.length).toBe(1);
    const reply = receivedReplies[0]!;
    expect(reply.sessionID).toBe(SESSION_MULTI);
    expect(reply.formID).toBe("form_multi_1");
    expect(reply.answer).toEqual({
      framework: "react",
      tools: ["eslint", "tailwind"],
    });
  });

  it("handles custom text answers for OpenCode questions", async () => {
    const SESSION_CUSTOM = "ses_opencodeCustom01";
    receivedReplies = [];
    pendingForms[SESSION_CUSTOM] = [
      {
        id: "form_custom_1",
        sessionID: SESSION_CUSTOM,
        title: "Feedback",
        metadata: { kind: "question" },
        fields: [
          {
            key: "comments",
            type: "string",
            title: "Comments",
            description: "Any extra comments?",
            options: [],
            custom: true,
          },
        ],
      },
    ];

    const paneId = await setupOpencodePane(SESSION_CUSTOM, "custom");

    let prompt: InteractivePrompt | null = null;
    for (let i = 0; i < 50; i++) {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/pane/prompt?pane_id=${encodeURIComponent(paneId)}`);
      const body = (await res.json()) as { prompt: InteractivePrompt | null };
      if (body.prompt) {
        prompt = body.prompt;
        break;
      }
      await Bun.sleep(50);
    }
    expect(prompt).not.toBeNull();
    expect(prompt!.custom_option_index).toBe(0);

    // Answer with custom_text
    const ansRes = await fetch(`http://127.0.0.1:${server.port}/api/pane/prompt/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pane_id: paneId,
        prompt_id: prompt!.id,
        custom_text: "Everything looks great!",
      }),
    });
    expect(ansRes.status).toBe(200);

    expect(receivedReplies.length).toBe(1);
    expect(receivedReplies[0]!.answer).toEqual({ comments: "Everything looks great!" });
  });
});
