import { afterEach, describe, expect, it, vi } from 'vitest';
import { attachAppTooltip } from '../../directives/app-tooltip';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

function harness() {
  vi.useFakeTimers();
  class Element extends EventTarget {
    ownerDocument!: Document;
    id = ''; className = ''; textContent = ''; isConnected = true; visible = true; blocked = false; zIndex = 'auto';
    style: Record<string, string> = {}; dataset: Record<string, string> = {};
    attributes = new Map<string, string>(); classes = new Set<string>();
    classList = { add: (name: string) => this.classes.add(name), remove: (name: string) => this.classes.delete(name) };
    children: Element[] = []; parent?: Element;
    bounds = { left: 100, top: 100, width: 120, height: 32 };
    setAttribute(name: string, value: string) { this.attributes.set(name, value); }
    getAttribute(name: string) { return this.attributes.get(name) ?? null; }
    removeAttribute(name: string) { this.attributes.delete(name); }
    getClientRects() { return this.isConnected && this.visible ? [this.bounds] : []; }
    getBoundingClientRect() { return this.bounds; }
    closest() { return this.blocked || this.parent?.blocked ? this : null; }
    contains(target: Element | null): boolean { return !!target && (target === this || !!target.parent && this.contains(target.parent)); }
    appendChild(child: Element) { child.remove(); this.children.push(child); child.parent = this; child.isConnected = true; return child; }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = undefined; this.isConnected = false; }
  }
  const frames = new Map<number, FrameRequestCallback>();
  let frame = 0;
  const viewport = Object.assign(new EventTarget(), { width: 400, height: 300, offsetLeft: 0, offsetTop: 0 });
  const browser = Object.assign(new EventTarget(), {
    innerWidth: 400, innerHeight: 300, visualViewport: viewport,
    getComputedStyle: (element: Element) => ({ visibility: element.visible ? 'visible' : 'hidden', zIndex: element.zIndex }),
    requestAnimationFrame: (callback: FrameRequestCallback) => { frames.set(++frame, callback); return frame; },
    cancelAnimationFrame: (id: number) => frames.delete(id),
  });
  const modals: Element[] = [];
  const document = Object.assign(new EventTarget(), {
    defaultView: browser, body: new Element(),
    createElement: () => { const element = new Element(); element.ownerDocument = document as unknown as Document; return element; },
    querySelectorAll: () => modals,
  });
  document.body.ownerDocument = document as unknown as Document;
  const mutations: Array<{ callback: MutationCallback; observe: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }> = [];
  const resizes: Array<{ disconnect: ReturnType<typeof vi.fn> }> = [];
  vi.stubGlobal('MutationObserver', class {
    observe = vi.fn(); disconnect = vi.fn();
    constructor(callback: MutationCallback) { mutations.push({ callback, observe: this.observe, disconnect: this.disconnect }); }
  });
  vi.stubGlobal('ResizeObserver', class {
    observe = vi.fn(); disconnect = vi.fn();
    constructor() { resizes.push({ disconnect: this.disconnect }); }
  });
  const element = document.createElement(); element.bounds = { left: 100, top: 100, width: 32, height: 28 };
  document.body.appendChild(element);
  const tooltip = () => document.body.children.find(child => child.getAttribute('role') === 'tooltip');
  const enter = () => element.dispatchEvent(Object.assign(new Event('pointerenter'), { pointerType: 'mouse' }));
  const show = () => { enter(); vi.advanceTimersByTime(380); };
  const mutate = () => mutations[mutations.length - 1]?.callback([], {} as MutationObserver);
  const modal = (z = '3000') => { const next = document.createElement(); next.zIndex = z; modals.push(next); document.body.appendChild(next); return next; };
  return { element, native: element as unknown as HTMLElement, document, browser, viewport, tooltip, enter, show, mutate, modal, frames, mutations, resizes };
}

describe('native app tooltip lifecycle', () => {
  it('performs no layout or modal reads when hidden controls rerender', () => {
    const env = harness();
    const bounds = vi.spyOn(env.element, 'getClientRects');
    const style = vi.spyOn(env.browser, 'getComputedStyle');
    const modals = vi.spyOn(env.document, 'querySelectorAll');
    const binding = attachAppTooltip(env.native, 'Hint');
    for (let index = 0; index < 100; index++) binding.update({ content: `Hint ${index}`, placement: 'bottom' });
    expect(bounds).not.toHaveBeenCalled(); expect(style).not.toHaveBeenCalled(); expect(modals).not.toHaveBeenCalled();
    env.show();
    expect(bounds).toHaveBeenCalled(); expect(style).toHaveBeenCalled(); expect(modals).toHaveBeenCalled();
    expect(env.tooltip()?.textContent).toBe('Hint 99');
    binding.destroy();
  });

  it('uses safe text and preserves existing accessible descriptions', () => {
    const env = harness(); env.element.setAttribute('aria-describedby', 'existing-description');
    const binding = attachAppTooltip(env.native, '<img src=x onerror=alert(1)>');
    env.show();
    expect(env.tooltip()?.textContent).toBe('<img src=x onerror=alert(1)>');
    const id = env.tooltip()!.id;
    expect(env.element.getAttribute('aria-describedby')).toBe(`existing-description ${id}`);
    env.element.dispatchEvent(new Event('pointerleave'));
    expect(env.element.getAttribute('aria-describedby')).toBe('existing-description');
    binding.destroy();
  });

  it('consumes Escape before it can close the containing dialog', () => {
    const env = harness(), binding = attachAppTooltip(env.native, 'Hint'); env.show();
    const escape = Object.assign(new Event('keydown', { cancelable: true }), { key: 'Escape' });
    const stop = vi.spyOn(escape, 'stopPropagation');
    env.document.dispatchEvent(escape);
    expect(escape.defaultPrevented).toBe(true); expect(stop).toHaveBeenCalledOnce();
    expect(env.tooltip()?.getAttribute('aria-hidden')).toBe('true');
    binding.destroy();
  });

  it('removes workspace hints when a modal opens, including reused hidden overlays', () => {
    const env = harness(), hidden = env.modal(); hidden.visible = false;
    const binding = attachAppTooltip(env.native, 'Hint'); env.show();
    expect(env.tooltip()?.getAttribute('aria-hidden')).toBeNull();
    hidden.visible = true; env.mutate();
    expect(env.tooltip()?.getAttribute('aria-hidden')).toBe('true');
    expect(env.element.getAttribute('aria-describedby')).toBeNull();
    binding.destroy();
  });

  it('keeps modal-owned hints above that modal and prevents covered triggers from reopening', () => {
    const env = harness(), modal = env.modal(); modal.appendChild(env.element);
    const binding = attachAppTooltip(env.native, 'Settings hint'); env.show();
    expect(env.tooltip()?.style.zIndex).toBe('3001');
    env.modal('4000'); env.mutate();
    env.element.dispatchEvent(new Event('pointerleave')); env.show();
    expect(env.tooltip()).toBeUndefined();
    binding.destroy();
  });

  it('accounts for a zoomed visual viewport and updates translated content in place', () => {
    const env = harness(); env.viewport.offsetLeft = 50; env.viewport.offsetTop = 30;
    const binding = attachAppTooltip(env.native, 'Hint'); env.show();
    expect(env.tooltip()?.style.left).toBe('58px'); expect(env.tooltip()?.style.top).toBe('60px');
    binding.update('新的提示'); expect(env.tooltip()?.textContent).toBe('新的提示');
    binding.destroy();
  });

  it('cleans timers, frames, observers, document listeners and the body node on teardown', () => {
    const env = harness(), added = vi.spyOn(env.document, 'addEventListener'), removed = vi.spyOn(env.document, 'removeEventListener');
    const binding = attachAppTooltip(env.native, 'Hint'); env.show(); expect(env.frames.size).toBe(1);
    binding.destroy();
    expect(env.frames.size).toBe(0); expect(env.tooltip()).toBeUndefined();
    expect(env.mutations[0].disconnect).toHaveBeenCalled(); expect(env.resizes[0].disconnect).toHaveBeenCalled();
    for (const [type, listener, capture] of added.mock.calls) expect(removed).toHaveBeenCalledWith(type, listener, capture);
    env.show(); expect(env.tooltip()).toBeUndefined(); expect(vi.getTimerCount()).toBe(0);
  });
});
