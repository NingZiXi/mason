import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { nextTick } from 'vue';
import { useConfigStore } from '../../stores/config';
import { reviewStencilSizeForExport } from '../stencil-export-review';

beforeEach(() => setActivePinia(createPinia()));

describe('sheet size review before export', () => {
  it('asks even for an unimported, manually configured jig and acknowledges the displayed dimensions', async () => {
    const store = useConfigStore();
    store.config.stencilSizeX = 150;
    store.config.stencilSizeY = 100;
    const prompt = vi.fn(async () => true);
    expect(await reviewStencilSizeForExport(store, prompt)).toBe('ready');
    expect(prompt).toHaveBeenCalledWith({ x: 150, y: 100 });
    expect(store.stencilSizeReviewed).toBe(true);
    expect(await reviewStencilSizeForExport(store, prompt)).toBe('ready');
    expect(prompt).toHaveBeenCalledOnce();
  });

  it('uses the sidebar acknowledgement for every export format without another dialog', async () => {
    const store = useConfigStore();
    store.confirmStencilSizeReview();
    const prompt = vi.fn(async () => true);
    expect(await reviewStencilSizeForExport(store, prompt)).toBe('ready');
    expect(await reviewStencilSizeForExport(store, prompt)).toBe('ready');
    expect(prompt).not.toHaveBeenCalled();
  });

  it('does not acknowledge or permit an export on cancellation or dialog close', async () => {
    const store = useConfigStore();
    expect(await reviewStencilSizeForExport(store, async () => false)).toBe('cancelled');
    expect(store.stencilSizeReviewed).toBe(false);
  });

  it('does not ask about an external metal sheet when exporting a printable PCB stencil', async () => {
    const store = useConfigStore(); store.setMode('stencil');
    const prompt = vi.fn(async () => true);
    expect(await reviewStencilSizeForExport(store, prompt)).toBe('ready');
    expect(prompt).not.toHaveBeenCalled();
    expect(store.stencilSizeReviewed).toBe(false);
  });

  it.each(['stencilSizeX', 'stencilSizeY'] as const)('immediately invalidates confirmation when %s changes', async key => {
    const store = useConfigStore(); store.confirmStencilSizeReview();
    store.config[key] += 10;
    expect(store.stencilSizeReviewed).toBe(false);
    expect(await reviewStencilSizeForExport(store, async () => true)).toBe('ready');
  });

  it('retains confirmation for unrelated parameter edits and mode switches with the same sheet', async () => {
    const store = useConfigStore(); store.confirmStencilSizeReview();
    store.config.stencilLip -= 1;
    store.config.pcbThickness = 2;
    store.config.screwSpacing = 30;
    store.setMode('stencil'); store.setMode('jig'); await nextTick();
    expect(store.stencilSizeReviewed).toBe(true);
  });

  it('requires a fresh review after importing the same file again with identical geometry objects', () => {
    const store = useConfigStore();
    const variant = { width: 50, height: 50, center: { x: 0, y: 0 },
      outlinePoints: [[-25, -25], [25, -25], [25, 25], [-25, 25]] as [number, number][], outlineHoles: [] };
    const payload = { filename: 'same.zip', isPanel: false, hasPads: false, mode: 'panel' as const,
      variants: { panel: variant, single: variant } };
    store.applyGerberImport(payload);
    store.confirmStencilSizeReview();
    store.applyGerberImport(payload);
    expect(store.stencilSizeReviewed).toBe(false);
  });

  it('rejects an old dialog confirmation if dimensions change while it is open, even if changed back', async () => {
    const store = useConfigStore();
    const result = await reviewStencilSizeForExport(store, async () => {
      const before = store.config.stencilSizeX;
      store.config.stencilSizeX += 5;
      store.config.stencilSizeX = before;
      return true;
    });
    expect(result).toBe('changed');
    expect(store.stencilSizeReviewed).toBe(false);
  });

  it('rejects confirmation of the previous work if a new Gerber is imported during the dialog', async () => {
    const store = useConfigStore();
    expect(await reviewStencilSizeForExport(store, async () => {
      const variant = { width: 50, height: 50, center: { x: 0, y: 0 },
        outlinePoints: [[-25, -25], [25, -25], [25, 25], [-25, 25]] as [number, number][], outlineHoles: [] };
      store.applyGerberImport({ filename: 'new.zip', isPanel: false, hasPads: false, mode: 'panel',
        variants: { panel: variant, single: variant } });
      return true;
    })).toBe('changed');
    expect(store.stencilSizeReviewed).toBe(false);
  });

  it('does not continue a pending export after the preview unmounts', async () => {
    const store = useConfigStore(); let active = true;
    expect(await reviewStencilSizeForExport(store, async () => { active = false; return true; }, () => active)).toBe('disposed');
    expect(store.stencilSizeReviewed).toBe(false);
  });
});
