import { describe, expect, it, vi } from 'vitest';
import { createInspectionInteraction, screenToInspection } from '../inspection-interaction';
import { prepareSelectionPads } from '../inspection-selection';
import type { InspectionPad } from '../stencil-inspection';

function setup() {
  const attrs = new Map<string, string>([['viewBox', '-10 -10 20 20']]);
  const rectAttrs = new Map<string, string>();
  const captures = new Set<number>();
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0, editing = true, selected: number[] = [];
  const svg = {
    setAttribute: vi.fn((key: string, value: string) => { attrs.set(key, value); }),
    getScreenCTM: () => {
      const [x, y, width, height] = attrs.get('viewBox')!.split(' ').map(Number);
      const scale = Math.min(400 / width, 300 / height);
      return { a: scale, b: 0, c: 0, d: scale, e: (400 - width * scale) / 2 - x * scale, f: (300 - height * scale) / 2 - y * scale };
    },
    setPointerCapture: (id: number) => captures.add(id), hasPointerCapture: (id: number) => captures.has(id),
    releasePointerCapture: (id: number) => captures.delete(id), focus: vi.fn(),
  };
  const rect = { style: { display: 'none' }, setAttribute: (key: string, value: string) => rectAttrs.set(key, value) };
  const pads: InspectionPad[] = [-3, 3].map((x, index) => ({ sourceIndex: index + 5, decision: 'auto', width: 1, height: 1,
    polygons: [{ outer: [[x - .5, -.5], [x + .5, -.5], [x + .5, .5], [x - .5, .5]], holes: [] }] }));
  const select = vi.fn((ids: number[]) => { selected = ids; });
  const gesture = vi.fn();
  const canvas = createInspectionInteraction({ svg: () => svg as unknown as SVGSVGElement,
    marquee: () => rect as unknown as SVGRectElement, canSelect: () => editing,
    pads: () => prepareSelectionPads(pads), selection: () => selected, select, gesture, zoom: vi.fn(),
    frame: callback => { frames.set(++nextFrame, callback); return nextFrame; }, cancelFrame: id => { frames.delete(id); } });
  function event(type: string, button: number, x: number, y: number, index: number | null = null, modifiers: Partial<PointerEvent> = {}) {
    return { type, button, pointerId: 1, clientX: x, clientY: y, ctrlKey: false, shiftKey: false, metaKey: false,
      preventDefault: vi.fn(), target: { closest: () => index === null ? null : { getAttribute: () => String(index) } }, ...modifiers } as unknown as PointerEvent;
  }
  function screen(x: number, y: number) {
    const m = svg.getScreenCTM(); return { x: m.a * x + m.e, y: m.d * y + m.f };
  }
  function tick() { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(0)); }
  return { canvas, svg, rect, attrs, frames, captures, select, gesture, event, screen, tick,
    editing: (value: boolean) => { editing = value; }, selected: () => selected };
}

describe('inspection pointer controls', () => {
  it('left-clicks to select and uses only the right button to pan, without changing selection', () => {
    const s = setup();
    s.canvas.down(s.event('pointerdown', 0, 155, 150, 5));
    s.canvas.finish(s.event('pointerup', 0, 155, 150));
    expect(s.selected()).toEqual([5]);
    expect(s.attrs.get('viewBox')).toBe('-10 -10 20 20');
    s.canvas.down(s.event('pointerdown', 2, 155, 150, 5));
    s.svg.setAttribute.mockClear();
    for (let i = 1; i <= 100; i++) s.canvas.move(s.event('pointermove', 2, 155 + i, 150 + i));
    expect(s.frames.size).toBe(1);
    expect(s.svg.setAttribute).not.toHaveBeenCalled();
    s.tick();
    expect(s.svg.setAttribute).toHaveBeenCalledTimes(1);
    s.canvas.finish(s.event('pointerup', 2, 255, 250));
    expect(s.selected()).toEqual([5]);
    expect(s.select).toHaveBeenCalledTimes(1);
    const [x, y] = s.attrs.get('viewBox')!.split(' ').map(Number);
    expect(x).toBeCloseTo(-10 - 100 / 15);
    expect(y).toBeCloseTo(x);
    expect(s.captures.size).toBe(0);
  });

  it('left-drags a selection box even when starting on a pad, then commits once on release', () => {
    const s = setup();
    const start = s.screen(-3, 0), end = s.screen(4, 2);
    s.canvas.down(s.event('pointerdown', 0, start.x, start.y, 5));
    for (let i = 0; i < 80; i++) s.canvas.move(s.event('pointermove', 0, end.x, end.y));
    expect(s.select).not.toHaveBeenCalled();
    s.svg.setAttribute.mockClear(); s.tick();
    expect(s.rect.style.display).toBe('');
    expect(s.svg.setAttribute).not.toHaveBeenCalled(); // Box movement never updates the viewBox.
    s.canvas.finish(s.event('pointerup', 0, end.x, end.y));
    expect(s.selected()).toEqual([5, 6]);
    expect(s.select).toHaveBeenCalledTimes(1);
    expect(s.attrs.get('viewBox')).toBe('-10 -10 20 20');
    expect(s.rect.style.display).toBe('none');
  });

  it('supports Shift add, Ctrl/Meta toggle and clearing by clicking blank space', () => {
    const s = setup();
    const click = (index: number | null, modifiers = {}) => {
      s.canvas.down(s.event('pointerdown', 0, 100, 100, index, modifiers));
      s.canvas.finish(s.event('pointerup', 0, 100, 100));
    };
    click(5); click(6, { shiftKey: true });
    expect(s.selected()).toEqual([5, 6]);
    click(5, { ctrlKey: true });
    expect(s.selected()).toEqual([6]);
    click(6, { metaKey: true });
    expect(s.selected()).toEqual([]);
    click(5); click(null, { shiftKey: true });
    expect(s.selected()).toEqual([5]);
    click(null);
    expect(s.selected()).toEqual([]);
  });

  it('box-selects in reverse after zooming and panning, with Shift/Ctrl selection modifiers', () => {
    const s = setup();
    s.canvas.zoomBy(2); s.tick();
    s.canvas.down(s.event('pointerdown', 2, 150, 100));
    s.canvas.finish(s.event('pointerup', 2, 180, 120));
    const a = s.screen(4, 1), b = s.screen(-4, -1);
    s.canvas.down(s.event('pointerdown', 0, a.x, a.y, null, { shiftKey: true }));
    s.canvas.finish(s.event('pointerup', 0, b.x, b.y));
    expect(s.selected()).toEqual([5, 6]);
    const c = s.screen(-2, 1), d = s.screen(-4, -1);
    s.canvas.down(s.event('pointerdown', 0, c.x, c.y, null, { ctrlKey: true }));
    s.canvas.finish(s.event('pointerup', 0, d.x, d.y));
    expect(s.selected()).toEqual([6]);
  });

  it('makes result views read only but still allows right-button navigation', () => {
    const s = setup(); s.editing(false);
    s.canvas.down(s.event('pointerdown', 0, 100, 100, 5));
    s.canvas.move(s.event('pointermove', 0, 200, 200));
    s.canvas.finish(s.event('pointerup', 0, 200, 200));
    expect(s.select).not.toHaveBeenCalled();
    expect(s.attrs.get('viewBox')).toBe('-10 -10 20 20');
    s.canvas.down(s.event('pointerdown', 2, 100, 100));
    s.canvas.finish(s.event('pointerup', 2, 160, 100));
    expect(s.attrs.get('viewBox')).toBe('-14 -10 20 20');
    expect(s.select).not.toHaveBeenCalled();
  });

  it('never commits a cancelled, interrupted, or mismatched-pointer selection', () => {
    const s = setup();
    s.canvas.down(s.event('pointerdown', 0, 100, 100, 5));
    s.canvas.finish(s.event('pointerup', 0, 100, 100, null, { pointerId: 2 }));
    expect(s.captures.size).toBe(1);
    s.canvas.finish(s.event('pointercancel', 0, 100, 100));
    expect(s.select).not.toHaveBeenCalled();
    s.canvas.down(s.event('pointerdown', 0, 100, 100, 5));
    s.editing(false);
    s.canvas.finish(s.event('pointerup', 0, 100, 100));
    expect(s.select).not.toHaveBeenCalled();
    s.editing(true); s.canvas.down(s.event('pointerdown', 0, 100, 100, 5));
    s.canvas.move(s.event('pointermove', 0, 130, 130));
    s.canvas.dispose();
    expect(s.select).not.toHaveBeenCalled();
    expect(s.frames.size).toBe(0);
    expect(s.captures.size).toBe(0);
  });

  it('keeps cursor zoom anchored after panning and after fitting a non-square board', () => {
    const s = setup();
    s.canvas.fit({ x: -50, y: -15, width: 100, height: 30 }); s.tick();
    s.canvas.down(s.event('pointerdown', 2, 200, 150));
    s.canvas.finish(s.event('pointerup', 2, 220, 180));
    const cursor = { x: 123, y: 100 };
    const before = screenToInspection(cursor, s.svg.getScreenCTM());
    s.canvas.wheel({ clientX: cursor.x, clientY: cursor.y, deltaY: -60, deltaMode: 0 } as WheelEvent);
    s.tick();
    const after = screenToInspection(cursor, s.svg.getScreenCTM());
    expect(after!.x).toBeCloseTo(before!.x);
    expect(after!.y).toBeCloseTo(before!.y);
    expect(screenToInspection(cursor, { a: 0, b: 0, c: 0, d: 0, e: 0, f: 0 })).toBeNull();
  });

  it('coalesces a burst of wheel zoom events into one frame without losing the cursor anchor', () => {
    const s = setup();
    s.canvas.refresh(); s.tick(); s.svg.setAttribute.mockClear();
    const cursor = { x: 150, y: 125 };
    const before = screenToInspection(cursor, s.svg.getScreenCTM());
    for (let i = 0; i < 20; i++) s.canvas.wheel({ clientX: cursor.x, clientY: cursor.y, deltaY: -2, deltaMode: 0 } as WheelEvent);
    expect(s.frames.size).toBe(1);
    expect(s.svg.setAttribute).not.toHaveBeenCalled();
    s.tick();
    expect(s.svg.setAttribute).toHaveBeenCalledTimes(1);
    const after = screenToInspection(cursor, s.svg.getScreenCTM());
    expect(after!.x).toBeCloseTo(before!.x);
    expect(after!.y).toBeCloseTo(before!.y);
  });
});
