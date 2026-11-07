import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { nextTick } from 'vue';
import { useConfigStore } from '../../stores/config';
import { makePanelVariant } from '../gerber/panel';
import { extractPads } from '../gerber/pads';
import { buildScadParams, scadPartHash } from '../model-params';
import { pickPresetSettings } from '../config-presets';

beforeEach(() => setActivePinia(createPinia()));

function setup() {
  const pads = extractPads('%FSLAX45Y45*%\n%MOMM*%\n%ADD10C,1.8*%\nD10*\nX1000000Y1000000D03*\nX3000000Y1000000D03*\nM02*').pads;
  const outline = (x: number, width: number) => ({ points: [[x, 0], [x + width, 0], [x + width, 20], [x, 20]] as [number, number][],
    holes: [], bbox: { minX: x, minY: 0, maxX: x + width, maxY: 20 } });
  const panel = makePanelVariant(outline(0, 40), pads, pads);
  const first = makePanelVariant(outline(0, 20), pads, pads), second = makePanelVariant(outline(20, 20), pads, pads);
  const store = useConfigStore();
  store.applyGerberImport({ filename: 'mixed.zip', isPanel: true, hasPads: true, mode: 'panel',
    variants: { panel, single: first, boards: [first, second] } });
  return store;
}

describe('manual aperture decisions', () => {
  it('keeps duplicate flashes of the same physical pad consistent in the active scope', () => {
    const store = setup();
    const top = store.config.stencilPadsTop;
    top.push({ ...top[0] });
    store.setApertureOverrides('top', [0], 'closed');
    expect(top.map(pad => pad.apertureOverride)).toEqual(['closed', undefined, 'closed']);
    expect(store.config.stencilPadsBottom.every(pad => !pad.apertureOverride)).toBe(true);
  });
  it('applies and undoes a whole selection in one step, including panel synchronization', async () => {
    const store = setup();
    await nextTick();
    const geometry = store.config.stencilPadsTop;
    store.setApertureOverrides('top', [0, 1, 1, -1, 1000, 0.5], 'closed');
    await nextTick();
    expect(geometry.map(pad => pad.apertureOverride)).toEqual(['closed', 'closed']);
    expect(store.panelBoards.map(board => board.topPads![0].apertureOverride)).toEqual(['closed', 'closed']);
    await store.undo();
    expect(geometry.every(pad => !pad.apertureOverride)).toBe(true);
    expect(store.canUndo).toBe(false);
    expect(store.panelBoards.every(board => !board.topPads![0].apertureOverride)).toBe(true);
    await store.redo();
    expect(store.config.stencilPadsTop).toBe(geometry);
    expect(geometry.map(pad => pad.apertureOverride)).toEqual(['closed', 'closed']);
    store.setApertureOverrides('top', [0, 1]);
    await store.undo();
    expect(geometry.map(pad => pad.apertureOverride)).toEqual(['closed', 'closed']);
    expect(store.config.stencilPadsBottom.every(pad => !pad.apertureOverride)).toBe(true);
  });
  it('updates only the matching physical pad across differently centered panel scopes', async () => {
    const store = setup();
    store.setApertureOverride('top', 1, 'closed');
    expect(store.config.stencilPadsTop.map(p => p.apertureOverride)).toEqual([undefined, 'closed']);
    expect(store.config.stencilPadsBottom.every(p => !p.apertureOverride)).toBe(true);
    store.setPanelBoard(0);
    expect(store.config.stencilPadsTop[0].apertureOverride).toBeUndefined();
    store.setPanelBoard(1);
    expect(store.config.stencilPadsTop[0].apertureOverride).toBe('closed');
    store.setApertureOverride('top', 0, 'open');
    store.setPanelMode('panel');
    expect(store.config.stencilPadsTop.map(p => p.apertureOverride)).toEqual([undefined, 'open']);
    store.setPanelBoard(1);
    store.resetApertureOverrides('top');
    store.setPanelMode('panel');
    expect(store.config.stencilPadsTop.every(p => !p.apertureOverride)).toBe(true);
    expect(pickPresetSettings(store.config)).not.toHaveProperty('stencilPadsTop');
  });

  it('undoes and redoes individual choices and a side reset without copying geometry', async () => {
    const store = setup();
    await nextTick();
    const geometry = store.config.stencilPadsTop;
    store.setApertureOverride('top', 0, 'open');
    await nextTick();
    store.setApertureOverride('top', 1, 'closed');
    await store.undo();
    expect(store.config.stencilPadsTop.map(p => p.apertureOverride)).toEqual(['open', undefined]);
    expect(store.config.stencilPadsTop).toBe(geometry);
    await store.redo();
    expect(store.config.stencilPadsTop[1].apertureOverride).toBe('closed');
    store.resetApertureOverrides('top');
    await store.undo();
    expect(store.config.stencilPadsTop.map(p => p.apertureOverride)).toEqual(['open', 'closed']);
    await store.redo();
    expect(store.config.stencilPadsTop.every(p => !p.apertureOverride)).toBe(true);
  });

  it('transports decisions to the engine and invalidates only the correct stencil side', () => {
    const store = setup();
    const before = buildScadParams(store.config);
    store.setApertureOverride('top', 0, 'open');
    const after = buildScadParams(store.config);
    expect(after.stencil_pads_top[0].apertureOverride).toBe('open');
    expect(scadPartHash(after, 'stencil_top')).not.toBe(scadPartHash(before, 'stencil_top'));
    expect(scadPartHash(after, 'stencil_bottom')).toBe(scadPartHash(before, 'stencil_bottom'));
    expect(scadPartHash(after, 'insert')).toBe(scadPartHash(before, 'insert'));
    store.applyGerberImport({ filename: 'new.zip', isPanel: false, hasPads: true, mode: 'panel',
      variants: { panel: makePanelVariant({ points: [[0, 0], [20, 0], [0, 20]], holes: [],
        bbox: { minX: 0, minY: 0, maxX: 20, maxY: 20 } }, [], []), single: store.panelOverview! } });
    expect(store.config.stencilPadsTop).toEqual([]);
  });

  it('ignores attempts to edit Gerber clear shapes', async () => {
    const store = setup();
    store.config.stencilPadsTop[0].polarity = 'C';
    store.setApertureOverride('top', 0, 'open');
    expect(store.config.stencilPadsTop[0].apertureOverride).toBeUndefined();
  });
});
