/**
 * An OpenCode 2 pane's session settings, against a fake service: the ids a switch names are checked
 * against the lists the service published, since it stores whatever id it is handed (opencode-service
 * .ts), and a pane that is not such a session offers nothing rather than reporting an error.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { boundOpenCodeSession, NO_SESSION_SETTINGS, readPaneSessionChoices, readPaneSessionSettings, switchPaneSession } from "./opencode-settings.ts";
import { forgetOpenCodeChoices, forgetOpenCodeService, type OpenCodeServiceConfig } from "./opencode-service.ts";
import type { HerdrPane } from "../shared/protocol.ts";

const DIRECTORY = "/work/proj";
const SESSION = "ses_fixture";

interface Fake {
  /** requested paths, in order */
  requests: string[];
  /** the bodies a POST carried */
  posted: { path: string; body: unknown }[];
  /** the agent and model the fake session holds now */
  session: { agent: string; model: { id: string; providerID: string; variant?: string } };
  /** false: the service answers 404 for the session, as one that does not hold it does */
  holds: boolean;
}

let root: string;
let service: ReturnType<typeof Bun.serve>;
let fake: Fake;
let stateDir = "";

const agents = [
  { id: "build", name: "Build", mode: "primary", hidden: false },
  { id: "plan", name: "Plan", mode: "primary", hidden: false, description: "Think first" },
];
const models = [
  { id: "claude-opus-5-5", providerID: "opencode", name: "Opus 5.5", variants: [{ id: "high" }, { id: "none" }], settings: { apiKey: "sk-never-shipped" } },
  { id: "gpt-5.6", providerID: "9router", name: "GPT-5.6", variants: [] },
];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ovis-session-settings-"));
  fake = {
    requests: [],
    posted: [],
    session: { agent: "build", model: { id: "claude-opus-5-5", providerID: "opencode", variant: "high" } },
    holds: true,
  };
  const answered = (request: Request): Response | Promise<Response> => {
    const url = new URL(request.url);
    fake.requests.push(`${request.method} ${url.pathname}`);
    if (url.pathname === "/api/info") return Response.json({ pid: process.pid, version: "2.0.32" });
    if (url.pathname.startsWith("/api/session/")) {
      if (request.method === "POST") {
        return request.json().then((body: unknown) => {
          const { agent, model } = body as { agent?: string; model?: { id: string; providerID: string; variant?: string } };
          // the service stores what it is handed: a made-up id included
          if (typeof agent === "string") fake.session.agent = agent;
          if (model) fake.session.model = model;
          fake.posted.push({ path: url.pathname, body });
          return new Response(null, { status: 204 });
        });
      }
      const id = decodeURIComponent(url.pathname.split("/").at(-1)!);
      if (!fake.holds || id !== SESSION) return Response.json({ _tag: "SessionNotFoundError" }, { status: 404 });
      return Response.json({ data: { id, agent: fake.session.agent, model: fake.session.model, location: { directory: DIRECTORY } } });
    }
    const directory = url.searchParams.get("location[directory]");
    const data = url.pathname === "/api/agent" ? agents : url.pathname === "/api/model" ? models : [{ id: "opencode", name: "OpenCode" }, { id: "9router", name: "9Router" }];
    return Response.json({ location: { directory }, data });
  };
  service = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: answered });
  const state = join(root, "state");
  mkdirSync(state, { recursive: true });
  const config: OpenCodeServiceConfig = { baseUrl: service.url.origin, port: service.port ?? 0, pid: process.pid, password: "fixture", version: "2.0.32" };
  Bun.write(join(state, "service.json"), JSON.stringify({ url: config.baseUrl, port: config.port, pid: config.pid, password: config.password, version: config.version }));
  forgetOpenCodeService();
  forgetOpenCodeChoices();
  stateDir = state;
});

afterEach(() => {
  service.stop(true);
  forgetOpenCodeService();
  forgetOpenCodeChoices();
  rmSync(root, { recursive: true, force: true });
});

const opencodePane = (session: string | null = SESSION): Pick<HerdrPane, "agent" | "agent_session"> => ({
  agent: "opencode",
  agent_session: session === null ? null : { agent: "opencode", source: "herdr:opencode", kind: "id", value: session },
});

describe("a pane that is not an OpenCode 2 session", () => {
  it("offers no control rather than an error", async () => {
    // no session id recorded yet (a pane before its first turn)
    expect(await readPaneSessionSettings(opencodePane(null), stateDir)).toEqual(NO_SESSION_SETTINGS);
    // a session the service does not hold
    fake.holds = false;
    expect(await readPaneSessionSettings(opencodePane(), stateDir)).toEqual(NO_SESSION_SETTINGS);
    expect(await readPaneSessionChoices(opencodePane(), stateDir)).toMatchObject({ supported: false, agents: [], models: [] });
    // another agent's pane names no session id at all
    expect(await readPaneSessionSettings({ agent: "claude", agent_session: null }, stateDir)).toEqual(NO_SESSION_SETTINGS);
  });

  it("binds a session the service holds, with the folder it names", async () => {
    fake.holds = false;
    expect(await boundOpenCodeSession(opencodePane(), stateDir)).toBeNull();
    fake.holds = true;
    expect(await boundOpenCodeSession(opencodePane(), stateDir)).toMatchObject({ sessionID: SESSION, directory: DIRECTORY });
  });
});

describe("what the session runs now", () => {
  it("answers its agent and model, and the switches on request", async () => {
    expect(await readPaneSessionSettings(opencodePane(), stateDir)).toEqual({
      supported: true,
      agent: "build",
      model: { id: "claude-opus-5-5", providerID: "opencode", variant: "high" },
    });
    // the small probe asks the session alone: no model list is read to draw a chat
    expect(fake.requests.filter((path) => path.endsWith("/api/model"))).toEqual([]);
    const choices = await readPaneSessionChoices(opencodePane(), stateDir);
    expect(choices).toMatchObject({
      supported: true,
      agents: [{ id: "build", name: "Build" }, { id: "plan", name: "Plan", description: "Think first" }],
      models: [{ id: "claude-opus-5-5", providerID: "opencode", name: "Opus 5.5", variants: ["high", "none"] }, { id: "gpt-5.6", providerID: "9router", name: "GPT-5.6", variants: [] }],
    });
    // a provider's key is never part of the answer
    expect(JSON.stringify(choices)).not.toContain("sk-never-shipped");
  });
});

describe("a switch", () => {
  it("writes an agent the service lists and answers what it left behind", async () => {
    const switched = await switchPaneSession(opencodePane(), { agent: "plan" }, stateDir);
    expect(switched).toMatchObject({ ok: true, settings: { supported: true, agent: "plan" } });
    expect(fake.posted).toEqual([{ path: `/api/session/${SESSION}/agent`, body: { agent: "plan" } }]);
  });

  it("refuses an agent the service does not list, before it is written", async () => {
    // the service accepts any id silently: an unchecked one would be stored and read back as the agent
    expect(await switchPaneSession(opencodePane(), { agent: "nope-nope" }, stateDir)).toMatchObject({ ok: false, code: "invalid_agent" });
    expect(fake.posted).toEqual([]);
  });

  it("writes a model and variant the service lists", async () => {
    const switched = await switchPaneSession(opencodePane(), { model: { id: "claude-opus-5-5", providerID: "opencode", variant: "low" } }, stateDir);
    // "low" is not one of that model's variants
    expect(switched).toMatchObject({ ok: false, code: "invalid_model" });
    expect(fake.posted).toEqual([]);
    expect(await switchPaneSession(opencodePane(), { model: { id: "claude-opus-5-5", providerID: "opencode", variant: "none" } }, stateDir))
      .toMatchObject({ ok: true, settings: { model: { id: "claude-opus-5-5", providerID: "opencode", variant: "none" } } });
    // a model with no variants takes none
    expect(await switchPaneSession(opencodePane(), { model: { id: "gpt-5.6", providerID: "9router", variant: "high" } }, stateDir))
      .toMatchObject({ ok: false, code: "invalid_model" });
    expect(fake.posted.at(-1)).toEqual({ path: `/api/session/${SESSION}/model`, body: { model: { id: "claude-opus-5-5", providerID: "opencode", variant: "none" } } });
  });

  it("refuses a model the service does not list, or one under another provider", async () => {
    expect(await switchPaneSession(opencodePane(), { model: { id: "made-up", providerID: "opencode" } }, stateDir)).toMatchObject({ ok: false, code: "invalid_model" });
    // the id is right, the provider is not: the pair is what identifies a model
    expect(await switchPaneSession(opencodePane(), { model: { id: "gpt-5.6", providerID: "opencode" } }, stateDir)).toMatchObject({ ok: false, code: "invalid_model" });
    expect(fake.posted).toEqual([]);
  });

  it("says the session is not running when the service stops holding it", async () => {
    fake.holds = false;
    expect(await switchPaneSession(opencodePane(), { agent: "plan" }, stateDir)).toMatchObject({ ok: false, code: "session_not_running" });
    expect(fake.posted).toEqual([]);
  });
});
