import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { act, createElement } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";

import type { PaneSessionChoices, PaneSessionSettings, PaneSessionSettingsRequest } from "../../shared/protocol.ts";
import * as api from "./api.ts";

import type { SessionSettingsState } from "./useSessionSettings.ts";

/** what the pane's PC answered, and every request that asked it */
let probe: PaneSessionSettings | Error;
let lists: PaneSessionChoices | Error;
let switched: PaneSessionChoices | Error;
const asked = { probes: [] as string[], lists: [] as string[], switches: [] as PaneSessionSettingsRequest[] };
await mock.module("./api.ts", () => ({
  ...api,
  fetchPaneSessionSettings: async (pane: string) => { asked.probes.push(pane); if (probe instanceof Error) throw probe; return probe; },
  fetchPaneSessionChoices: async (pane: string) => { asked.lists.push(pane); if (lists instanceof Error) throw lists; return lists; },
  switchPaneSession: async (change: PaneSessionSettingsRequest) => { asked.switches.push(change); if (switched instanceof Error) throw switched; return switched; },
}));
const { useSessionSettings } = await import("./useSessionSettings.ts");
const { MachineContext } = await import("./machineContext.tsx");

const SETTINGS: PaneSessionSettings = { supported: true, agent: "build", model: { id: "gpt-5", providerID: "opencode", variant: "high" } };
const CHOICES: PaneSessionChoices = {
  ...SETTINGS,
  agents: [{ id: "build", name: "Build" }, { id: "plan", name: "Plan" }],
  models: [{ id: "gpt-5", providerID: "opencode", name: "GPT-5", variants: ["low", "high"] }],
  providers: [{ id: "opencode", name: "OpenCode" }],
};

/** the hook's answer, drawn as the component would: the sheet and the pill are its two readers */
function Reader({ shown }: { shown: (state: SessionSettingsState) => void }) {
  shown(useSessionSettings("pane-1", true, null));
  return null;
}

describe("useSessionSettings", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let renderer: ReactTestRenderer | undefined;
  let state: SessionSettingsState | null;

  beforeEach(() => {
    asked.probes = [];
    asked.lists = [];
    asked.switches = [];
    state = null;
    probe = SETTINGS;
    lists = CHOICES;
    switched = CHOICES;
    for (const key of ["window", "document", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    // the probe's abort controller is the only DOM it touches
    Object.defineProperty(globalThis, "window", { configurable: true, value: { addEventListener() {}, removeEventListener() {}, matchMedia: () => null } });
    Object.defineProperty(globalThis, "document", { configurable: true, value: { addEventListener() {}, removeEventListener() {}, querySelectorAll: () => [], activeElement: null } });
  });

  afterEach(async () => { await act(async () => { renderer?.unmount(); }); renderer = undefined; });

  const mount = async () => {
    await act(async () => {
      renderer = create(createElement(MachineContext.Provider, { value: "local", children: createElement(Reader, { shown: (next) => { state = next; } }) }));
    });
    return () => state!;
  };

  it("probes what the session runs, and reads the lists only when the sheet opens", async () => {
    const shown = await mount();
    expect(asked.probes).toEqual(["pane-1"]);
    expect(asked.lists).toEqual([]);
    expect(shown()).toMatchObject({ supported: true, agent: "build", model: SETTINGS.model, choices: null, failed: false, open: false });
    await act(async () => { shown().openSheet(); });
    expect(asked.lists).toEqual(["pane-1"]);
    expect(shown()).toMatchObject({ open: true, choices: CHOICES, agent: "build" });
  });

  it("offers no control when the pane is not such a session, or the PC cannot say", async () => {
    probe = { supported: false, agent: null, model: null };
    let shown = await mount();
    expect(shown()).toMatchObject({ supported: false, agent: null, model: null });
    await act(async () => { renderer!.unmount(); });
    probe = new Error("the PC is unreachable");
    shown = await mount();
    expect(shown()).toMatchObject({ supported: false, agent: null, model: null });
  });

  it("says the read failed, and keeps the lists a switch answered with", async () => {
    lists = new Error("no service");
    const shown = await mount();
    await act(async () => { shown().openSheet(); });
    expect(shown()).toMatchObject({ open: true, choices: null, failed: true });
    // a switch answers with the choices as it left them, so the sheet lists them even after a failed read
    lists = CHOICES;
    await act(async () => { await shown().switchTo({ pane_id: "pane-1", agent: "plan" }); });
    expect(shown()).toMatchObject({ choices: CHOICES, agent: "build" });
  });

  it("draws the switch's answer at once: the pill names the new agent before the chat reads again", async () => {
    const shown = await mount();
    await act(async () => { shown().openSheet(); });
    switched = { ...CHOICES, agent: "plan", model: { id: "gpt-5", providerID: "opencode", variant: "low" } };
    await act(async () => { await shown().switchTo({ pane_id: "pane-1", agent: "plan" }); });
    expect(asked.switches).toEqual([{ pane_id: "pane-1", agent: "plan" }]);
    expect(shown()).toMatchObject({ agent: "plan", model: { id: "gpt-5", providerID: "opencode", variant: "low" } });
  });

  it("reads the lists again on every open, so a switch made in the terminal is in them", async () => {
    const shown = await mount();
    await act(async () => { shown().openSheet(); });
    await act(async () => { shown().closeSheet(); });
    lists = { ...CHOICES, agent: "plan" };
    await act(async () => { shown().openSheet(); });
    expect(asked.lists).toEqual(["pane-1", "pane-1"]);
    expect(shown()).toMatchObject({ open: true, choices: { agent: "plan" } });
  });
});
