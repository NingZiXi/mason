import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createSourceFile, isFunctionDeclaration, ScriptKind, ScriptTarget, transpileModule } from 'typescript';

// Exercise the real viewport handlers without creating a WebGL context. In
// particular, keep the queued frame separate from the event that scheduled it.
const source = readFileSync(new URL('../../components/ModelPreview.vue', import.meta.url), 'utf8');
const script = source.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)![1];
const syntax = createSourceFile('ModelPreview.ts', script, ScriptTarget.Latest, true, ScriptKind.TS);
const names = new Set(['clearMeasure', 'setMeasureMode', 'updateHover', 'cancelHoverFrame', 'clearMeasureHover',
  'onCanvasPointerMove', 'onCanvasPointerDown', 'onCanvasPointerLeave', 'onCanvasPointerUp']);
const functions = syntax.statements.filter(node => isFunctionDeclaration(node) && names.has(node.name?.text ?? ''));
if (functions.length !== names.size) throw new Error('A viewport measurement handler is missing from the test harness');
const javascript = transpileModule(functions.map(node => node.getText(syntax)).join('\n'),
  { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText;

function setup() {
  let nextFrame = 0;
  const frames = new Map<number, FrameRequestCallback>();
  const requestFrame = vi.fn((callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame; });
  const cancelFrame = vi.fn((id: number) => frames.delete(id));
  const pick = vi.fn(() => ({ id: 'surface' }));
  const rebuild = vi.fn();
  const click = vi.fn();
  const create = new Function('requestAnimationFrame', 'cancelAnimationFrame', 'pickFeature', 'rebuildMeasureVisuals', 'applyFeatureClick', `
    const measureMode = { value: true }, inspectionOpen = { value: false };
    const selA = { value: { id: 'selected' } }, selB = { value: null };
    const measureRows = { value: ['distance'] }, measureTags = { value: ['label'] }, errorMsg = { value: null };
    let disposed = false, hoverFeature = null, hoverPending = null, hoverRafId = null, pointerDownAt = null;
    const disposeMeasureGroup = () => {}, disposeMeasureMats = () => {}, invalidate = () => {};
    ${javascript}
    return { move: onCanvasPointerMove, down: onCanvasPointerDown, up: onCanvasPointerUp,
      leave: onCanvasPointerLeave, mode: setMeasureMode, clear: clearMeasure,
      hide: () => { inspectionOpen.value = true; }, dispose: () => { disposed = true; },
      inspect: () => ({ measuring: measureMode.value, hoverFeature, hoverPending, hoverRafId, pointerDownAt,
        selected: selA.value, rows: measureRows.value, tags: measureTags.value }) };
  `);
  const handlers = create(requestFrame, cancelFrame, pick, rebuild, click) as {
    move: (event: PointerEvent) => void; down: (event: PointerEvent) => void; up: (event: PointerEvent) => void;
    leave: () => void; mode: (enabled: boolean) => void; clear: () => void; hide: () => void; dispose: () => void;
    inspect: () => { measuring: boolean; hoverFeature: { id: string } | null; hoverPending: PointerEvent | null;
      hoverRafId: number | null; pointerDownAt: { x: number; y: number } | null;
      selected: { id: string } | null; rows: string[]; tags: string[] };
  };
  const flush = () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(0)); };
  return { handlers, frames, requestFrame, cancelFrame, pick, rebuild, click, flush };
}
const pointer = (x = 20, y = 20, buttons = 0): PointerEvent => ({ clientX: x, clientY: y, buttons, button: 0 } as PointerEvent);

describe('3D measurement hover lifecycle', () => {
  it('coalesces pointer motion into one pick at the latest position', () => {
    const { handlers, requestFrame, pick, flush } = setup();
    handlers.move(pointer());
    const latest = pointer(30, 30);
    handlers.move(latest);
    expect(requestFrame).toHaveBeenCalledOnce();
    flush();
    expect(pick).toHaveBeenCalledTimes(1);
    expect(pick).toHaveBeenCalledWith(latest);
    expect(handlers.inspect().hoverFeature?.id).toBe('surface');
  });

  it('cancels queued picking when measurement is closed and rejects a late callback', () => {
    const { handlers, frames, cancelFrame, pick, rebuild, flush } = setup();
    handlers.move(pointer());
    const late = [...frames.values()][0];
    handlers.mode(false);
    expect(cancelFrame).toHaveBeenCalledOnce();
    flush(); late(0);
    expect(pick).not.toHaveBeenCalled();
    expect(rebuild).not.toHaveBeenCalled();
    expect(handlers.inspect()).toMatchObject({ measuring: false, hoverFeature: null, hoverPending: null, hoverRafId: null });
  });

  it('does not restore hover during an orbit drag, while a subsequent click can still select', () => {
    const { handlers, frames, pick, click, flush } = setup();
    handlers.move(pointer());
    const late = [...frames.values()][0];
    handlers.down(pointer(20, 20, 1));
    handlers.move(pointer(60, 20, 1));
    late(0); flush();
    expect(pick).not.toHaveBeenCalled();
    handlers.up(pointer(60, 20));
    expect(click).not.toHaveBeenCalled();
    handlers.down(pointer(60, 20, 1));
    handlers.up(pointer(60, 20));
    expect(click).toHaveBeenCalledTimes(1);
    expect(click).toHaveBeenCalledWith({ id: 'surface' });
  });

  it('clears transient hover on canvas leave or cancellation and retains selected measurements', () => {
    const { handlers, rebuild, flush } = setup();
    handlers.move(pointer()); flush();
    handlers.leave();
    expect(rebuild).toHaveBeenCalledTimes(2);
    expect(handlers.inspect()).toMatchObject({ hoverFeature: null, pointerDownAt: null,
      selected: { id: 'selected' }, rows: ['distance'], tags: ['label'] });
    handlers.move(pointer());
    handlers.leave(); flush();
    expect(handlers.inspect().hoverFeature).toBeNull();
  });

  it.each(['hide', 'dispose'] as const)('does not pick after the scene becomes unavailable: %s', state => {
    const { handlers, pick, flush } = setup();
    handlers.move(pointer());
    handlers[state](); flush();
    handlers.move(pointer()); flush();
    expect(pick).not.toHaveBeenCalled();
  });
});
