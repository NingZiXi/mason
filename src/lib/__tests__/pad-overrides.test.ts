import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { nextTick } from 'vue';
import { useConfigStore } from '../../stores/config';
import { makePanelVariant } from '../gerber/panel';
import { extractPads } from '../gerber/pads';
import { buildScadParams, scadPartHash } from '../model-params';
import { pickPresetSettings } from '../config-presets';
import { setPadOverrides } from '../pad-overrides';

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
  it('bounds exact matching work for dense offset macros sharing one flash origin', () => {
    const count = 2000;
    const commands = ['%FSLAX34Y34*%', '%MOMM*%'];
    for (let i = 0; i < count; i++) commands.push(
      `%AMM${i}*21,1,0.2,0.2,${i % 100 + .5},${Math.floor(i / 100) + .5},0*%`,
      `%ADD${i + 10}M${i}*%`, `D${i + 10}*`, 'X0Y0D03*',
    );
    const source = extractPads(commands.concat('M02*').join('\n')).pads;
    const outline = { points: [[0, 0], [100, 0], [100, 20], [0, 20]] as [number, number][],
      holes: [], bbox: { minX: 0, minY: 0, maxX: 100, maxY: 20 } };
    const panel = makePanelVariant(outline, source, []), single = makePanelVariant(outline, source, []);
    let exactReads = 0;
    for (const pad of single.topPads!) {
      const type = pad.type;
      Object.defineProperty(pad, 'type', { enumerable: true, get: () => { exactReads++; return type; } });
    }
    setPadOverrides(panel.topPads!, source.map((_, index) => index), 'closed', 'top',
      { panel, single, hasPads: true }, panel);
    expect(single.topPads!.every(pad => pad.apertureOverride === 'closed')).toBe(true);
    // A geometry getter counts exact candidate checks without a flaky clock
    // threshold. Independent macro positions must not share one huge bucket.
    expect(exactReads).toBeLessThan(count * 4);
  });

  it('matches centered multipart macros using dark geometry while retaining holes and clear parts', () => {
    const source = extractPads([
      '%FSLAX34Y34*%', '%MOMM*%',
      '%AMOFFSET*21,1,2,2,5,5,0*21,0,2,2,1000,0,0*21,1,1,1,8,5,0*%',
      '%ADD10OFFSET*%', '%ADD11R,2X2X0.5*%',
      'D10*', 'X0Y0D03*', 'X0Y0D03*', 'D11*', 'X70000Y70000D03*', 'M02*',
    ].join('\n')).pads;
    const shape = (x: number, width: number) => ({
      points: [[x, 0], [x + width, 0], [x + width, 20], [x, 20]] as [number, number][], holes: [],
      bbox: { minX: x, minY: 0, maxX: x + width, maxY: 20 },
    });
    const panel = makePanelVariant(shape(0, 40), source, []), single = makePanelVariant(shape(0, 20), source, []);
    const holeMismatch = structuredClone(single.topPads![2]);
    holeMismatch.parts[0].holes![0][0][0] += .05;
    single.topPads!.push(holeMismatch);
    const clearMismatch = structuredClone(single.topPads![0]);
    clearMismatch.parts[1].polarity = 'D';
    single.topPads!.push(clearMismatch);
    setPadOverrides(panel.topPads!, [0, 2], 'closed', 'top', { panel, single, hasPads: true }, panel);
    expect(single.topPads!.map(pad => pad.apertureOverride)).toEqual(['closed', 'closed', 'closed', undefined, undefined]);
    expect(single.topPads![2].parts[0].holes).toHaveLength(1);
    setPadOverrides(single.topPads!, [0], undefined, 'top', { panel, single, hasPads: true }, single);
    expect(panel.topPads!.map(pad => pad.apertureOverride)).toEqual([undefined, undefined, 'closed']);
  });

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
