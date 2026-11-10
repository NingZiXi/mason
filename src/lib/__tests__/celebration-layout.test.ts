import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findCelebrationSurface, findCelebrationTarget } from "../celebration-layout";

class StubElement {
  parentElement: StubElement | null;
  inert = false;
  disabled = false;
  attributes = new Map<string, string>();
  style = { display: "block", visibility: "visible", opacity: "1", overflow: "visible", overflowX: "", overflowY: "" };
  scrollIntoView = vi.fn();
  focus = vi.fn();
  click = vi.fn();
  setAttribute = vi.fn();
  constructor(public box: [number, number, number, number], parent: StubElement | null = null) { this.parentElement = parent; }
  getBoundingClientRect() {
    const [left, top, width, height] = this.box;
    return { left, top, width, height, right: left + width, bottom: top + height };
  }
  hasAttribute(name: string) { return this.attributes.has(name); }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
}

let html: StubElement, body: StubElement;
let matches: Map<string, StubElement[]>;
const dom = (element: StubElement) => element as unknown as HTMLElement;

beforeEach(() => {
  matches = new Map();
  html = new StubElement([0, 0, 0, 0]);
  body = new StubElement([0, 0, 0, 0], html);
  vi.stubGlobal("HTMLElement", StubElement);
  vi.stubGlobal("window", { innerWidth: 800, innerHeight: 600 });
  vi.stubGlobal("document", { body, documentElement: html, querySelectorAll: (selector: string) => matches.get(selector) ?? [] });
  vi.stubGlobal("getComputedStyle", (element: StubElement) => element.style);
});
afterEach(() => vi.unstubAllGlobals());

describe("celebration target layout", () => {
  it("uses selector priority and skips used elements before falling back", () => {
    const first = new StubElement([20, 30, 40, 20], body);
    const second = new StubElement([100, 80, 60, 40], body);
    matches.set(".primary", [first, second]);
    matches.set(".fallback", [new StubElement([500, 400, 40, 30], body)]);
    expect(findCelebrationTarget([".missing", ".primary", ".fallback"], new Set([dom(first)])))
      .toEqual({ element: second, point: { x: 130, y: 100 } });
    expect(findCelebrationTarget([".primary", ".fallback"], new Set([dom(first), dom(second)]))?.point)
      .toEqual({ x: 520, y: 415 });
    expect(findCelebrationTarget([".missing"])).toBeNull();
  });

  it.each(["display", "visibility", "opacity", "inert", "inert-attribute", "aria-hidden"])("rejects a target inside a %s ancestor", kind => {
    const sidebar = new StubElement([0, 0, 250, 600], body);
    const target = new StubElement([30, 100, 80, 40], sidebar);
    if (kind === "display") sidebar.style.display = "none";
    if (kind === "visibility") sidebar.style.visibility = "hidden";
    if (kind === "opacity") sidebar.style.opacity = "0";
    if (kind === "inert") sidebar.inert = true;
    if (kind === "inert-attribute") sidebar.attributes.set("inert", "");
    if (kind === "aria-hidden") sidebar.attributes.set("aria-hidden", "true");
    matches.set(".target", [target]);
    expect(findCelebrationTarget([".target"])).toBeNull();
  });

  it("rejects an offscreen collapsed sidebar and a hidden target itself", () => {
    const sidebar = new StubElement([-250, 0, 250, 600], body);
    const target = new StubElement([-220, 100, 80, 40], sidebar);
    matches.set(".target", [target]);
    expect(findCelebrationTarget([".target"])).toBeNull();
    target.box = [30, 100, 80, 40];
    target.style.visibility = "hidden";
    expect(findCelebrationTarget([".target"])).toBeNull();
  });

  it.each(["hidden", "clip", "scroll", "auto"])("rejects a mostly %s-clipped target without scrolling", overflow => {
    const panel = new StubElement([20, 20, 200, 120], body);
    panel.style.overflowY = overflow;
    const target = new StubElement([40, 130, 80, 40], panel);
    matches.set(".target", [target]);
    expect(findCelebrationTarget([".target"])).toBeNull();
    expect(panel.scrollIntoView).not.toHaveBeenCalled();
    expect(target.scrollIntoView).not.toHaveBeenCalled();
  });

  it("intersects clipping ancestors by axis and returns the visible centre at the 80% boundary", () => {
    const horizontal = new StubElement([0, 0, 120, 1], body);
    horizontal.style.overflowX = "hidden";
    const vertical = new StubElement([0, 0, 1, 180], horizontal);
    vertical.style.overflowY = "auto";
    const target = new StubElement([40, 20, 100, 160], vertical);
    matches.set(".target", [target]);
    expect(findCelebrationTarget([".target"]))
      .toEqual({ element: target, point: { x: 80, y: 100 } });
    horizontal.box[2] = 119;
    expect(findCelebrationTarget([".target"])).toBeNull();
  });

  it("clips to the viewport while ignoring root overflow boxes", () => {
    html.style.overflow = "hidden";
    body.style.overflowY = "auto";
    const target = new StubElement([720, 550, 100, 50], body);
    matches.set(".target", [target]);
    expect(findCelebrationTarget([".target"]))
      .toEqual({ element: target, point: { x: 760, y: 575 } });
    target.box[0] = 721;
    expect(findCelebrationTarget([".target"])).toBeNull();
    target.box = [40, -8, 80, 40];
    expect(findCelebrationTarget([".target"])?.point).toEqual({ x: 80, y: 16 });
  });

  it("allows a disabled decoration target but never activates, focuses or mutates it", () => {
    const target = new StubElement([40, 20, 12, 12], body);
    target.disabled = true;
    matches.set(".target", [target]);
    expect(findCelebrationTarget([".target"]))
      .toEqual({ element: target, point: { x: 46, y: 26 } });
    for (const spy of [target.focus, target.click, target.setAttribute, target.scrollIntoView]) expect(spy).not.toHaveBeenCalled();
    target.box[2] = 11;
    expect(findCelebrationTarget([".target"])).toBeNull();
    target.box = [40, 20, 20, 0];
    expect(findCelebrationTarget([".target"])).toBeNull();
  });

  it("rejects an unavailable or invalid viewport", () => {
    matches.set(".target", [new StubElement([40, 20, 50, 20], body)]);
    vi.stubGlobal("window", { innerWidth: 0, innerHeight: 600 });
    expect(findCelebrationTarget([".target"])).toBeNull();
    vi.stubGlobal("window", { innerWidth: Infinity, innerHeight: 600 });
    expect(findCelebrationTarget([".target"])).toBeNull();
  });
});

describe("celebration surface layout", () => {
  it("returns the viewport-clipped area of a tall panel rejected as a control target", () => {
    const panel = new StubElement([20, -500, 280, 1500], body);
    matches.set(".panel", [panel]);
    expect(findCelebrationTarget([".panel"])).toBeNull();
    expect(findCelebrationSurface([".panel"]))
      .toEqual({ element: panel, rect: { left: 20, top: 0, width: 280, height: 600 } });
  });

  it("intersects each clipping ancestor along its own axis", () => {
    const horizontal = new StubElement([40, 0, 220, 1], body);
    horizontal.style.overflowX = "clip";
    const vertical = new StubElement([0, 80, 1, 160], horizontal);
    vertical.style.overflowY = "auto";
    const panel = new StubElement([20, 30, 500, 500], vertical);
    matches.set(".panel", [panel]);
    expect(findCelebrationSurface([".panel"]))
      .toEqual({ element: panel, rect: { left: 40, top: 80, width: 220, height: 160 } });
    expect(panel.scrollIntoView).not.toHaveBeenCalled();
    expect(vertical.scrollIntoView).not.toHaveBeenCalled();
  });

  it("skips hidden and used panels before selecting a visible fallback", () => {
    const hidden = new StubElement([0, 0, 280, 600], body);
    hidden.inert = true;
    const hiddenChild = new StubElement([20, 20, 200, 200], hidden);
    const used = new StubElement([300, 60, 400, 300], body);
    const fallback = new StubElement([350, 100, 300, 200], body);
    matches.set(".primary", [hiddenChild, used]);
    matches.set(".fallback", [fallback]);
    expect(findCelebrationSurface([".primary", ".fallback"], new Set([dom(used)])))
      .toEqual({ element: fallback, rect: { left: 350, top: 100, width: 300, height: 200 } });
  });

  it("requires at least 48 visible pixels per axis without changing the panel", () => {
    const panel = new StubElement([752, 552, 200, 200], body);
    matches.set(".panel", [panel]);
    expect(findCelebrationSurface([".panel"])?.rect)
      .toEqual({ left: 752, top: 552, width: 48, height: 48 });
    for (const spy of [panel.focus, panel.click, panel.setAttribute, panel.scrollIntoView]) expect(spy).not.toHaveBeenCalled();
    panel.box[0] = 753;
    expect(findCelebrationSurface([".panel"])).toBeNull();
    panel.box = [752, 553, 200, 200];
    expect(findCelebrationSurface([".panel"])).toBeNull();
  });

  it("rejects collapsed or opacity-hidden panels and invalid viewports", () => {
    const panel = new StubElement([20, 20, 300, 400], body);
    matches.set(".panel", [panel]);
    panel.style.visibility = "collapse";
    expect(findCelebrationSurface([".panel"])).toBeNull();
    panel.style.visibility = "visible";
    panel.style.opacity = "0";
    expect(findCelebrationSurface([".panel"])).toBeNull();
    panel.style.opacity = "1";
    vi.stubGlobal("window", { innerWidth: 800, innerHeight: NaN });
    expect(findCelebrationSurface([".panel"])).toBeNull();
  });
});
