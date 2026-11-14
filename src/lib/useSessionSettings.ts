/**
 * An OpenCode 2 pane's session settings, for the composer's pill: what it runs now, and — once the
 * sheet opens — what it may switch to. The probe is a small answer asked when the pane mounts and
 * whenever the chat's own read of the session changes, so a chat knows whether to offer the control
 * without reading the service's whole model list; the list is read when the sheet opens
 * (server/opencode-settings.ts, `choices=1`).
 *
 * The answer a switch comes back with is kept here until the chat's own conversation read catches up,
 * so the pill names the new agent on the same frame as the press.
 */
import { useCallback, useEffect, useState } from "react";
import type { PaneSessionChoices, PaneSessionSettings, PaneSessionSettingsRequest } from "../../shared/protocol.ts";
import { useMachineApi } from "./machineContext.tsx";

export interface SessionSettingsState {
  /** answered by the pane's PC: a pane that is not OpenCode 2 (or a PC that cannot say) offers nothing */
  supported: boolean;
  /** the agent the session runs: the chat's own read, else the service's answer */
  agent: string | null;
  /** the model and variant it runs, with the provider a switch needs */
  model: PaneSessionSettings["model"];
  /** the switches to offer, once the sheet opened and they were read; null before that */
  choices: PaneSessionChoices | null;
  /** reading the choices failed: the sheet says so instead of listing nothing */
  failed: boolean;
  open: boolean;
  openSheet: () => void;
  closeSheet: () => void;
  switchTo: (change: PaneSessionSettingsRequest) => Promise<PaneSessionChoices>;
}

/** One probe's answer, kept with the read that asked for it: a later read drops the earlier answer. */
interface Probe { supported: boolean; agent: string | null; model: PaneSessionSettings["model"] }

/**
 * `enabled` gates every request: a pane another agent runs, a device that only watches, and a chat
 * whose session is not drawn yet ask nothing. `read` is the chat's own read of the session (its
 * `ConversationMetadata`): it names the agent the terminal switched to as well, and its changes are
 * what make the probe ask again.
 */
export function useSessionSettings(paneId: string, enabled: boolean, read: { agent?: string | null; model?: string | null; reasoning_effort?: string | null } | null): SessionSettingsState {
  const { fetchPaneSessionSettings, fetchPaneSessionChoices, switchPaneSession } = useMachineApi();
  const [probe, setProbe] = useState<Probe | null>(null);
  const [switched, setSwitched] = useState<PaneSessionChoices | null>(null);
  const [choices, setChoices] = useState<PaneSessionChoices | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  // the read the chat made, whose changes mean the session's store moved under us (a terminal switch)
  const signature = `${read?.agent ?? ""}\0${read?.model ?? ""}\0${read?.reasoning_effort ?? ""}`;
  useEffect(() => setSwitched(null), [signature]);

  useEffect(() => {
    if (!enabled) { setProbe(null); return; }
    const controller = new AbortController();
    void fetchPaneSessionSettings(paneId, controller.signal).then(
      (answer) => { if (!controller.signal.aborted) setProbe(answer); },
      // a PC that cannot answer offers no control: the pill stays as it was
      () => { if (!controller.signal.aborted) setProbe({ supported: false, agent: null, model: null }); },
    );
    return () => controller.abort();
  }, [enabled, fetchPaneSessionSettings, paneId, signature]);

  const openSheet = useCallback(() => {
    setOpen(true);
    setFailed(false);
    // read again on every open: a switch the terminal made since is in these lists too, and the PC holds
    // the service's answers for 30 s, so an open right after the last costs nothing. The sheet keeps the
    // lists it has while they load, and a failed re-read leaves them (only a sheet with none says so)
    void fetchPaneSessionChoices(paneId).then(
      (answer) => { setChoices(answer); setSwitched(answer); },
      () => setFailed(true),
    );
  }, [fetchPaneSessionChoices, paneId]);
  const closeSheet = useCallback(() => setOpen(false), []);

  const switchTo = useCallback(async (change: PaneSessionSettingsRequest): Promise<PaneSessionChoices> => {
    const answer = await switchPaneSession(change);
    setChoices(answer);
    setSwitched(answer);
    setProbe({ supported: answer.supported, agent: answer.agent, model: answer.model });
    return answer;
  }, [switchPaneSession]);

  return {
    supported: probe?.supported === true || switched !== null,
    // the chat's own read names the agent first: it is the session's store, and it carries a switch the
    // terminal made while the sheet was closed
    agent: read?.agent ?? switched?.agent ?? probe?.agent ?? null,
    model: switched?.model ?? probe?.model ?? null,
    choices: choices ?? switched,
    failed,
    open,
    openSheet,
    closeSheet,
    switchTo,
  };
}
