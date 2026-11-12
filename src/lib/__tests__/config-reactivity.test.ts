import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import { nextTick } from 'vue';
import { effectivePlatterMargin, positioningPostLayoutFor, stencilClampFloor, stencilLipMax,
  useConfigStore, windowHalf } from '../../stores/config';
import { useWorkSessionStore } from '../../stores/work-session';
import type { PanelVariant } from '../gerber/panel';

let pinia: ReturnType<typeof createPinia>;
beforeEach(() => { pinia = createPinia(); setActivePinia(pinia); });
afterEach(() => disposePinia(pinia));

function variant(width: number): PanelVariant {
  return { width, height: 30, center: { x: 0, y: 0 },
    outlinePoints: [[-width / 2, -15], [width / 2, -15], [width / 2, 15], [-width / 2, 15]],
    outlineHoles: [], topPads: [{ type: 'rect', cx: 0, cy: 0, polarity: 'D', parts: [] }], bottomPads: [] };
}

describe('PCB pocket clearance reactivity', () => {
  it('keeps the lip control, stored dimensions and undo history consistent after a clearance edit', async () => {
    const store = useConfigStore();
    Object.assign(store.config, { stencilSizeX: 60, stencilSizeY: 60, stencilLip: 4.8, cornerScrewD: 15 });
    await nextTick();
    store.clearParameterHistory();
    expect(store.config.jigSize).toBe(105);

    store.config.pcbPocketClearance = 2;
    await nextTick();
    expect(store.config.stencilLip).toBe(3);
    expect(store.config.stencilLip).toBe(stencilLipMax(store.config));
    expect(store.config.platterMargin).toBe(effectivePlatterMargin(store.config));
    expect(store.config.jigSize).toBe(110);
    expect(store.config.jigSize).toBe(Math.max(60, Math.ceil(Math.max(2 * windowHalf(store.config) + 28,
      stencilClampFloor(store.config), positioningPostLayoutFor(store.config).minimumJigSize) / 5) * 5));

    await store.undo();
    expect(store.config.pcbPocketClearance).toBe(.2);
    expect(store.config.stencilLip).toBe(4.8);
    expect(store.config.jigSize).toBe(105);
    expect(store.canUndo).toBe(false);
    await store.redo();
    expect(store.config.pcbPocketClearance).toBe(2);
    expect(store.config.stencilLip).toBe(3);
    expect(store.config.jigSize).toBe(110);
  });

  it('updates the derived clamping margin without requiring another parameter edit', async () => {
    const store = useConfigStore();
    expect(store.config.platterMargin).toBeCloseTo(9.8);
    store.config.pcbPocketClearance = 2;
    await nextTick();
    expect(store.config.stencilLip).toBe(15);
    expect(store.config.platterMargin).toBe(8);
    expect(store.config.platterMargin).toBe(effectivePlatterMargin(store.config));
    await store.undo();
    expect(store.config.platterMargin).toBeCloseTo(9.8);
    expect(store.canUndo).toBe(false);
    await store.redo();
    expect(store.config.platterMargin).toBe(8);
  });
});

describe('idempotent panel scope selection', () => {
  it.each([true, false])('retains edits, reviews and history when selecting the active board again (paste: %s)', async hasPads => {
    const store = useConfigStore();
    const session = useWorkSessionStore();
    await session.initialize();
    const first = variant(40), second = variant(72);
    store.applyGerberImport({ filename: 'mixed.zip', outlineSource: 'pads-bounds', isPanel: true, hasPads,
      mode: 'board', boardIndex: 0, variants: { panel: variant(120), single: first, boards: [first, second] } });
    await nextTick();
    store.config.stencilLip = 5;
    store.config.componentReliefEnabled = true;
    store.config.jigPrintSide = 'bottom';
    store.setComponentReliefRegions([{ id: 'pocket', shape: 'rect', x: 0, y: 0, width: 5, height: 5, depth: 3 }]);
    await nextTick();
    store.confirmStencilSizeReview();
    store.confirmOutlineEstimateReview();
    const c = store.config;
    const geometry = [c.pcbOutlinePoints, c.pcbOutlineHoles, c.stencilPadsTop, c.stencilPadsBottom];
    const plans = c.componentReliefRegions;
    const revisions = [store.stencilSizeReviewRevision, store.outlineReviewRevision];
    session.markExported(session.captureExport());

    store.setPanelBoard(0);
    store.setPanelMode('board');
    store.setPanelMode('single'); // Legacy requests normalize to the same board.
    await nextTick();
    expect(c.stencilLip).toBe(5);
    expect(c.componentReliefRegions).toBe(plans);
    expect(c.componentReliefEnabled).toBe(true);
    expect(c.jigPrintSide).toBe('bottom');
    for (const [index, value] of [c.pcbOutlinePoints, c.pcbOutlineHoles, c.stencilPadsTop, c.stencilPadsBottom].entries()) {
      expect(value).toBe(geometry[index]);
    }
    expect([store.stencilSizeReviewRevision, store.outlineReviewRevision]).toEqual(revisions);
    expect(store.stencilSizeReviewed).toBe(true);
    expect(store.outlineEstimateReviewed).toBe(true);
    expect(session.hasUnexportedChanges).toBe(false);
    expect(store.canUndo).toBe(true);
    await store.undo();
    expect(c.componentReliefEnabled).toBe(false);
    expect(c.componentReliefRegions).toEqual({ top: [], bottom: [] });
    expect(store.canUndo).toBe(false);
  });

  it('retains edited dimensions and history when selecting the active whole-panel scope again', async () => {
    const store = useConfigStore();
    const first = variant(40);
    store.applyGerberImport({ filename: 'mixed.gko', isPanel: true, hasPads: false, mode: 'panel',
      variants: { panel: variant(120), single: first, boards: [first, variant(72)] } });
    await nextTick();
    store.config.stencilLip = 5;
    await nextTick();
    store.confirmStencilSizeReview();
    const pads = store.config.stencilPadsTop;

    store.setPanelMode('panel');
    await nextTick();
    expect(store.config.stencilLip).toBe(5);
    expect(store.config.stencilPadsTop).toBe(pads);
    expect(store.stencilSizeReviewed).toBe(true);
    expect(store.canUndo).toBe(true);
    await store.undo();
    expect(store.config.stencilLip).toBe(5.9);
    expect(store.canUndo).toBe(false);
  });

  it('still applies a different board and resets board-specific edits and reviews', async () => {
    const store = useConfigStore();
    const first = variant(40), second = variant(72);
    store.applyGerberImport({ filename: 'mixed.zip', isPanel: true, hasPads: true, mode: 'board', boardIndex: 0,
      variants: { panel: variant(120), single: first, boards: [first, second] } });
    await nextTick();
    store.config.stencilLip = 5;
    store.config.componentReliefEnabled = true;
    store.setComponentReliefRegions([{ id: 'pocket', shape: 'rect', x: 0, y: 0, width: 5, height: 5, depth: 3 }]);
    await nextTick();
    store.confirmStencilSizeReview();

    store.setPanelBoard(1);
    await nextTick();
    expect(store.config.panelBoardIndex).toBe(1);
    expect(store.config.pcbSizeX).toBe(72);
    expect(store.config.stencilPadsTop).toEqual(second.topPads);
    expect(store.config.componentReliefEnabled).toBe(false);
    expect(store.config.componentReliefRegions).toEqual({ top: [], bottom: [] });
    expect(store.config.stencilLip).toBe(8.3);
    expect(store.stencilSizeReviewed).toBe(false);
    expect(store.canUndo).toBe(false);
  });

  it('applies a fresh import even when its normalized selection matches the current board', async () => {
    const store = useConfigStore();
    const first = variant(40);
    const payload = { filename: 'mixed.zip', isPanel: true, hasPads: true, mode: 'board' as const, boardIndex: 0,
      variants: { panel: variant(120), single: first, boards: [first, variant(72)] } };
    store.applyGerberImport(payload);
    await nextTick();
    store.config.stencilLip = 5;
    await nextTick();
    store.confirmStencilSizeReview();
    store.applyGerberImport(payload);
    await nextTick();
    expect(store.config.stencilLip).toBe(17.9);
    expect(store.stencilSizeReviewed).toBe(false);
    expect(store.canUndo).toBe(false);

    const replacement = variant(55);
    store.applyGerberImport({ ...payload, variants: { panel: payload.variants.panel,
      single: replacement, boards: [replacement, payload.variants.boards[1]] } });
    await nextTick();
    expect(store.config.pcbSizeX).toBe(55);
    expect(store.config.pcbOutlinePoints).toEqual(replacement.outlinePoints);
  });
});
