import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act, createElement } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";

import type { PaneSessionChoices, PaneSessionSettingsRequest } from "../../shared/protocol.ts";
import { ApiError } from "../lib/api.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { SessionSettings } from "./SessionSettings.tsx";

/** a node for every ref the sheet takes: the renderer draws no DOM */
const node = () => ({ isConnected: true, focus() {}, contains: () => false, querySelectorAll: () => [], getClientRects: () => [], closest: () => null, addEventListener() {}, removeEventListener() {}, getBoundingClientRect: () => ({ height: 400 }), getAnimations: () => [], style: {} });

const choices = (over: Partial<PaneSessionChoices> = {}): PaneSessionChoices => ({
  supported: true,
  agent: "build",
  model: { id: "gpt-5", providerID: "opencode", variant: "high" },
  agents: [
    { id: "build", name: "Build", description: "writes code" },
    { id: "plan", name: "Plan" },
  ],
  models: [
    { id: "gpt-5", providerID: "opencode", name: "GPT-5", variants: ["low", "medium", "high"] },
    { id: "gpt-5-mini", providerID: "opencode", name: "GPT-5 mini", variants: [] },
    { id: "claude-sonnet", providerID: "9router", name: "Claude Sonnet", variants: ["default", "max"] },
  ],
  providers: [{ id: "opencode", name: "OpenCode" }, { id: "9router", name: "9Router" }],
  ...over,
});

describe("the session settings sheet", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let renderer: ReactTestRenderer | undefined;
  let events: EventTarget;
  let requests: PaneSessionSettingsRequest[];
  let closes: number;
  /** what the next switch answers; a thrown one is the refusal the sheet shows */
  let answer: () => Promise<PaneSessionChoices>;

  beforeEach(() => {
    requests = [];
    closes = 0;
    answer = async () => choices();
    for (const key of ["window", "document", "navigator", "localStorage", "sessionStorage", "getComputedStyle", "matchMedia", "HTMLElement", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    events = new EventTarget();
    const store = new Map<string, string>();
    const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); }, removeItem: (key: string) => { store.delete(key); }, key: () => null, length: 0, clear: () => store.clear() };
    const matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    class HTMLElement { isConnected = true; focus(): void {} closest(): null { return null; } }
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: HTMLElement });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en"], userAgent: "Test browser", maxTouchPoints: 0 } });
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
    Object.defineProperty(globalThis, "matchMedia", { configurable: true, value: matchMedia });
    Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: () => "", touchAction: "auto", position: "static", backgroundColor: "rgba(0, 0, 0, 0.5)" }) });
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
      location: { href: "https://app.ovis.example/", search: "", origin: "https://app.ovis.example", pathname: "/" },
      history: { state: null, replaceState() {}, pushState() {}, back() {} },
      localStorage: storage,
      matchMedia,
      innerWidth: 1280,
      setTimeout, clearTimeout,
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
      dispatchEvent: events.dispatchEvent.bind(events),
    } });
    Object.defineProperty(globalThis, "document", { configurable: true, value: {
      documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } },
      activeElement: null,
      // the sheet portals into the body: the renderer needs a container with a node mock for refs
      body: { nodeType: 1, children: [], createNodeMock: node },
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
    } });
  });

  afterEach(async () => {
    await act(async () => { renderer?.unmount(); });
    renderer = undefined;
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    descriptors.clear();
  });

  const view = (over: { choices?: PaneSessionChoices | null; failed?: boolean } = {}) => createElement(SettingsProvider, {
    children: createElement(SessionSettings, {
      paneId: "pane-1",
      choices: over.choices === undefined ? choices() : over.choices,
      failed: over.failed ?? false,
      onSwitch: async (change) => { requests.push(change); return await answer(); },
      onClose: () => { closes += 1; },
    }),
  });
  const mount = async (over: { choices?: PaneSessionChoices | null; failed?: boolean } = {}) => {
    await act(async () => { renderer = create(view(over), { createNodeMock: node }); });
  };
  const text = (instance: ReactTestInstance): string => instance.children.map((child) => typeof child === "string" ? child : text(child)).join("");
  const radios = () => renderer!.root.findAll((instance) => instance.props.role === "radio");
  /** a row's own name: its title, not the description (and the tick) under it; a variant is its text */
  const name = (instance: ReactTestInstance): string => {
    const title = instance.findAll((child) => typeof child.type === "string" && child.props.className === "session-settings-row-title");
    return title.length === 0 ? text(instance) : text(title[0]!);
  };
  const names = (): string[] => radios().map(name);
  const radio = (label: string): ReactTestInstance => {
    const found = radios().filter((instance) => name(instance) === label);
    expect(found.map(name)).toEqual([label]);
    return found[0]!;
  };
  const click = async (label: string) => { await act(async () => { radio(label).props.onClick(); }); };
  const headings = () => renderer!.root.findAll((instance) => typeof instance.type === "string" && instance.type === "h3").map(text);
  const search = () => renderer!.root.find((instance) => instance.type === "input" && instance.props.type === "search");
  const type = async (value: string) => { await act(async () => { search().props.onChange({ target: { value } }); }); };

  it("lists the agents and the models by provider, the current agent and model ticked, and only the running model's variants", async () => {
    await mount();
    expect(renderer!.root.findByProps({ role: "dialog" })).toBeTruthy();
    expect(headings()).toEqual(["Agent", "Model"]);
    // the providers' own order, each heading once
    const groupHeadings = renderer!.root.findAll((instance) => typeof instance.type === "string" && instance.props.className === "menu-heading session-settings-group-heading").map(text);
    expect(groupHeadings).toEqual(["OpenCode", "9Router"]);
    expect(radio("Build").props["aria-checked"]).toBe(true);
    expect(radio("Plan").props["aria-checked"]).toBe(false);
    // the description rides under the agent
    expect(text(renderer!.root.findAll((instance) => instance.props.className === "session-settings-row-note")[0]!)).toBe("writes code");
    expect(radio("GPT-5").props["aria-checked"]).toBe(true);
    expect(radio("GPT-5 mini").props["aria-checked"]).toBe(false);
    // the variants are the running model's, the chosen one ticked
    expect(names().filter((label) => ["low", "medium", "high", "default", "max"].includes(label))).toEqual(["low", "medium", "high"]);
    expect(radio("high").props["aria-checked"]).toBe(true);
    expect(radio("medium").props["aria-checked"]).toBe(false);
  });

  it("switches the agent and the model through the pane, and shows the answer as the selection", async () => {
    await mount();
    answer = async () => choices({ agent: "plan", model: { id: "claude-sonnet", providerID: "9router", variant: "default" } });
    await click("Plan");
    expect(requests).toEqual([{ pane_id: "pane-1", agent: "plan" }]);
    expect(radio("Plan").props["aria-checked"]).toBe(true);
    expect(radio("Claude Sonnet").props["aria-checked"]).toBe(true);
    // the variants follow the running model: the new one's
    expect(names().filter((label) => ["low", "medium", "high", "default", "max"].includes(label))).toEqual(["default", "max"]);
    answer = async () => choices({ model: { id: "gpt-5", providerID: "opencode", variant: "medium" } });
    await click("GPT-5");
    expect(requests.at(-1)).toEqual({ pane_id: "pane-1", model: { id: "gpt-5", providerID: "opencode" } });
    await click("medium");
    expect(requests.at(-1)).toEqual({ pane_id: "pane-1", model: { id: "gpt-5", providerID: "opencode", variant: "medium" } });
    expect(radio("medium").props["aria-checked"]).toBe(true);
  });

  it("searches the models by name or id, counts what is left, and says when nothing matches", async () => {
    await mount();
    expect(text(renderer!.root.findAll((instance) => instance.props.className === "session-settings-count")[0]!)).toBe("3");
    await type("claude");
    expect(names().filter((label) => ["GPT-5", "GPT-5 mini", "Claude Sonnet"].includes(label))).toEqual(["Claude Sonnet"]);
    expect(text(renderer!.root.findAll((instance) => instance.props.className === "session-settings-count")[0]!)).toBe("1");
    // a provider with nothing left keeps no heading
    expect(renderer!.root.findAll((instance) => typeof instance.type === "string" && instance.props.className === "menu-heading session-settings-group-heading").map(text)).toEqual(["9Router"]);
    await type("gpt-5-mini");
    expect(names().filter((label) => ["GPT-5", "GPT-5 mini", "Claude Sonnet"].includes(label))).toEqual(["GPT-5 mini"]);
    await type("nothing like this");
    expect(renderer!.root.findAll((instance) => instance.props.role === "status").map(text)).toContain("No matching models");
    // the agents are not searched: only the models are gone
    expect(names()).toEqual(["Build", "Plan"]);
  });

  it("waits with Loading, says a failed read, and keeps the rows on a refused switch with its own words", async () => {
    await mount({ choices: null });
    expect(renderer!.root.findAll((instance) => instance.props.role === "status").map(text)).toContain("Loading…");
    expect(radios().length).toBe(0);
    await act(async () => { renderer!.update(view({ choices: null, failed: true })); });
    expect(renderer!.root.findAll((instance) => instance.props.role === "alert").map(text)).toContain("Could not read this session's agents and models.");
    // a re-read that failed with the lists already up keeps them: the last answer is still a switch it may make
    await act(async () => { renderer!.update(view({ failed: true })); });
    expect(radio("Build").props["aria-checked"]).toBe(true);
    expect(renderer!.root.findAll((instance) => instance.props.role === "alert").map(text)).not.toContain("Could not read this session's agents and models.");
    await act(async () => { renderer!.update(view()); });
    answer = async () => { throw new ApiError("/api/pane/session-settings", 409, "session_not_running", "session_not_running"); };
    await click("Plan");
    expect(renderer!.root.findAll((instance) => instance.props.className === "session-settings-error").map(text)).toEqual(["session_not_running"]);
    // the refusal keeps what the sheet listed, and the tick where it was
    expect(radio("Build").props["aria-checked"]).toBe(true);
  });

  it("closes on Escape, on the scrim and on the close button", async () => {
    await mount();
    const escape = Object.assign(new Event("keydown", { cancelable: true }), { key: "Escape" });
    await act(async () => { window.dispatchEvent(escape); });
    expect(closes).toBe(1);
    expect(escape.defaultPrevented).toBe(true);
    const scrim = renderer!.root.findAll((instance) => instance.props.className === "modal-scrim")[0]!;
    await act(async () => { scrim.props.onMouseDown({ target: 1, currentTarget: 1 }); });
    expect(closes).toBe(2);
    const close = renderer!.root.findAll((instance) => instance.type === "button" && instance.props.className === "icon-button")[0]!;
    await act(async () => { close.props.onClick(); });
    expect(closes).toBe(3);
  });
});
