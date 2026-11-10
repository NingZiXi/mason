import { afterEach, describe, expect, it, vi } from 'vitest';
import { observePreviewResize } from '../preview-resize';

afterEach(() => vi.unstubAllGlobals());

function harness() {
  let observerCallback!: ResizeObserverCallback;
  const disconnect = vi.fn();
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  const queries: EventTarget[] = [];
  const browser = Object.assign(new EventTarget(), {
    devicePixelRatio: 1,
    requestAnimationFrame: vi.fn((callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; }),
    cancelAnimationFrame: vi.fn((id: number) => frames.delete(id)),
    matchMedia: vi.fn(() => { const query = new EventTarget(); queries.push(query); return query as MediaQueryList; }),
  });
  vi.stubGlobal('window', browser);
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: ResizeObserverCallback) { observerCallback = callback; }
    observe() {}
    disconnect = disconnect;
  });
  return {
    browser, queries, frames, disconnect,
    layout: () => observerCallback([], {} as ResizeObserver),
    flush: () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(16)); },
  };
}

describe('preview resize scheduling', () => {
  it('combines repeated layout and window events into one frame and then idles', () => {
    const env = harness(), resize = vi.fn();
    const stop = observePreviewResize({} as HTMLElement, resize);
    env.layout(); env.layout(); env.browser.dispatchEvent(new Event('resize'));
    expect(env.frames.size).toBe(1);
    expect(resize).not.toHaveBeenCalled();
    env.flush();
    expect(resize).toHaveBeenCalledOnce();
    expect(env.frames.size).toBe(0);
    stop();
  });

  it('rearms the density query across multiple monitor-scale changes without a layout event', () => {
    const env = harness(), resize = vi.fn();
    const stop = observePreviewResize({} as HTMLElement, resize);
    env.browser.devicePixelRatio = 1.5;
    env.queries[0].dispatchEvent(new Event('change'));
    expect(env.browser.matchMedia).toHaveBeenLastCalledWith('(resolution: 1.5dppx)');
    env.flush();
    env.browser.devicePixelRatio = 2;
    env.queries[1].dispatchEvent(new Event('change'));
    expect(env.browser.matchMedia).toHaveBeenLastCalledWith('(resolution: 2dppx)');
    env.flush();
    expect(resize).toHaveBeenCalledTimes(2);
    // A previous monitor query no longer owns a listener.
    env.queries[0].dispatchEvent(new Event('change'));
    expect(env.frames.size).toBe(0);
    stop();
  });

  it('disconnects all listeners and cancels a pending frame on teardown', () => {
    const env = harness(), resize = vi.fn();
    const stop = observePreviewResize({} as HTMLElement, resize);
    env.layout(); stop();
    env.browser.dispatchEvent(new Event('resize'));
    env.queries[0].dispatchEvent(new Event('change'));
    env.layout(); env.flush();
    expect(resize).not.toHaveBeenCalled();
    expect(env.disconnect).toHaveBeenCalledOnce();
    expect(env.frames.size).toBe(0);
  });
});
