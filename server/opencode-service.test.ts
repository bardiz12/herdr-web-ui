import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  listPendingQuestionForms,
  opencodeAuthHeader,
  opencodeStateDir,
  readOpenCodeService,
  replyOpenCodeForm,
  type OpenCodeServiceConfig,
} from "./opencode-service.ts";

describe("opencode-service", () => {
  it("sends native credentials and answers directly despite proxy environment variables", async () => {
    const direct: string[] = [];
    const proxied: string[] = [];
    const service = Bun.serve({
      port: 0, hostname: "127.0.0.1",
      fetch(request) {
        direct.push(request.method);
        return request.method === "GET" ? Response.json([]) : new Response(null, { status: 204 });
      },
    });
    const proxy = Bun.serve({
      port: 0, hostname: "127.0.0.1",
      fetch(request) {
        proxied.push(new URL(request.url).pathname);
        return request.method === "GET" ? Response.json([]) : new Response(null, { status: 204 });
      },
    });
    try {
      const config = { baseUrl: service.url.origin, port: service.port, pid: process.pid, password: "fixture-secret" };
      const child = Bun.spawn([process.execPath, "-e", `
        import { listPendingQuestionForms, replyOpenCodeForm } from ${JSON.stringify(import.meta.dir + "/opencode-service.ts")};
        const config = ${JSON.stringify(config)};
        await fetch(config.baseUrl + "/control");
        console.log(JSON.stringify([await listPendingQuestionForms(config, "session"), await replyOpenCodeForm(config, "session", "form", {q0:"fixture-answer"})]));
      `], {
        env: { ...process.env, http_proxy: proxy.url.origin, HTTP_PROXY: proxy.url.origin, https_proxy: proxy.url.origin, HTTPS_PROXY: proxy.url.origin, ALL_PROXY: proxy.url.origin, all_proxy: proxy.url.origin, NO_PROXY: "", no_proxy: "" },
        stdout: "pipe", stderr: "pipe", timeout: 4_000,
      });
      const [output, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(error).toBe("");
      expect(code).toBe(0);
      expect(JSON.parse(output)).toEqual([[], { ok: true, status: 204 }]);
      expect(proxied).toEqual(["/control"]);
      expect(direct).toEqual(["GET", "POST"]);
    } finally { service.stop(true); proxy.stop(true); }
  });
  it.each(["https://127.0.0.1:4000", "http://example.com:4000", "file:///tmp/service", "not a URL"])("rejects untrusted service URL %s even with a port", (url) => {
    const tmp = mkdtempSync(join(tmpdir(), "opencode-service-test-"));
    try {
      writeFileSync(join(tmp, "service.json"), JSON.stringify({ url, port: 4000, pid: process.pid, password: "fixture" }));
      expect(readOpenCodeService(tmp)).toBeNull();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects oversized service files", () => {
    const tmp = mkdtempSync(join(tmpdir(), "opencode-service-test-"));
    try {
      writeFileSync(join(tmp, "service.json"), JSON.stringify({ port: 4000, pid: process.pid, password: "x".repeat(65_536) }));
      expect(readOpenCodeService(tmp)).toBeNull();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects dead process ids", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "opencode-service-test-"));
    const child = Bun.spawn([process.execPath, "-e", ""], { stdout: "ignore", stderr: "ignore" });
    await child.exited;
    try {
      writeFileSync(join(tmp, "service.json"), JSON.stringify({ port: 4000, pid: child.pid, password: "fixture" }));
      expect(readOpenCodeService(tmp)).toBeNull();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("rejects a FIFO without waiting for its writer", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "opencode-service-test-"));
    const path = join(tmp, "service.json");
    const child = Bun.spawn(["mkfifo", path], { stdout: "ignore", stderr: "ignore" });
    expect(await child.exited).toBe(0);
    const reader = Bun.spawn([process.execPath, "-e", `import { readOpenCodeService } from ${JSON.stringify(import.meta.dir + "/opencode-service.ts")}; console.log(JSON.stringify(readOpenCodeService(${JSON.stringify(tmp)})));`], { stdout: "pipe", stderr: "pipe" });
    const deadline = setTimeout(() => reader.kill(), 1_000);
    try {
      expect(await reader.exited).toBe(0);
      expect(await new Response(reader.stdout).text()).toBe("null\n");
    } finally {
      clearTimeout(deadline);
      reader.kill();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects malformed question fields at the HTTP boundary", async () => {
    const service = Bun.serve({
      port: 0, hostname: "127.0.0.1",
      fetch: () => Response.json([{ id: "form", sessionID: "session", title: "Form", metadata: { kind: "question" }, fields: [null] }]),
    });
    try {
      expect(await listPendingQuestionForms({ baseUrl: service.url.origin, port: service.port ?? 0, pid: process.pid, password: "fixture" }, "session")).toEqual([]);
    } finally { service.stop(true); }
  });

  it("does not follow redirects with a user's answers", async () => {
    let forwarded = 0;
    const target = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => { forwarded++; return new Response(null, { status: 204 }); } });
    const service = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response(null, { status: 307, headers: { location: target.url.href } }) });
    try {
      expect((await replyOpenCodeForm({ baseUrl: service.url.origin, port: service.port ?? 0, pid: process.pid, password: "fixture" }, "session", "form", { q0: "private" })).ok).toBe(false);
      expect(forwarded).toBe(0);
    } finally { service.stop(true); target.stop(true); }
  });
  it("resolves state dir from XDG_STATE_HOME or home directory", () => {
    expect(opencodeStateDir({ XDG_STATE_HOME: "/custom/state" }, "/home/user")).toBe("/custom/state/opencode");
    expect(opencodeStateDir({}, "/home/user")).toBe("/home/user/.local/state/opencode");
  });

  it("reads service.json when valid and returns null on missing or invalid file", () => {
    const tmp = mkdtempSync(join(tmpdir(), "opencode-service-test-"));
    try {
      expect(readOpenCodeService(tmp)).toBeNull();

      writeFileSync(join(tmp, "service.json"), "invalid json");
      expect(readOpenCodeService(tmp)).toBeNull();

      writeFileSync(join(tmp, "service.json"), JSON.stringify({ port: 4000, pid: 1234 }));
      expect(readOpenCodeService(tmp)).toBeNull();

      // With port
      writeFileSync(join(tmp, "service.json"), JSON.stringify({ port: 4000, pid: process.pid, password: "test-password" }));
      expect(readOpenCodeService(tmp)).toEqual({ baseUrl: "http://127.0.0.1:4000", port: 4000, pid: process.pid, password: "test-password" });

      // With url (OpenCode 2.0.32 format)
      writeFileSync(join(tmp, "service.json"), JSON.stringify({ url: "http://127.0.0.1:49374", pid: process.pid, password: "secret" }));
      expect(readOpenCodeService(tmp)).toEqual({ baseUrl: "http://127.0.0.1:49374", port: 49374, pid: process.pid, password: "secret" });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("formats Basic auth header correctly", () => {
    expect(atob(opencodeAuthHeader("secret-pass").slice(6))).toBe("opencode:secret-pass");
  });

  it("lists and filters pending question forms with direct array or { data: [] } wrapper", async () => {
    const config: OpenCodeServiceConfig = { baseUrl: "http://127.0.0.1:54321", port: 54321, pid: 9999, password: "test-pass" };
    let requestedUrl = "";
    let authHeader = "";

    const mockFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      requestedUrl = String(url);
      authHeader = String(init?.headers ? (init.headers as Record<string, string>)["Authorization"] : "");
      return new Response(JSON.stringify({
        data: [
          {
            id: "form-1",
            sessionID: "ses-123",
            title: "Question Form",
            metadata: { kind: "question" },
            fields: [{ key: "q0", type: "string", title: "Favorite color?" }],
          },
          {
            id: "form-2",
            sessionID: "ses-123",
            title: "Permission Form",
            metadata: { kind: "permission" },
            fields: [{ key: "allow", type: "boolean" }],
          },
          {
            id: "form-3",
            sessionID: "ses-123",
            title: "Unknown Form",
            fields: [],
          },
        ],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;

    const forms = await listPendingQuestionForms(config, "ses-123", mockFetch);
    expect(requestedUrl).toBe("http://127.0.0.1:54321/api/session/ses-123/form");
    expect(authHeader).toBe(`Basic ${btoa("opencode:test-pass")}`);
    expect(forms).not.toBeNull();
    expect(forms!.length).toBe(1);
    expect(forms![0]?.id).toBe("form-1");
  });

  it("handles non-200 responses when listing forms gracefully", async () => {
    const config: OpenCodeServiceConfig = { baseUrl: "http://127.0.0.1:54321", port: 54321, pid: 9999, password: "test-pass" };
    const mockFetch = (async () => new Response("Error", { status: 500 })) as unknown as typeof fetch;

    const forms = await listPendingQuestionForms(config, "ses-123", mockFetch);
    expect(forms).toBeNull();
  });

  it("returns empty array for successful responses with no question forms", async () => {
    const config: OpenCodeServiceConfig = { baseUrl: "http://127.0.0.1:54321", port: 54321, pid: 9999, password: "test-pass" };
    const mockFetch = (async () => new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } })) as unknown as typeof fetch;

    const forms = await listPendingQuestionForms(config, "ses-123", mockFetch);
    expect(forms).toEqual([]);
  });

  it("replies to forms with correct payload and headers", async () => {
    const config: OpenCodeServiceConfig = { baseUrl: "http://127.0.0.1:54321", port: 54321, pid: 9999, password: "test-pass" };
    let postedBody = "";

    const mockFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      postedBody = String(init?.body);
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;

    const result = await replyOpenCodeForm(config, "ses-123", "form-1", { q0: "Blue", q1: ["A", "B"] }, mockFetch);
    expect(result).toEqual({ ok: true, status: 204 });
    expect(JSON.parse(postedBody)).toEqual({ answer: { q0: "Blue", q1: ["A", "B"] } });
  });

  it("handles reply errors such as 409 FormAlreadySettledError", async () => {
    const config: OpenCodeServiceConfig = { baseUrl: "http://127.0.0.1:54321", port: 54321, pid: 9999, password: "test-pass" };
    const mockFetch = (async () => new Response(JSON.stringify({ error: "FormAlreadySettledError" }), { status: 409 })) as unknown as typeof fetch;

    const result = await replyOpenCodeForm(config, "ses-123", "form-1", { q0: "Blue" }, mockFetch);
    expect(result).toEqual({ ok: false, status: 409 });
  });

});
