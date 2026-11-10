import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useConfigStore } from '../../stores/config';
import { reviewOutlineForExport } from '../outline-export-review';
import { exportReadiness } from '../export-readiness';

const variant = { width: 30, height: 20, center: { x: 0, y: 0 },
  outlinePoints: [[-15, -10], [15, -10], [15, 10], [-15, 10]] as [number, number][], outlineHoles: [] };
function importBoard(source: 'gerber' | 'pads-bounds' = 'pads-bounds') {
  const store = useConfigStore();
  store.applyGerberImport({ filename: 'pads.gtp', outlineSource: source,
    outlineFallbackReason: source === 'pads-bounds' ? 'missing' : undefined,
    isPanel: false, hasPads: false, mode: 'panel', variants: { panel: variant, single: variant } });
  return store;
}
beforeEach(() => setActivePinia(createPinia()));

describe('estimated board outline review', () => {
  it('asks once for the current board without making its outline authoritative', async () => {
    const store = importBoard();
    const prompt = vi.fn(async () => true);
    expect(await reviewOutlineForExport(store, prompt)).toBe('ready');
    expect(prompt).toHaveBeenCalledWith({ x: 30, y: 20 });
    expect(store.outlineEstimateReviewed).toBe(true);
    expect(store.gerberOutlineSource).toBe('pads-bounds');
    expect(await reviewOutlineForExport(store, prompt)).toBe('ready');
    expect(prompt).toHaveBeenCalledOnce();
  });
  it('skips the warning for actual Gerber outlines', async () => {
    const store = importBoard('gerber'), prompt = vi.fn(async () => true);
    expect(await reviewOutlineForExport(store, prompt)).toBe('ready');
    expect(prompt).not.toHaveBeenCalled();
    expect(store.gerberOutlineFallbackReason).toBeNull();
  });
  it('requires acknowledgement in both manufacturing modes and respects cancellation', async () => {
    const store = importBoard();
    expect(await reviewOutlineForExport(store, async () => false)).toBe('cancelled');
    expect(store.outlineEstimateReviewed).toBe(false);
    store.setMode('stencil');
    expect(await reviewOutlineForExport(store, async () => false)).toBe('cancelled');
  });
  it('rejects old confirmation if the same file is imported again while the dialog is open', async () => {
    const store = importBoard();
    expect(await reviewOutlineForExport(store, async () => { importBoard(); return true; })).toBe('changed');
    expect(store.outlineEstimateReviewed).toBe(false);
  });
  it('invalidates review for dimension changes, even when changed back, and mode changes', async () => {
    const store = importBoard();
    expect(await reviewOutlineForExport(store, async () => {
      store.config.pcbSizeX += 1; store.config.pcbSizeX -= 1; return true;
    })).toBe('changed');
    await reviewOutlineForExport(store, async () => true);
    store.setMode('stencil');
    expect(store.outlineEstimateReviewed).toBe(false);
  });
  it('does not acknowledge after disposal or a newly started native file read', async () => {
    const store = importBoard(); let active = true;
    expect(await reviewOutlineForExport(store, async () => { active = false; return true; }, () => active)).toBe('disposed');
    expect(store.outlineEstimateReviewed).toBe(false);
    store.gerberImporting = true;
    expect(exportReadiness(store, true)).toBe('importing');
  });
  it('clears metadata on reset and rechecks all guards after the final export dialog', async () => {
    const store = importBoard();
    await reviewOutlineForExport(store, async () => true);
    store.confirmStencilSizeReview();
    expect(exportReadiness(store, true)).toBe('ready');
    store.gerberImporting = true;
    expect(exportReadiness(store, true)).toBe('importing');
    store.gerberImporting = false;
    importBoard();
    expect(exportReadiness(store, true)).toBe('outline');
    await reviewOutlineForExport(store, async () => true);
    expect(exportReadiness(store, true)).toBe('sheet');
    store.clearPanelScope();
    expect(store.gerberOutlineSource).toBeNull();
    expect(store.gerberOutlineFallbackReason).toBeNull();
    expect(exportReadiness(store, false)).toBe('empty');
  });
});
