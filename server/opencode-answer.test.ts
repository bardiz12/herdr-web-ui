import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { InteractivePrompt, PromptAnswer } from "../shared/protocol.ts";
import { handlePromptRequest } from "./prompt.ts";
import type { OpenCodeFormInfo } from "./opencode-service.ts";

const deferred = <T>() => Promise.withResolvers<T>();
let serial = 0;

/** Real HTTP and RPC boundaries, but only fixture state; each delayed reply has an explicit gate. */
async function fixture(run: (f: {
  forms: OpenCodeFormInfo[];
  session: string | null;
  closed: boolean;
  replies: unknown[];
  sent: string[];
  listing?: () => Promise<Response>;
  replying?: () => Promise<Response>;
  read(): Promise<InteractivePrompt>;
  answer(prompt: InteractivePrompt, choice: Omit<PromptAnswer, "pane_id" | "prompt_id">, signal?: AbortSignal): Promise<Response>;
}) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "opencode-answer-"));
  const path = join(root, "herdr.sock");
  const paneId = `oc_${++serial}`;
  const session = "ses_fixture01";
  const url = new URL(`http://localhost/api/pane/prompt?pane_id=${paneId}`);
  const answerUrl = new URL("http://localhost/api/pane/prompt/answer");
  const options = { openCodeStateDir: root };
  const f = {
    session: session as string | null, closed: false,
    forms: [{
      id: "form_a", sessionID: session, title: "Fixture", metadata: { kind: "question" },
      fields: [{ key: "q0", type: "string", custom: true }, { key: "q1", type: "string", custom: true }],
    }] satisfies OpenCodeFormInfo[],
    replies: [] as unknown[], sent: [] as string[],
    listing: undefined as (() => Promise<Response>) | undefined,
    replying: undefined as (() => Promise<Response>) | undefined,
    async read() {
      const response = await handlePromptRequest(new Request(url), url, options);
      expect(response?.status).toBe(200);
      const text = await response!.text();
      expect(text).not.toContain("fixture-password");
      expect(text).not.toContain(service.url.origin);
      const { prompt } = JSON.parse(text) as { prompt: InteractivePrompt };
      return prompt;
    },
    async answer(prompt: InteractivePrompt, choice: Omit<PromptAnswer, "pane_id" | "prompt_id">, signal?: AbortSignal) {
      const response = await handlePromptRequest(new Request(answerUrl, {
        method: "POST", signal, body: JSON.stringify({ pane_id: paneId, prompt_id: prompt.id, ...choice }),
      }), answerUrl, options);
      expect(response).not.toBeNull();
      const text = await response!.clone().text();
      expect(text).not.toContain("fixture-password");
      expect(text).not.toContain(service.url.origin);
      return response!;
    },
  };
  const service = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      if (request.method === "GET") {
        const listing = f.listing;
        f.listing = undefined;
        return listing ? listing() : Response.json(f.forms);
      }
      f.replies.push(await request.json());
      return f.replying ? f.replying() : new Response(null, { status: 204 });
    },
  });
  writeFileSync(join(root, "service.json"), JSON.stringify({ url: service.url.origin, password: "fixture-password", pid: process.pid }));
  const sockets = new Set<Socket>();
  const rpc = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let input = "";
    socket.on("data", (chunk) => {
      input += chunk.toString();
      if (!input.includes("\n")) return;
      const req = JSON.parse(input.split("\n")[0]!) as { id: string; method: string };
      const pane = {
        pane_id: paneId, agent: f.session ? "opencode" : null, agent_status: "blocked",
        agent_session: f.session ? { agent: "opencode", source: "herdr:opencode", kind: "id", value: f.session } : null,
      };
      if (req.method.startsWith("pane.send")) f.sent.push(req.method);
      const result = req.method === "session.snapshot" ? { snapshot: { panes: f.closed ? [] : [pane], layouts: [] } } : { read: { text: "" } };
      socket.end(`${JSON.stringify({ id: req.id, result })}\n`);
    });
  });
  await new Promise<void>((resolve, reject) => { rpc.once("error", reject); rpc.listen(path, resolve); });
  const previous = process.env["HERDR_SOCKET"];
  process.env["HERDR_SOCKET"] = path;
  try { await run(f); expect(f.sent).toEqual([]); }
  finally {
    if (previous === undefined) delete process.env["HERDR_SOCKET"]; else process.env["HERDR_SOCKET"] = previous;
    service.stop(true);
    for (const socket of sockets) socket.destroy();
    rpc.close();
    rmSync(root, { recursive: true, force: true });
  }
}

describe("OpenCode answer ordering", () => {
  it("never returns service credentials or location in GET and POST responses", async () => {
    await fixture(async (f) => {
      f.forms[0]!.fields.length = 1;
      expect((await f.answer(await f.read(), { custom_text: "first" })).status).toBe(200);
      expect(f.replies).toEqual([{ answer: { q0: "first" } }]);
    });
  });
  it.each(["switch", "close", "abort"] as const)("refuses an answer when %s happens during form lookup", async (change) => {
    await fixture(async (f) => {
      f.forms[0]!.fields.length = 1;
      const prompt = await f.read();
      const entered = deferred<void>();
      const release = deferred<void>();
      const controller = new AbortController();
      f.listing = async () => { entered.resolve(); await release.promise; return Response.json(f.forms); };
      const answering = f.answer(prompt, { custom_text: "private answer" }, controller.signal);
      await entered.promise;
      if (change === "switch") f.session = "ses_fixture02";
      if (change === "close") f.closed = true;
      if (change === "abort") controller.abort();
      release.resolve();
      expect((await answering).status).toBe(409);
      expect(f.replies).toEqual([]);
    });
  });

  it("does not let a late empty listing erase an acknowledged answer", async () => {
    await fixture(async (f) => {
      const first = await f.read();
      const entered = deferred<void>();
      const release = deferred<void>();
      f.listing = async () => { entered.resolve(); await release.promise; return Response.json([]); };
      const oldRead = f.read();
      await entered.promise;
      expect((await f.answer(first, { custom_text: "saved first" })).status).toBe(200);
      release.resolve();
      await oldRead;
      expect((await f.read()).steps?.[1]?.current).toBe(true);
    });
  });

  it("does not copy an old form answer into its replacement", async () => {
    await fixture(async (f) => {
      expect((await f.answer(await f.read(), { custom_text: "old secret" })).status).toBe(200);
      f.forms[0]!.id = "form_replacement";
      expect((await f.read()).default_custom_text).toBeUndefined();
    });
  });

  it("does not reuse a draft in another session with the same form id", async () => {
    await fixture(async (f) => {
      expect((await f.answer(await f.read(), { custom_text: "old session" })).status).toBe(200);
      f.session = "ses_fixture02";
      f.forms[0]!.sessionID = f.session;
      expect((await f.read()).steps?.[0]?.current).toBe(true);
    });
  });

  it("drops buffered answers when the OpenCode session ends", async () => {
    await fixture(async (f) => {
      expect((await f.answer(await f.read(), { custom_text: "old session" })).status).toBe(200);
      f.session = null;
      expect(await f.read()).toBeNull();
      f.session = "ses_fixture01";
      expect((await f.read()).steps?.[0]?.current).toBe(true);
    });
  });

  it("keeps custom multiselect answers as native arrays", async () => {
    await fixture(async (f) => {
      f.forms[0]!.fields = [{ key: "q0", type: "multiselect", custom: true, options: [{ value: "a", label: "A" }] }];
      const prompt = await f.read();
      expect(prompt.custom_option_index).toBe(1);
      expect((await f.answer(prompt, { custom_text: "own" })).status).toBe(200);
      expect(f.replies).toEqual([{ answer: { q0: ["own"] } }]);
    });
  });

  it("returns graceful fallback for malformed fields", async () => {
    await fixture(async (f) => {
      f.listing = async () => Response.json([{ ...f.forms[0], fields: [null] }]);
      expect(await f.read()).toBeNull();
    });
  });

  it("never offers terminal keystrokes when native forms are unavailable", async () => {
    await fixture(async (f) => {
      f.forms = [];
      expect(await f.read()).toBeNull();
    });
  });

  it("does not poll again after advancing a native form", async () => {
    await fixture(async (f) => {
      const first = await f.read();
      let reads = 0;
      const list = async (): Promise<Response> => {
        reads++;
        f.listing = list;
        return Response.json(f.forms);
      };
      f.listing = list;
      expect((await f.answer(first, { custom_text: "first" })).status).toBe(200);
      expect(reads).toBe(1);
    });
  });

  it("saves unsent edits on backward navigation", async () => {
    await fixture(async (f) => {
      expect((await f.answer(await f.read(), { custom_text: "first" })).status).toBe(200);
      expect((await f.answer(await f.read(), {
        step_back: true, draft: { option_indices: [], custom_text: "not submitted yet" },
      })).status).toBe(200);
      expect((await f.answer(await f.read(), { custom_text: "revised first" })).status).toBe(200);
      expect((await f.read()).default_custom_text).toBe("not submitted yet");
      expect(f.replies).toEqual([]);
    });
  });

  it("rejects a final response if the session changed while posting", async () => {
    await fixture(async (f) => {
      f.forms[0]!.fields.length = 1;
      const entered = deferred<void>();
      const release = deferred<void>();
      f.replying = async () => { entered.resolve(); await release.promise; return new Response(null, { status: 204 }); };
      const answering = f.answer(await f.read(), { custom_text: "first" });
      await entered.promise;
      f.session = "ses_fixture02";
      release.resolve();
      expect((await answering).status).toBe(409);
    });
  });

  it("bounds an unresponsive service lookup without waiting for a reply", async () => {
    await fixture(async (f) => {
      const prompt = await f.read();
      const release = deferred<Response>();
      f.listing = () => release.promise;
      const start = performance.now();
      try {
        expect((await f.answer(prompt, { custom_text: "first" })).status).toBe(409);
        expect(performance.now() - start).toBeLessThan(2_500);
        expect(f.replies).toEqual([]);
      } finally { release.resolve(Response.json(f.forms)); }
    });
  }, 3_000);
});
