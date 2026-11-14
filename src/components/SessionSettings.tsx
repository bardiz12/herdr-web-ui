/**
 * An OpenCode 2 session's agent and its model, as its own `/agents` and `/models` dialogs offer them:
 * one sheet, the agent first (its mode decides what the model does), then the models grouped by
 * provider, with the reasoning variants each takes under the one it runs.
 *
 * Every switch goes to the OpenCode service the session belongs to (`POST /api/pane/session-settings`),
 * never into the pane's keyboard: the TUI is a client of that service too, so it redraws its own
 * footer from the same change, and a keystroke that reached the dialog instead could leave the two
 * saying different things (#2596's lesson).
 *
 * The choices are read when the sheet opens, not when the chat draws: 240 models of the user's own
 * configuration weigh more than a pane's first paint (server/opencode-settings.ts).
 */
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, Search, X } from "lucide-react";

import "./SessionSettings.css";

import type { PaneModelChoice, PaneSessionChoices, PaneSessionSettingsRequest } from "../../shared/protocol.ts";
import { ApiError } from "../lib/api.ts";
import { useT } from "../lib/i18n.ts";
import { nativeModalOver, useFocusTrap } from "../lib/useFocusTrap.ts";
import { usePhoneSheetBack } from "../lib/sheetHistory.ts";
import { useSheetSwipe } from "../lib/sheets.ts";

interface Props {
  paneId: string;
  /** what the session runs now, and the switches it offers, as the chat last read them; null while they load */
  choices: PaneSessionChoices | null;
  /** reading them failed: the sheet says so where it would have listed them */
  failed: boolean;
  /** the switch, as the pane's API takes it; resolves with the settings and the choices it left behind */
  onSwitch: (change: PaneSessionSettingsRequest) => Promise<PaneSessionChoices>;
  onClose: () => void;
}

export function SessionSettings({ paneId, choices, failed, onSwitch, onClose }: Props) {
  const t = useT();
  const id = useId();
  const surface = useFocusTrap<HTMLDivElement>(true);
  useSheetSwipe(surface, onClose);
  usePhoneSheetBack(onClose);
  const search = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // the last answer, so a switch shows at once where the chat's own read has not caught up yet
  const [shown, setShown] = useState<PaneSessionChoices | null>(choices);
  useEffect(() => setShown(choices), [choices]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      // a native modal over it (Add PC, from the palette) takes its own Escape
      if (event.key !== "Escape" || nativeModalOver(surface.current)) return;
      event.stopPropagation();
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  // a phone's keyboard would cover the list it searches; a desktop's search is ready to type in
  useEffect(() => {
    if (shown !== null && window.matchMedia?.("(pointer: coarse)").matches !== true) search.current?.focus();
  }, [shown !== null]);

  const needle = query.trim().toLocaleLowerCase();
  const matching = useMemo(() => (shown?.models ?? []).filter((model) => needle === ""
    || model.name.toLocaleLowerCase().includes(needle)
    || model.id.toLocaleLowerCase().includes(needle)), [needle, shown?.models]);
  // the providers' own order (the service's), each with what the search left of its models
  const groups = useMemo(() => (shown?.providers ?? []).flatMap((provider) => {
    const models = matching.filter((model) => model.providerID === provider.id);
    return models.length === 0 ? [] : [{ id: provider.id, name: provider.name, models }];
  }), [matching, shown?.providers]);
  // a provider the service lists no name for (another bridge's answer) keeps its id as the heading
  const orphans = useMemo(() => {
    const known = new Set((shown?.providers ?? []).map((provider) => provider.id));
    const models = matching.filter((model) => !known.has(model.providerID));
    return models.length === 0 ? [] : [{ id: "", name: "", models }];
  }, [matching, shown?.providers]);
  const sections = [...groups, ...orphans];

  const currentModel = shown?.model ?? null;
  const isCurrentModel = (model: PaneModelChoice): boolean => currentModel !== null
    && currentModel.id === model.id && currentModel.providerID === model.providerID;

  const run = async (key: string, change: PaneSessionSettingsRequest): Promise<void> => {
    if (pending !== null) return;
    setPending(key);
    setError(null);
    try {
      setShown(await onSwitch(change));
    } catch (reason: unknown) {
      setError(reason instanceof ApiError ? reason.detail : t("Could not switch."));
    } finally {
      setPending(null);
    }
  };

  // nothing to list yet: a refusal says so where the agents and models would be, and a switch's own
  // refusal keeps the row it belongs to (further down) rather than replacing the sheet with a message.
  // Lists already read stay up under a failed re-read: the sheet's last answer is still what it may switch
  const body = failed && shown === null
    ? <p className="session-settings-empty" role="alert">{t("Could not read this session's agents and models.")}</p>
    : shown === null
      ? <p className="session-settings-empty" role="status">{t("Loading…")}</p>
      : <>

      <section className="session-settings-section" aria-labelledby={`${id}-agent`}>
        <h3 className="session-settings-heading" id={`${id}-agent`}>{t("Agent")}</h3>
        <div className="session-settings-list" role="radiogroup" aria-labelledby={`${id}-agent`}>
          {shown.agents.map((agent) => {
            const checked = shown.agent === agent.id;
            const busy = pending === `agent:${agent.id}`;
            return <button
              key={agent.id}
              type="button"
              role="radio"
              className={`session-settings-row${checked ? " is-current" : ""}`}
              aria-checked={checked}
              aria-busy={busy || undefined}
              disabled={pending !== null}
              onClick={() => void run(`agent:${agent.id}`, { pane_id: paneId, agent: agent.id })}
            >
              <span className="session-settings-row-main">
                <span className="session-settings-row-title">{agent.name}</span>
                {agent.description && <span className="session-settings-row-note">{agent.description}</span>}
              </span>
              {checked && <Check className="session-settings-check" aria-hidden="true" />}
            </button>;
          })}
        </div>
      </section>

      <section className="session-settings-section" aria-labelledby={`${id}-model`}>
        <div className="session-settings-model-head">
          <h3 className="session-settings-heading" id={`${id}-model`}>{t("Model")}</h3>
          <span className="session-settings-count">{matching.length}</span>
        </div>
        <div className="session-settings-search">
          <Search aria-hidden="true" />
          <input
            ref={search}
            className="input"
            type="search"
            value={query}
            aria-label={t("Search models")}
            placeholder={t("Search models")}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        {sections.length === 0 ? <p className="session-settings-empty" role="status">{t("No matching models")}</p> : (
          <div className="session-settings-list" role="radiogroup" aria-labelledby={`${id}-model`}>
            {sections.map((section) => <div key={section.id || "other"} className="session-settings-group">
              {section.name !== "" && <div className="menu-heading session-settings-group-heading">{section.name}</div>}
              {section.models.map((model) => {
                const checked = isCurrentModel(model);
                const busy = pending === `model:${model.providerID}/${model.id}`;
                return <div key={`${model.providerID}/${model.id}`} className="session-settings-item">
                  <button
                    type="button"
                    role="radio"
                    className={`session-settings-row${checked ? " is-current" : ""}`}
                    aria-checked={checked}
                    aria-busy={busy || undefined}
                    disabled={pending !== null}
                    title={model.id}
                    onClick={() => void run(`model:${model.providerID}/${model.id}`, {
                      pane_id: paneId, model: { id: model.id, providerID: model.providerID },
                    })}
                  >
                    <span className="session-settings-row-main">
                      <span className="session-settings-row-title">{model.name}</span>
                    </span>
                    {checked && <Check className="session-settings-check" aria-hidden="true" />}
                  </button>
                  {/* the variants of the model the session runs, under it: an effort belongs to a model, so it
                      is offered once that model is the one running */}
                  {checked && model.variants.length > 0 && <div className="session-settings-variants" role="radiogroup" aria-label={t("Effort")}>
                    {model.variants.map((variant) => {
                      const chosen = currentModel?.variant === variant;
                      return <button
                        key={variant}
                        type="button"
                        role="radio"
                        className={`session-settings-variant${chosen ? " is-current" : ""}`}
                        aria-checked={chosen}
                        disabled={pending !== null}
                        onClick={() => void run(`model:${model.providerID}/${model.id}:${variant}`, {
                          pane_id: paneId, model: { id: model.id, providerID: model.providerID, variant },
                        })}
                      >{variant}</button>;
                    })}
                  </div>}
                </div>;
              })}
            </div>)}
          </div>
        )}
      </section>
      </>;

  return createPortal(
    <div className="modal-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget && pending === null) onClose(); }}>
      <div ref={surface} className="modal session-settings" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} tabIndex={-1}>
        <header className="modal-header">
          <h2 className="modal-title" id={`${id}-title`}>{t("Session settings")}</h2>
          <button type="button" className="icon-button" aria-label={t("Close")} title={t("Close")} onClick={onClose}><X aria-hidden="true" /></button>
        </header>
        <div className="modal-body session-settings-body">
          {body}
          <p className="session-settings-error" role="alert">{error}</p>
        </div>
      </div>
    </div>,
    document.body,
  );
}
