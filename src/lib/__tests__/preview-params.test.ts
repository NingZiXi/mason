import { describe, expect, it } from 'vitest';
import { nextTick, reactive } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { DEFAULT, useConfigStore, type AppConfig } from '../../stores/config';
import type { ComponentReliefRegion } from '../component-relief';
import type { PadPolygon } from '../gerber/pads';
import { createPreviewParameterCache, watchPreviewGeometryChanges } from '../preview-params';
import { scadPartHash } from '../model-params';

const region = (depth?: number, through = false): ComponentReliefRegion => ({
  id: 'chip', shape: 'rect', x: 0, y: 0, width: 10, height: 8, depth, through,
});
const config = () => reactive<AppConfig>({ ...DEFAULT,
  componentReliefRegions: { top: [], bottom: [] }, pryNotchSides: [...DEFAULT.pryNotchSides],
  pcbOutlinePoints: [], pcbOutlineHoles: [], stencilPadsTop: [], stencilPadsBottom: [],
});

describe('preview parameter serialization cache', () => {
  it('reads imported vertices once for repeated freshness and part checks until geometry changes', () => {
    const c = config();
    c.appMode = 'stencil';
    let vertexReads = 0;
    const point = [0, 0] as [number, number];
    Object.defineProperty(point, '0', { get() { ++vertexReads; return 0; }, enumerable: true });
    c.stencilPadsTop = [{ type: 'rect', cx: 0, cy: 0, polarity: 'D',
      parts: [{ polarity: 'D', points: [point, [1, 0], [1, 1], [0, 1]] }] }];
    const cache = createPreviewParameterCache(() => c);
    const params = cache.params();
    const initialHash = cache.hash();
    const initialPart = cache.partHash('stencil_top', params);
    const reads = vertexReads;
    expect(reads).toBeGreaterThan(0);
    for (let index = 0; index < 8; index++) {
      expect(cache.params()).toBe(params);
      expect(cache.hash()).toBe(initialHash);
      expect(cache.partHash('stencil_top', params)).toBe(initialPart);
    }
    expect(vertexReads).toBe(reads);
    c.stencilThickness += .1;
    expect(cache.hash()).not.toBe(initialHash);
    expect(cache.partHash('stencil_top')).not.toBe(initialPart);
    expect(vertexReads).toBeGreaterThan(reads);
  });

  it('retains captured export keys and invalidates live keys for in-place opening changes', () => {
    const c = config();
    c.appMode = 'stencil';
    c.stencilPadsTop = [{ type: 'rect', cx: 0, cy: 0, polarity: 'D', parts: [] }];
    const cache = createPreviewParameterCache(() => c);
    const captured = JSON.parse(JSON.stringify(cache.params()));
    const capturedKey = cache.partHash('stencil_top', captured);
    const oldHash = cache.hash();
    c.stencilPadsTop[0].apertureOverride = 'closed';
    expect(cache.hash()).not.toBe(oldHash);
    expect(cache.partHash('stencil_top')).not.toBe(capturedKey);
    expect(cache.partHash('stencil_top', captured)).toBe(capturedKey);
    expect(cache.partHash('stencil_top')).toBe(scadPartHash(cache.params(), 'stencil_top'));
    c.stencilPadsTop[0].apertureOverride = undefined;
    expect(cache.hash()).toBe(oldHash);
    expect(cache.partHash('stencil_top')).toBe(capturedKey);
  });
});

describe('effective preview geometry changes', () => {
  it('refreshes after in-place opening decisions and their undo/redo without replacing imported arrays', async () => {
    setActivePinia(createPinia());
    const store = useConfigStore();
    store.config.appMode = 'stencil';
    store.config.stencilPadsTop = [{ type: 'rect', cx: 0, cy: 0, polarity: 'D', parts: [] }];
    await nextTick();
    store.clearParameterHistory();
    const pads = store.config.stencilPadsTop;
    let changed = 0;
    const stop = watchPreviewGeometryChanges(() => store.config, () => ++changed);
    store.setApertureOverrides('top', [0], 'closed');
    await nextTick();
    expect(changed).toBe(1);
    expect(pads[0].apertureOverride).toBe('closed');
    await store.undo();
    expect(changed).toBe(2);
    expect(pads[0].apertureOverride).toBeUndefined();
    await store.redo();
    expect(changed).toBe(3);
    expect(pads[0].apertureOverride).toBe('closed');
    expect(store.config.stencilPadsTop).toBe(pads);
    store.setApertureOverrides('top', [0], 'closed');
    await nextTick();
    expect(changed).toBe(3);
    stop();
  });

  it('does not reread pad decisions during scalar slider changes', async () => {
    const c = config();
    let decisionReads = 0;
    c.stencilPadsTop = [{ type: 'rect', cx: 0, cy: 0, polarity: 'D', parts: [],
      get apertureOverride() { ++decisionReads; return undefined; } }];
    let changed = 0;
    const stop = watchPreviewGeometryChanges(() => c, () => ++changed);
    const reads = decisionReads;
    c.ejectHoleDiameter = 12;
    await nextTick();
    c.ejectHoleDiameter = 16;
    await nextTick();
    expect(changed).toBe(2);
    expect(decisionReads).toBe(reads);
    stop();
  });

  it('reuses relief vertex signatures during scalar edits and still observes in-place polygon changes', async () => {
    const c = config();
    c.componentReliefEnabled = true;
    let vertexReads = 0;
    const point = [0, 0] as [number, number];
    Object.defineProperty(point, '0', { get() { ++vertexReads; return 0; }, enumerable: true });
    c.componentReliefRegions.top = [{ ...region(3), shape: 'polygon',
      points: [point, [10, 0], [10, 8], [0, 8]] }];
    let changed = 0;
    const stop = watchPreviewGeometryChanges(() => c, () => ++changed);
    const reads = vertexReads;
    expect(reads).toBeGreaterThan(0);
    c.ejectHoleDiameter = 12;
    await nextTick();
    c.ejectHoleDiameter = 16;
    await nextTick();
    expect(changed).toBe(2);
    expect(vertexReads).toBe(reads);
    c.componentReliefRegions.top[0].points![0][1] = 1;
    await nextTick();
    expect(changed).toBe(3);
    expect(vertexReads).toBeGreaterThan(reads);
    stop();
  });

  it('keeps the current measurement and generation when only a new-region default changes', async () => {
    const c = config();
    c.componentReliefEnabled = true;
    c.componentReliefRegions.top = [region(4)];
    let measurements = ['selected edge'];
    let cancelled = 0;
    const stop = watchPreviewGeometryChanges(() => c, () => { measurements = []; ++cancelled; });
    c.componentReliefDepth = 10;
    await nextTick();
    expect(measurements).toEqual(['selected edge']);
    expect(cancelled).toBe(0);
    c.componentReliefRegions.top = [region(7)];
    await nextTick();
    expect(measurements).toEqual([]);
    expect(cancelled).toBe(1);
    stop();
  });

  it('refreshes for a legacy fallback depth, but not when that fallback is materialized unchanged', async () => {
    const c = config();
    c.componentReliefEnabled = true;
    c.componentReliefRegions.top = [region()];
    let changed = 0;
    const stop = watchPreviewGeometryChanges(() => c, () => ++changed);
    c.componentReliefDepth = 5;
    await nextTick();
    expect(changed).toBe(1);
    c.componentReliefRegions = { top: [region(5)], bottom: [] };
    c.componentReliefDepth = 12;
    // Undo/preset restoration may also replace small arrays with equal values.
    c.pryNotchSides = [...c.pryNotchSides];
    await nextTick();
    expect(changed).toBe(1);
    stop();
  });

  it('retains inactive-face plans and through-cut depths without invalidating the visible model', async () => {
    const c = config();
    c.componentReliefEnabled = true;
    c.componentReliefRegions.top = [region(3, true)];
    let changed = 0;
    const stop = watchPreviewGeometryChanges(() => c, () => ++changed);
    c.componentReliefRegions = { top: [region(19, true)], bottom: [region(8)] };
    c.componentReliefDepth = 18;
    await nextTick();
    expect(changed).toBe(0);
    c.jigPrintSide = 'bottom';
    await nextTick();
    expect(changed).toBe(1);
    c.componentReliefRegions.bottom[0].depth = 10;
    await nextTick();
    expect(changed).toBe(2);
    stop();
  });

  it('ignores a remembered hole diameter when off, and refreshes after enabling or resizing it', async () => {
    const c = config();
    c.ejectSlotWidth = 0;
    let changed = 0;
    const stop = watchPreviewGeometryChanges(() => c, () => ++changed);
    c.ejectHoleDiameter = 20;
    await nextTick();
    expect(changed).toBe(0);
    c.ejectSlotWidth = DEFAULT.ejectSlotWidth;
    await nextTick();
    expect(changed).toBe(1);
    c.ejectHoleDiameter = 24;
    await nextTick();
    expect(changed).toBe(2);
    stop();
  });

  it('ignores relief and hole diameter settings in independent stencil mode', async () => {
    const c = config();
    c.appMode = 'stencil';
    let changed = 0;
    const stop = watchPreviewGeometryChanges(() => c, () => ++changed);
    c.componentReliefEnabled = true;
    c.jigPrintSide = 'bottom';
    c.componentReliefDepth = 12;
    c.componentReliefRegions = { top: [], bottom: [region(10)] };
    c.ejectHoleDiameter = 30;
    await nextTick();
    expect(changed).toBe(0);
    c.appMode = 'jig';
    await nextTick();
    expect(changed).toBe(1);
    stop();
  });

  it('tracks imported buffers by reference without reading pad vertices on slider edits', async () => {
    const c = config();
    let vertexReads = 0;
    const pad: PadPolygon = { type: 'rect', cx: 0, cy: 0, polarity: 'D', get parts() { ++vertexReads; return []; } };
    c.stencilPadsTop = [pad];
    let changed = 0;
    const stop = watchPreviewGeometryChanges(() => c, () => ++changed);
    c.ejectHoleDiameter = 12;
    await nextTick();
    c.ejectHoleDiameter = 16;
    await nextTick();
    expect(changed).toBe(2);
    expect(vertexReads).toBe(0);
    c.stencilPadsTop = [...c.stencilPadsTop];
    await nextTick();
    expect(changed).toBe(3);
    expect(vertexReads).toBe(0);
    stop();
  });
});
