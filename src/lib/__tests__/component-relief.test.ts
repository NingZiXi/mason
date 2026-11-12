import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { nextTick } from 'vue';
import { DEFAULT, useConfigStore } from '../../stores/config';
import { useWorkSessionStore } from '../../stores/work-session';
import { activeReliefRegions, effectiveInsertHeight, orientBoardPads, orientBoardRing, reliefDepthRange, reliefRegionDepth,
  type ComponentReliefRegion } from '../component-relief';
import { buildScadParams, modelParamsHash, scadPartHash } from '../model-params';
import { pickPresetSettings, readPresetSettings } from '../config-presets';
import type { PadPolygon } from '../gerber/pads';

const rectangle = (id = 'chip', x = 4): ComponentReliefRegion => ({ id, shape: 'rect', x, y: 3, width: 8, height: 6 });
const circle = (): ComponentReliefRegion => ({ id: 'connector', shape: 'circle', x: -5, y: -3, width: 4, height: 4 });
const board = (width = 40) => ({ width, height: 30, center: { x: 0, y: 0 },
  outlinePoints: [[-width / 2, -15], [width / 2, -15], [width / 2, 15], [-width / 2, 15]] as Array<[number, number]>,
  outlineHoles: [], topPads: [], bottomPads: [] });
function importedBoard() {
  const store = useConfigStore(), panel = board(80), single = board(40);
  store.applyGerberImport({ filename: 'board.zip', isPanel: true, hasPads: false, mode: 'panel',
    variants: { panel, single, boards: [single, board(30)] } });
  return store;
}
function enabledBoard() {
  const store = importedBoard();
  store.config.componentReliefEnabled = true;
  store.setComponentReliefRegions([rectangle()]);
  return store;
}
beforeEach(() => setActivePinia(createPinia()));

describe('second-face component relief', () => {
  it('is optional and does not reuse board-specific shapes from another store', () => {
    const store = useConfigStore();
    expect(store.config.componentReliefEnabled).toBe(false);
    expect(buildScadParams(store.config).component_relief_regions).toEqual([]);
    expect(buildScadParams(store.config).jig_print_side).toBe('top');
    store.setComponentReliefRegions([rectangle()]);
    expect(DEFAULT.componentReliefRegions).toEqual({ top: [], bottom: [] });
  });

  it('keeps independent top-print and bottom-print pocket plans and sends only the active face', () => {
    const store = enabledBoard();
    store.config.jigPrintSide = 'bottom';
    expect(activeReliefRegions(store.config)).toEqual([]);
    store.setComponentReliefRegions([circle()]);
    expect(buildScadParams(store.config).component_relief_regions).toEqual([circle()]);
    expect(buildScadParams(store.config).jig_print_side).toBe('bottom');
    store.config.jigPrintSide = 'top';
    expect(buildScadParams(store.config).component_relief_regions).toEqual([rectangle()]);
  });

  it('adds material beneath tall pockets while preserving the selected nominal tray height', () => {
    const store = enabledBoard();
    store.config.componentReliefDepth = 10;
    expect(effectiveInsertHeight(store.config)).toBeCloseTo(12.8);
    expect(buildScadParams(store.config).insert_height).toBeCloseTo(12.8);
    expect(store.config.insertHeight).toBe(8);
    store.config.insertHeight = 16;
    expect(effectiveInsertHeight(store.config)).toBe(16);
    store.setComponentReliefRegions([]);
    expect(effectiveInsertHeight(store.config)).toBe(16);
  });

  it('sizes the tray from the deepest active region, independently of the new-region default or other face', () => {
    const store = enabledBoard();
    store.setComponentReliefRegions([{ ...rectangle(), depth: 2 }, { ...circle(), depth: 8 }]);
    expect(reliefDepthRange(activeReliefRegions(store.config), 20)).toEqual({ min: 2, max: 8 });
    expect(effectiveInsertHeight(store.config)).toBeCloseTo(10.8);
    store.setComponentReliefDefaultDepth(20);
    expect(effectiveInsertHeight(store.config)).toBeCloseTo(10.8);
    store.config.componentReliefRegions.bottom = [{ ...rectangle('other-side'), depth: 18 }];
    expect(effectiveInsertHeight(store.config)).toBeCloseTo(10.8);
    store.config.jigPrintSide = 'bottom';
    expect(effectiveInsertHeight(store.config)).toBeCloseTo(20.8);
  });

  it('does not thicken the tray for through cuts and reports only blind-pocket depths', () => {
    const store = enabledBoard();
    const through = { ...rectangle(), through: true, depth: 20 };
    store.setComponentReliefRegions([through]);
    expect(reliefDepthRange(activeReliefRegions(store.config), 3)).toBeNull();
    expect(effectiveInsertHeight(store.config)).toBe(8);
    expect(buildScadParams(store.config).component_relief_regions).toEqual([through]);
    store.setComponentReliefRegions([through, { ...circle(), depth: 8 }]);
    expect(reliefDepthRange(activeReliefRegions(store.config), 3)).toEqual({ min: 8, max: 8 });
    expect(effectiveInsertHeight(store.config)).toBeCloseTo(10.8);
  });

  it('invalidates preview/export for a through toggle, supports undo and ignores remembered inactive depth', async () => {
    const store = enabledBoard(), session = useWorkSessionStore();
    store.setComponentReliefRegions([{ ...rectangle(), depth: 10 }]);
    const blind = buildScadParams(store.config), blindHash = modelParamsHash(store.config);
    await session.initialize(); session.markExported(session.captureExport());
    await nextTick(); store.clearParameterHistory();
    store.setComponentReliefRegions([{ ...rectangle(), depth: 10, through: true }]);
    const through = buildScadParams(store.config), throughHash = modelParamsHash(store.config);
    expect(throughHash).not.toBe(blindHash);
    expect(scadPartHash(through, 'insert')).not.toBe(scadPartHash(blind, 'insert'));
    expect(effectiveInsertHeight(store.config)).toBe(8);
    expect(session.hasUnexportedChanges).toBe(true);
    store.setComponentReliefRegions([{ ...rectangle(), depth: 19, through: true }]);
    store.setComponentReliefDefaultDepth(18);
    expect(modelParamsHash(store.config)).toBe(throughHash);
    expect(scadPartHash(buildScadParams(store.config), 'insert')).toBe(scadPartHash(through, 'insert'));
    // A separate toggle interaction is sufficient to restore the physical cut.
    await nextTick(); store.clearParameterHistory();
    store.setComponentReliefRegions([{ ...rectangle(), depth: 19 }]);
    await store.undo();
    expect(activeReliefRegions(store.config)[0]).toMatchObject({ through: true, depth: 19 });
    await store.redo();
    expect(activeReliefRegions(store.config)[0].through).toBeUndefined();
    expect(effectiveInsertHeight(store.config)).toBeCloseTo(21.8);
  });

  it('keeps legacy depths on both faces when changing the default and supports undo/redo', async () => {
    const store = enabledBoard();
    store.config.componentReliefRegions.bottom = [circle()];
    await nextTick(); store.clearParameterHistory();
    store.setComponentReliefDefaultDepth(10);
    expect(store.config.componentReliefDepth).toBe(10);
    expect(store.config.componentReliefRegions.top[0].depth).toBe(3);
    expect(store.config.componentReliefRegions.bottom[0].depth).toBe(3);
    expect(effectiveInsertHeight(store.config)).toBe(8);
    await store.undo();
    expect(store.config.componentReliefDepth).toBe(3);
    expect(reliefRegionDepth(store.config.componentReliefRegions.top[0], 3)).toBe(3);
    await store.redo();
    expect(store.config.componentReliefDepth).toBe(10);
    expect(store.config.componentReliefRegions.top[0].depth).toBe(3);
  });

  it('changing a saved preset default preserves existing pocket depths', async () => {
    const store = enabledBoard();
    await store.applyUserSettings({ componentReliefDepth: 12 });
    expect(store.config.componentReliefDepth).toBe(12);
    expect(store.config.componentReliefRegions.top[0].depth).toBe(3);
    expect(effectiveInsertHeight(store.config)).toBe(8);
  });

  it('invalidates preview geometry for an individual depth edit, but not for a new-region default change', async () => {
    const store = enabledBoard(), session = useWorkSessionStore();
    store.setComponentReliefRegions([{ ...rectangle(), depth: 4 }, { ...circle(), depth: 9 }]);
    const original = buildScadParams(store.config), hash = modelParamsHash(store.config);
    store.setComponentReliefDefaultDepth(18);
    expect(modelParamsHash(store.config)).toBe(hash);
    expect(scadPartHash(buildScadParams(store.config), 'insert')).toBe(scadPartHash(original, 'insert'));
    await session.initialize(); session.markExported(session.captureExport());
    await nextTick(); store.clearParameterHistory();
    store.setComponentReliefRegions([{ ...rectangle(), depth: 7 }, { ...circle(), depth: 9 }]);
    const changed = buildScadParams(store.config);
    expect(modelParamsHash(store.config)).not.toBe(hash);
    expect(scadPartHash(changed, 'insert')).not.toBe(scadPartHash(original, 'insert'));
    expect(scadPartHash(changed, 'base')).toBe(scadPartHash(original, 'base'));
    expect(scadPartHash(changed, 'cover')).toBe(scadPartHash(original, 'cover'));
    expect(session.hasUnexportedChanges).toBe(true);
    await store.undo();
    expect(activeReliefRegions(store.config).map(region => region.depth)).toEqual([4, 9]);
    expect(session.hasUnexportedChanges).toBe(false);
  });

  it('disabling relief restores ordinary geometry without losing either face plan', () => {
    const store = enabledBoard();
    store.config.componentReliefDepth = 12;
    store.config.jigPrintSide = 'bottom';
    store.setComponentReliefRegions([circle()]);
    store.config.componentReliefEnabled = false;
    const params = buildScadParams(store.config);
    expect(params.insert_height).toBe(8);
    expect(params.component_relief_enabled).toBe(false);
    expect(params.component_relief_regions).toEqual([]);
    expect(params.jig_print_side).toBe('top');
    expect(store.config.componentReliefRegions.bottom).toEqual([circle()]);
  });

  it('resets manufacturing defaults without discarding board-specific relief work on either face', async () => {
    const store = enabledBoard();
    store.config.componentReliefDepth = 9;
    store.config.jigPrintSide = 'bottom';
    store.setComponentReliefRegions([circle()]);
    store.config.insertHeight = 16;
    const outline = store.config.pcbOutlinePoints;
    await nextTick();
    store.clearParameterHistory();

    store.reset();
    await nextTick();
    expect(store.config.insertHeight).toBe(8);
    expect(store.config.componentReliefDepth).toBe(3);
    expect(store.config.componentReliefEnabled).toBe(true);
    expect(store.config.jigPrintSide).toBe('bottom');
    expect(store.config.componentReliefRegions.top).toEqual([{ ...rectangle(), depth: 9 }]);
    expect(store.config.componentReliefRegions.bottom).toEqual([{ ...circle(), depth: 9 }]);
    expect(store.config.pcbOutlinePoints).toBe(outline);
    expect(effectiveInsertHeight(store.config)).toBeCloseTo(11.8);

    await store.undo();
    expect(store.config.insertHeight).toBe(16);
    expect(store.config.componentReliefDepth).toBe(9);
    expect(store.config.componentReliefRegions.bottom).toEqual([circle()]);
    await store.redo();
    expect(store.config.componentReliefEnabled).toBe(true);
    expect(store.config.componentReliefRegions.bottom).toEqual([{ ...circle(), depth: 9 }]);
  });

  it('invalidates the tray for region edits and depth, without rebuilding unchanged frames', () => {
    const store = enabledBoard();
    const original = buildScadParams(store.config), hash = modelParamsHash(store.config);
    store.setComponentReliefRegions([rectangle('chip', 6)]);
    store.config.componentReliefDepth = 10;
    const changed = buildScadParams(store.config);
    expect(modelParamsHash(store.config)).not.toBe(hash);
    expect(scadPartHash(changed, 'insert')).not.toBe(scadPartHash(original, 'insert'));
    for (const part of ['base', 'cover']) expect(scadPartHash(changed, part)).toBe(scadPartHash(original, part));
    const flipped = { ...changed, jig_print_side: 'bottom' as const };
    for (const part of ['insert', 'base', 'cover']) expect(scadPartHash(flipped, part)).not.toBe(scadPartHash(changed, part));
  });

  it('leaves independent printed stencils and their cache keys unaffected', () => {
    const store = enabledBoard();
    store.setMode('stencil');
    const original = buildScadParams(store.config), hash = modelParamsHash(store.config);
    store.config.componentReliefDepth = 15;
    store.config.jigPrintSide = 'bottom';
    store.setComponentReliefRegions([circle()]);
    const changed = buildScadParams(store.config);
    expect(changed.component_relief_enabled).toBe(false);
    expect(changed.component_relief_regions).toEqual([]);
    expect(changed.insert_height).toBe(8);
    expect(changed.jig_print_side).toBe('top');
    expect(modelParamsHash(store.config)).toBe(hash);
    for (const part of ['stencil_top', 'stencil_bottom']) expect(scadPartHash(changed, part)).toBe(scadPartHash(original, part));
    store.setMode('jig');
    expect(activeReliefRegions(store.config)).toEqual([circle()]);
  });

  it.each(['new import', 'panel scope', 'child board'] as const)('clears stale pocket coordinates after %s', async action => {
    const store = enabledBoard();
    await nextTick();
    if (action === 'new import') {
      const variant = board(50);
      store.applyGerberImport({ filename: 'another.zip', isPanel: false, hasPads: false, mode: 'panel',
        variants: { panel: variant, single: variant } });
    } else if (action === 'panel scope') store.setPanelMode('board');
    else store.setPanelBoard(1);
    expect(store.config.componentReliefEnabled).toBe(false);
    expect(store.config.jigPrintSide).toBe('top');
    expect(store.config.componentReliefRegions).toEqual({ top: [], bottom: [] });
    await nextTick();
    expect(store.canUndo).toBe(false);
  });

  it('supports undo/redo for immutable region edits, face selection and derived tray thickness', async () => {
    const store = enabledBoard();
    await nextTick();
    store.clearParameterHistory();
    store.beginParameterInteraction();
    store.setComponentReliefRegions([rectangle(), circle()]);
    await nextTick();
    store.endParameterInteraction();
    await store.undo();
    expect(activeReliefRegions(store.config)).toEqual([rectangle()]);
    await store.redo();
    expect(activeReliefRegions(store.config)).toHaveLength(2);
    store.clearParameterHistory();
    store.config.componentReliefDepth = 10;
    await store.undo();
    expect(effectiveInsertHeight(store.config)).toBe(8);
    await store.redo();
    expect(effectiveInsertHeight(store.config)).toBeCloseTo(12.8);
  });

  it('stores reusable depth in presets but excludes relief shapes, active side and enablement', () => {
    const store = enabledBoard();
    store.config.componentReliefDepth = 6;
    const settings = pickPresetSettings(store.config);
    expect(settings.componentReliefDepth).toBe(6);
    expect(settings).not.toHaveProperty('componentReliefRegions');
    expect(settings).not.toHaveProperty('jigPrintSide');
    expect(settings).not.toHaveProperty('componentReliefEnabled');
    expect(readPresetSettings({}, DEFAULT).componentReliefDepth).toBe(3);
    expect(() => readPresetSettings({ componentReliefDepth: 30 }, DEFAULT)).toThrow('presets.invalidData');
  });

  it('restores polygon vertices through undo/redo and passes the real shape to the engine', async () => {
    const store = enabledBoard();
    const polygon: ComponentReliefRegion = { id: 'L', shape: 'polygon', x: 0, y: 0, width: 10, height: 10,
      points: [[-5, -5], [5, -5], [5, 0], [0, 0], [0, 5], [-5, 5]] };
    await nextTick();
    store.clearParameterHistory();
    store.beginParameterInteraction();
    store.setComponentReliefRegions([polygon]);
    await nextTick();
    store.endParameterInteraction();
    expect(buildScadParams(store.config).component_relief_regions[0].points).toEqual(polygon.points);
    await store.undo();
    expect(activeReliefRegions(store.config)).toEqual([rectangle()]);
    // History must own its vertices, even if a caller later reuses its input.
    polygon.points![0][0] = -8;
    await store.redo();
    expect(activeReliefRegions(store.config)[0].points![0]).toEqual([-5, -5]);
  });

  it('marks unexported edits by value, and returns to clean after undo', async () => {
    const store = enabledBoard(), session = useWorkSessionStore();
    await session.initialize();
    session.markExported(session.captureExport());
    store.clearParameterHistory();
    store.setComponentReliefRegions([rectangle('chip', 6)]);
    await nextTick();
    expect(session.hasUnexportedChanges).toBe(true);
    await store.undo();
    expect(session.hasUnexportedChanges).toBe(false);
    store.config.componentReliefRegions.top[0].width = 10;
    expect(session.hasUnexportedChanges).toBe(true);
  });

  it('mirrors pad bodies, centres and internal holes without modifying imported data', () => {
    const pads: PadPolygon[] = [{ type: 'rect', cx: 2, cy: 3, polarity: 'D', parts: [{ polarity: 'D',
      points: [[1, 2], [3, 2], [3, 4]], holes: [[[1.5, 2.5], [2, 2.5], [2, 3]]] }] }];
    const original = JSON.stringify(pads);
    const result = orientBoardPads(pads, 'bottom');
    expect(result[0].cy).toBe(-3);
    expect(result[0].parts[0].points[0]).toEqual([1, -2]);
    expect(result[0].parts[0].holes![0][0]).toEqual([1.5, -2.5]);
    expect(JSON.stringify(pads)).toBe(original);
    expect(orientBoardRing([[2, 3]], 'top')).toEqual([[2, 3]]);
  });
});
