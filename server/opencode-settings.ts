/**
 * An OpenCode 2 pane's session settings: what it runs now (its agent and its model) and, on request,
 * what its own dialog may switch to. OpenCode's service is the one place those live — its TUI is a
 * client of it too, so a switch made here is written where every TUI reads it, and no keystroke is
 * typed into a pane.
 *
 * A pane that is not such a session (OpenCode 1, `--standalone`, no service, a session another
 * service holds) answers `supported: false` rather than an error: there is nothing to switch, and
 * the chat hides the control instead of reporting one.
 */
import type { HerdrPane, PaneSessionChoices, PaneSessionSettings } from "../shared/protocol.ts";
import { opencodeSessionId } from "./opencode.ts";
import {
  listOpenCodeChoices,
  openCodeService,
  readOpenCodeSelection,
  switchOpenCodeAgent,
  switchOpenCodeModel,
  type OpenCodeService,
} from "./opencode-service.ts";

/** Nothing to offer: a pane that is not an OpenCode 2 session on a service that holds it. */
export const NO_SESSION_SETTINGS: PaneSessionSettings = { supported: false, agent: null, model: null };

/** The same, with no switches either: nothing to list for a session that is not there. */
const NO_SESSION_CHOICES: PaneSessionChoices = { ...NO_SESSION_SETTINGS, agents: [], models: [], providers: [] };

export interface BoundOpenCode { service: OpenCodeService; sessionID: string; directory: string }

/**
 * The verified service this pane's own session lives in, or null. The same checks the native reader
 * makes (a session id herdr recorded, a service answering at service.json, version 2, a session it
 * holds), but nothing is registered: a settings read is not a chat, and the pane's event stream is
 * the conversation's business.
 */
export async function boundOpenCodeSession(pane: Pick<HerdrPane, "agent" | "agent_session">, stateDir?: string, signal?: AbortSignal): Promise<BoundOpenCode | null> {
  const sessionID = opencodeSessionId(pane);
  if (sessionID === null) return null;
  const service = await openCodeService(stateDir, signal);
  if (service === null) return null;
  // only OpenCode 2 has this service and these routes; a 1.x service.json names no version worth asking
  if (!(Number(/^(\d+)\./u.exec(service.version)?.[1] ?? 0) >= 2)) return null;
  const selection = await readOpenCodeSelection(service.config, sessionID, signal);
  // a session the service does not hold, or one whose folder it will not name: no lists to ask it for
  if (selection === null || selection.directory === null) return null;
  return { service, sessionID, directory: selection.directory };
}

/** What the pane's session runs now, and whether it may be switched at all. */
export async function readPaneSessionSettings(pane: Pick<HerdrPane, "agent" | "agent_session">, stateDir?: string, signal?: AbortSignal): Promise<PaneSessionSettings> {
  const bound = await boundOpenCodeSession(pane, stateDir, signal);
  if (bound === null) return NO_SESSION_SETTINGS;
  const selection = await readOpenCodeSelection(bound.service.config, bound.sessionID, signal);
  if (selection === null) return NO_SESSION_SETTINGS;
  return { supported: true, agent: selection.agent, model: selection.model };
}

/**
 * The settings and the switches to offer. The model list is 240 entries of a service's own
 * configuration: a chat asks for this when its sheet opens, never on every pane it draws.
 */
export async function readPaneSessionChoices(pane: Pick<HerdrPane, "agent" | "agent_session">, stateDir?: string, signal?: AbortSignal): Promise<PaneSessionChoices> {
  const bound = await boundOpenCodeSession(pane, stateDir, signal);
  if (bound === null) return NO_SESSION_CHOICES;
  const [selection, choices] = await Promise.all([
    readOpenCodeSelection(bound.service.config, bound.sessionID, signal),
    listOpenCodeChoices(bound.service.config, bound.directory, signal),
  ]);
  if (selection === null || choices === null) return NO_SESSION_CHOICES;
  return { supported: true, agent: selection.agent, model: selection.model, ...choices };
}

export type SessionSwitch =
  | { ok: true; settings: PaneSessionChoices }
  | { ok: false; code: "session_not_running" | "invalid_agent" | "invalid_model" | "switch_failed"; message: string };

/**
 * One switch, checked against the service's own lists before it is asked: the service stores any id it
 * is handed, a made-up one included, so an unchecked id would be written into the session's store and
 * read back as its agent.
 */
export async function switchPaneSession(
  pane: Pick<HerdrPane, "agent" | "agent_session">,
  change: { agent: string } | { model: { id: string; providerID: string; variant?: string } },
  stateDir?: string,
  signal?: AbortSignal,
): Promise<SessionSwitch> {
  const bound = await boundOpenCodeSession(pane, stateDir, signal);
  if (bound === null) return { ok: false, code: "session_not_running", message: "this pane's OpenCode session is not running on a service now" };
  const choices = await listOpenCodeChoices(bound.service.config, bound.directory, signal);
  if (choices === null) return { ok: false, code: "switch_failed", message: "the OpenCode service listed no agents or models" };
  if ("agent" in change) {
    if (!choices.agents.some((agent) => agent.id === change.agent)) {
      return { ok: false, code: "invalid_agent", message: `"${change.agent}" is not an agent this session may run` };
    }
    const switched = await switchOpenCodeAgent(bound.service.config, bound.sessionID, change.agent, signal);
    if (!switched.ok) return { ok: false, code: "switch_failed", message: `the OpenCode service answered ${switched.status || "nothing"}` };
  } else {
    const model = choices.models.find((choice) => choice.id === change.model.id && choice.providerID === change.model.providerID);
    if (!model) return { ok: false, code: "invalid_model", message: "that model is not one this session may run" };
    // a variant the model does not take is the model's own, not an effort anyone chose
    if (change.model.variant !== undefined && !model.variants.includes(change.model.variant)) {
      return { ok: false, code: "invalid_model", message: `"${model.name}" takes no "${change.model.variant}" variant` };
    }
    const switched = await switchOpenCodeModel(bound.service.config, bound.sessionID, change.model, signal);
    if (!switched.ok) return { ok: false, code: "switch_failed", message: `the OpenCode service answered ${switched.status || "nothing"}` };
  }
  return { ok: true, settings: await readPaneSessionChoices(pane, stateDir, signal) };
}
