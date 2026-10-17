import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  cancelOpenCodeForm,
  listPendingQuestionForms,
  opencodeAuthHeader,
  opencodeStateDir,
  readOpenCodeService,
  replyOpenCodeForm,
  type OpenCodeServiceConfig,
} from "./opencode-service.ts";

describe("opencode-service", () => {
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
      writeFileSync(join(tmp, "service.json"), JSON.stringify({ port: 4000, pid: 1234, password: "test-password" }));
      expect(readOpenCodeService(tmp)).toEqual({ baseUrl: "http://127.0.0.1:4000", port: 4000, pid: 1234, password: "test-password" });

      // With url (OpenCode 2.0.32 format)
      writeFileSync(join(tmp, "service.json"), JSON.stringify({ url: "http://127.0.0.1:49374", pid: 22877, password: "secret" }));
      expect(readOpenCodeService(tmp)).toEqual({ baseUrl: "http://127.0.0.1:49374", port: 49374, pid: 22877, password: "secret" });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("formats Basic auth header correctly", () => {
    expect(opencodeAuthHeader("secret-pass")).toBe(`Basic ${btoa("opencode:secret-pass")}`);
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
    expect(forms.length).toBe(1);
    expect(forms[0]?.id).toBe("form-1");
  });

  it("handles non-200 responses when listing forms gracefully", async () => {
    const config: OpenCodeServiceConfig = { baseUrl: "http://127.0.0.1:54321", port: 54321, pid: 9999, password: "test-pass" };
    const mockFetch = (async () => new Response("Error", { status: 500 })) as unknown as typeof fetch;

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

  it("cancels forms with DELETE successfully", async () => {
    const config: OpenCodeServiceConfig = { baseUrl: "http://127.0.0.1:54321", port: 54321, pid: 9999, password: "test-pass" };
    let requestedMethod = "";
    let requestedUrl = "";

    const mockFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      requestedUrl = String(url);
      requestedMethod = String(init?.method);
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;

    const result = await cancelOpenCodeForm(config, "ses-123", "form-1", "user cancelled", mockFetch);
    expect(result).toEqual({ ok: true, status: 204 });
    expect(requestedMethod).toBe("DELETE");
    expect(requestedUrl).toBe("http://127.0.0.1:54321/api/session/ses-123/form/form-1?message=user%20cancelled");
  });
});
