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
let replyStatusOverride = 0;

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
        if (replyStatusOverride > 0) {
          const status = replyStatusOverride;
          replyStatusOverride = 0;
          return new Response("Simulated error", { status });
        }
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

  let blocked = false;
  for (let i = 0; i < 40; i++) {
    const pane = (await sessionSnapshot()).panes.find((p) => p.pane_id === paneId);
    if (pane?.agent_session?.agent === "opencode" && pane?.agent_status === "blocked") {
      blocked = true;
      break;
    }
    await Bun.sleep(50);
  }
  if (!blocked) throw new Error("test opencode did not become blocked");
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

  it("allows stepping back to previous questions in a multi-step form and revising answers", async () => {
    const SESSION_STEP_BACK = "ses_opencodeStepBack01";
    receivedReplies = [];
    pendingForms[SESSION_STEP_BACK] = [
      {
        id: "form_stepback_1",
        sessionID: SESSION_STEP_BACK,
        title: "Multi-Step Wizard",
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
            key: "styling",
            type: "string",
            title: "Styling",
            description: "Which styling library?",
            options: [
              { value: "tailwind", label: "Tailwind" },
              { value: "vanilla", label: "Vanilla CSS" },
            ],
            custom: false,
          },
          {
            key: "notes",
            type: "string",
            title: "Notes",
            description: "Any extra notes?",
            options: [],
            custom: true,
          },
        ],
      },
    ];

    const paneId = await setupOpencodePane(SESSION_STEP_BACK, "stepback");

    // 1. Fetch step 0 (framework)
    let prompt0: InteractivePrompt | null = null;
    for (let i = 0; i < 50; i++) {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/pane/prompt?pane_id=${encodeURIComponent(paneId)}`);
      const body = (await res.json()) as { prompt: InteractivePrompt | null };
      if (body.prompt && body.prompt.question === "Which frontend framework?") {
        prompt0 = body.prompt;
        break;
      }
      await Bun.sleep(50);
    }
    expect(prompt0).not.toBeNull();
    expect(prompt0!.can_step_back).toBeFalsy();
    expect(prompt0!.steps?.[0]?.current).toBe(true);

    // Answer step 0 with "React" (index 0)
    const ans0 = await fetch(`http://127.0.0.1:${server.port}/api/pane/prompt/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pane_id: paneId,
        prompt_id: prompt0!.id,
        option_index: 0,
      }),
    });
    expect(ans0.status).toBe(200);

    // 2. Fetch step 1 (styling)
    let prompt1: InteractivePrompt | null = null;
    for (let i = 0; i < 50; i++) {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/pane/prompt?pane_id=${encodeURIComponent(paneId)}`);
      const body = (await res.json()) as { prompt: InteractivePrompt | null };
      if (body.prompt && body.prompt.question === "Which styling library?") {
        prompt1 = body.prompt;
        break;
      }
      await Bun.sleep(50);
    }
    expect(prompt1).not.toBeNull();
    expect(prompt1!.can_step_back).toBe(true);
    expect(prompt1!.steps?.[0]?.answered).toBe(true);
    expect(prompt1!.steps?.[1]?.current).toBe(true);

    // Step back to step 0
    const backRes = await fetch(`http://127.0.0.1:${server.port}/api/pane/prompt/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pane_id: paneId,
        prompt_id: prompt1!.id,
        step_back: true,
      }),
    });
    expect(backRes.status).toBe(200);

    // 3. Fetch step 0 again, verify default_option_index is preserved as React (0)
    let prompt0Again: InteractivePrompt | null = null;
    for (let i = 0; i < 50; i++) {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/pane/prompt?pane_id=${encodeURIComponent(paneId)}`);
      const body = (await res.json()) as { prompt: InteractivePrompt | null };
      if (body.prompt && body.prompt.question === "Which frontend framework?") {
        prompt0Again = body.prompt;
        break;
      }
      await Bun.sleep(50);
    }
    expect(prompt0Again).not.toBeNull();
    expect(prompt0Again!.can_step_back).toBeFalsy();
    expect(prompt0Again!.default_option_index).toBe(0);

    // Revise step 0 answer to "Vue" (index 1)
    const reviseAns = await fetch(`http://127.0.0.1:${server.port}/api/pane/prompt/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pane_id: paneId,
        prompt_id: prompt0Again!.id,
        option_index: 1,
      }),
    });
    expect(reviseAns.status).toBe(200);

    // 4. Fetch step 1 again and answer with "Tailwind" (0)
    let prompt1Again: InteractivePrompt | null = null;
    for (let i = 0; i < 50; i++) {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/pane/prompt?pane_id=${encodeURIComponent(paneId)}`);
      const body = (await res.json()) as { prompt: InteractivePrompt | null };
      if (body.prompt && body.prompt.question === "Which styling library?") {
        prompt1Again = body.prompt;
        break;
      }
      await Bun.sleep(50);
    }
    expect(prompt1Again).not.toBeNull();
    const ans1 = await fetch(`http://127.0.0.1:${server.port}/api/pane/prompt/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pane_id: paneId,
        prompt_id: prompt1Again!.id,
        option_index: 0,
      }),
    });
    expect(ans1.status).toBe(200);

    // 5. Fetch step 2 (notes), test direct step_index jump back to step 0
    let prompt2: InteractivePrompt | null = null;
    for (let i = 0; i < 50; i++) {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/pane/prompt?pane_id=${encodeURIComponent(paneId)}`);
      const body = (await res.json()) as { prompt: InteractivePrompt | null };
      if (body.prompt && body.prompt.question === "Any extra notes?") {
        prompt2 = body.prompt;
        break;
      }
      await Bun.sleep(50);
    }
    expect(prompt2).not.toBeNull();
    expect(prompt2!.can_step_back).toBe(true);

    // Direct jump to step 0 via step_index
    const jumpRes = await fetch(`http://127.0.0.1:${server.port}/api/pane/prompt/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pane_id: paneId,
        prompt_id: prompt2!.id,
        step_index: 0,
      }),
    });
    expect(jumpRes.status).toBe(200);

    // Verify we're back at step 0 with Vue (1) preserved
    let prompt0Jumped: InteractivePrompt | null = null;
    for (let i = 0; i < 50; i++) {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/pane/prompt?pane_id=${encodeURIComponent(paneId)}`);
      const body = (await res.json()) as { prompt: InteractivePrompt | null };
      if (body.prompt && body.prompt.question === "Which frontend framework?") {
        prompt0Jumped = body.prompt;
        break;
      }
      await Bun.sleep(50);
    }
    expect(prompt0Jumped).not.toBeNull();
    expect(prompt0Jumped!.default_option_index).toBe(1);

    // Keep Vue (index 1), answer and advance through styling to notes
    await fetch(`http://127.0.0.1:${server.port}/api/pane/prompt/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pane_id: paneId,
        prompt_id: prompt0Jumped!.id,
        option_index: 1,
      }),
    });

    let prompt1Adv: InteractivePrompt | null = null;
    for (let i = 0; i < 50; i++) {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/pane/prompt?pane_id=${encodeURIComponent(paneId)}`);
      const body = (await res.json()) as { prompt: InteractivePrompt | null };
      if (body.prompt && body.prompt.question === "Which styling library?") {
        prompt1Adv = body.prompt;
        break;
      }
      await Bun.sleep(50);
    }
    expect(prompt1Adv).not.toBeNull();
    expect(prompt1Adv!.default_option_index).toBe(0); // Tailwind was previously chosen

    await fetch(`http://127.0.0.1:${server.port}/api/pane/prompt/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pane_id: paneId,
        prompt_id: prompt1Adv!.id,
        option_index: 0,
      }),
    });

    // Finally at notes, submit custom_text
    let prompt2Final: InteractivePrompt | null = null;
    for (let i = 0; i < 50; i++) {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/pane/prompt?pane_id=${encodeURIComponent(paneId)}`);
      const body = (await res.json()) as { prompt: InteractivePrompt | null };
      if (body.prompt && body.prompt.question === "Any extra notes?") {
        prompt2Final = body.prompt;
        break;
      }
      await Bun.sleep(50);
    }
    expect(prompt2Final).not.toBeNull();

    const finalAns = await fetch(`http://127.0.0.1:${server.port}/api/pane/prompt/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pane_id: paneId,
        prompt_id: prompt2Final!.id,
        custom_text: "All set!",
      }),
    });
    expect(finalAns.status).toBe(200);

    // Consolidated payload submitted to OpenCode
    expect(receivedReplies.length).toBe(1);
    expect(receivedReplies[0]!.sessionID).toBe(SESSION_STEP_BACK);
    expect(receivedReplies[0]!.formID).toBe("form_stepback_1");
    expect(receivedReplies[0]!.answer).toEqual({
      framework: "vue",
      styling: "tailwind",
      notes: "All set!",
    });
  });

  it("preserves form draft when reply fails with non-409 error and allows retry", async () => {
    const SESSION_RETRY = "ses_opencodeRetry";
    pendingForms[SESSION_RETRY] = [
      {
        id: "form_retry_1",
        sessionID: SESSION_RETRY,
        title: "Deploy Options",
        metadata: { kind: "question" },
        fields: [
          {
            key: "target",
            type: "select",
            description: "Deploy Target",
            options: [
              { label: "Staging", value: "staging" },
              { label: "Production", value: "production" },
            ],
          },
        ],
      },
    ];

    const paneId = await setupOpencodePane(SESSION_RETRY, "retry");

    let prompt: InteractivePrompt | null = null;
    for (let i = 0; i < 50; i++) {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/pane/prompt?pane_id=${encodeURIComponent(paneId)}`);
      const body = (await res.json()) as { prompt: InteractivePrompt | null };
      if (body.prompt && body.prompt.question === "Deploy Target") {
        prompt = body.prompt;
        break;
      }
      await Bun.sleep(50);
    }
    expect(prompt).not.toBeNull();

    // Simulate 500 error on first reply attempt
    replyStatusOverride = 500;
    const failRes = await fetch(`http://127.0.0.1:${server.port}/api/pane/prompt/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pane_id: paneId,
        prompt_id: prompt!.id,
        option_index: 0,
      }),
    });
    expect(failRes.status).toBe(502);

    // Prompt is still available and previous draft wasn't deleted
    let retryPrompt: InteractivePrompt | null = null;
    for (let i = 0; i < 50; i++) {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/pane/prompt?pane_id=${encodeURIComponent(paneId)}`);
      const body = (await res.json()) as { prompt: InteractivePrompt | null };
      if (body.prompt && body.prompt.question === "Deploy Target") {
        retryPrompt = body.prompt;
        break;
      }
      await Bun.sleep(50);
    }
    expect(retryPrompt).not.toBeNull();
    expect(retryPrompt!.default_option_index).toBe(0);

    // Retry succeeds
    const successRes = await fetch(`http://127.0.0.1:${server.port}/api/pane/prompt/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pane_id: paneId,
        prompt_id: retryPrompt!.id,
        option_index: 0,
      }),
    });
    expect(successRes.status).toBe(200);
  }, 20_000);

  it("handles multiple concurrent OpenCode instances independently without draft crosstalk", async () => {
    const SESSION_A = "ses_opencodeMultiInstanceA";
    const SESSION_B = "ses_opencodeMultiInstanceB";

    pendingForms[SESSION_A] = [
      {
        id: "form_a_1",
        sessionID: SESSION_A,
        title: "Instance A Setup",
        metadata: { kind: "question" },
        fields: [
          {
            key: "service_name",
            type: "string",
            description: "Service Name",
            options: [],
            custom: true,
          },
          {
            key: "env",
            type: "select",
            description: "Environment",
            options: [
              { label: "Staging", value: "staging" },
              { label: "Production", value: "production" },
            ],
          },
        ],
      },
    ];

    pendingForms[SESSION_B] = [
      {
        id: "form_b_1",
        sessionID: SESSION_B,
        title: "Instance B Database",
        metadata: { kind: "question" },
        fields: [
          {
            key: "db",
            type: "select",
            description: "Database Engine",
            options: [
              { label: "PostgreSQL", value: "postgres" },
              { label: "SQLite", value: "sqlite" },
            ],
          },
        ],
      },
    ];

    const paneIdA = await setupOpencodePane(SESSION_A, "instance-a");
    const paneIdB = await setupOpencodePane(SESSION_B, "instance-b");

    receivedReplies = [];

    // 1. Fetch prompts for both instances
    let promptA1: InteractivePrompt | null = null;
    let promptB: InteractivePrompt | null = null;

    for (let i = 0; i < 50; i++) {
      if (!promptA1) {
        const resA = await fetch(`http://127.0.0.1:${server.port}/api/pane/prompt?pane_id=${encodeURIComponent(paneIdA)}`);
        const bodyA = (await resA.json()) as { prompt: InteractivePrompt | null };
        if (bodyA.prompt?.question === "Service Name") promptA1 = bodyA.prompt;
      }
      if (!promptB) {
        const resB = await fetch(`http://127.0.0.1:${server.port}/api/pane/prompt?pane_id=${encodeURIComponent(paneIdB)}`);
        const bodyB = (await resB.json()) as { prompt: InteractivePrompt | null };
        if (bodyB.prompt?.question === "Database Engine") promptB = bodyB.prompt;
      }
      if (promptA1 && promptB) break;
      await Bun.sleep(50);
    }

    expect(promptA1).not.toBeNull();
    expect(promptB).not.toBeNull();

    // 2. Answer step 1 of Instance A with custom text "AuthService"
    const ansA1 = await fetch(`http://127.0.0.1:${server.port}/api/pane/prompt/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pane_id: paneIdA,
        prompt_id: promptA1!.id,
        custom_text: "AuthService",
      }),
    });
    expect(ansA1.status).toBe(200);

    // Verify Instance B's prompt is still active and unchanged
    const resBCheck = await fetch(`http://127.0.0.1:${server.port}/api/pane/prompt?pane_id=${encodeURIComponent(paneIdB)}`);
    const bodyBCheck = (await resBCheck.json()) as { prompt: InteractivePrompt | null };
    expect(bodyBCheck.prompt).not.toBeNull();
    expect(bodyBCheck.prompt!.question).toBe("Database Engine");

    // 3. Answer Instance B with "PostgreSQL" (index 0) -> this settles Instance B
    const ansB = await fetch(`http://127.0.0.1:${server.port}/api/pane/prompt/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pane_id: paneIdB,
        prompt_id: bodyBCheck.prompt!.id,
        option_index: 0,
      }),
    });
    expect(ansB.status).toBe(200);

    // Verify Instance B reply was sent, but NOT Instance A
    expect(receivedReplies.length).toBe(1);
    expect(receivedReplies[0]!.sessionID).toBe(SESSION_B);
    expect(receivedReplies[0]!.formID).toBe("form_b_1");
    expect(receivedReplies[0]!.answer).toEqual({ db: "postgres" });

    // 4. Fetch step 2 of Instance A
    let promptA2: InteractivePrompt | null = null;
    for (let i = 0; i < 50; i++) {
      const resA2 = await fetch(`http://127.0.0.1:${server.port}/api/pane/prompt?pane_id=${encodeURIComponent(paneIdA)}`);
      const bodyA2 = (await resA2.json()) as { prompt: InteractivePrompt | null };
      if (bodyA2.prompt?.question === "Environment") {
        promptA2 = bodyA2.prompt;
        break;
      }
      await Bun.sleep(50);
    }
    expect(promptA2).not.toBeNull();
    expect(promptA2!.can_step_back).toBe(true);

    // 5. Answer step 2 of Instance A with "Production" (index 1) -> settles Instance A
    const ansA2 = await fetch(`http://127.0.0.1:${server.port}/api/pane/prompt/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pane_id: paneIdA,
        prompt_id: promptA2!.id,
        option_index: 1,
      }),
    });
    expect(ansA2.status).toBe(200);

    // Both instances have now replied with their own respective answers
    expect(receivedReplies.length).toBe(2);
    expect(receivedReplies[1]!.sessionID).toBe(SESSION_A);
    expect(receivedReplies[1]!.formID).toBe("form_a_1");
    expect(receivedReplies[1]!.answer).toEqual({
      service_name: "AuthService",
      env: "production",
    });
  }, 25_000);
});
