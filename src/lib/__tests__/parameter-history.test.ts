import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { effectScope, nextTick, reactive } from "vue";
import { DEFAULT, useConfigStore } from "../../stores/config";
import { usePresetsStore } from "../../stores/presets";
import { useParameterHistory } from '../../composables/useParameterHistory';
import type { PadPolygon } from '../gerber/pads';
import type { PanelVariant } from "../gerber/panel";
import { pickPresetSettings, PRESETS_STORAGE_KEY } from "../config-presets";
import { parameterHistoryShortcut } from "../history-shortcuts";

beforeEach(() => {
  setActivePinia(createPinia());
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const variant = (width: number): PanelVariant => ({
  width, height: 30, center: { x: 0, y: 0 },
  outlinePoints: [[-width / 2, -15], [width / 2, -15], [width / 2, 15]],
  outlineHoles: [], topPads: [{ type: "rect", cx: 0, cy: 0, polarity: "D", parts: [] }], bottomPads: [],
});
const imported = () => ({ filename: "board.zip", isPanel: true, hasPads: true, mode: "panel" as const,
  variants: { panel: variant(90), single: variant(30) } });

describe("parameter undo and redo", () => {
  it('reuses both relief plans across scalar history steps and still observes in-place vertices', async () => {
    let reads = 0;
    let x = -5;
    const point: [number, number] = [-5, -5];
    Object.defineProperty(point, '0', { get() { ++reads; return x; }, set(value) { x = value; }, enumerable: true });
    const config = reactive({ ...DEFAULT, componentReliefRegions: {
      top: [{ id: 'top', shape: 'polygon' as const, x: 0, y: 0, width: 10, height: 10,
        depth: 3, points: [point, [5, -5] as [number, number], [5, 5] as [number, number], [-5, 5] as [number, number]] }],
      bottom: [{ id: 'bottom', shape: 'rect' as const, x: 0, y: 0, width: 4, height: 4, depth: 2 }],
    } });
    const scope = effectScope();
    const history = scope.run(() => useParameterHistory({ config: () => config, context: () => [],
      restore: async snapshot => {
        const { apertures, ...parameters } = snapshot;
        Object.assign(config, parameters);
        await nextTick();
      },
    }))!;
    try {
      const initialReads = reads;
      expect(initialReads).toBeGreaterThan(0);
      for (const value of [8, 12, 16]) {
        vi.advanceTimersByTime(800);
        config.ejectHoleDiameter = value;
        await nextTick();
      }
      expect(reads).toBe(initialReads);
      config.componentReliefRegions.top[0].points[0][0] = -4;
      await nextTick();
      expect(reads).toBeGreaterThan(initialReads);
      await history.undo();
      expect(config.componentReliefRegions.top[0].points[0][0]).toBe(-5);
      expect(config.componentReliefRegions.bottom[0].depth).toBe(2);
      expect(config.ejectHoleDiameter).toBe(16);
      await history.redo();
      expect(config.componentReliefRegions.top[0].points[0][0]).toBe(-4);
      expect(config.componentReliefRegions.bottom[0].depth).toBe(2);
    } finally { scope.stop(); }
  });

  it('does not expose stored relief plans or opening decisions to restore callbacks', async () => {
    const config = reactive({ ...DEFAULT, componentReliefRegions: { top: [
      { id: 'top', shape: 'rect' as const, x: 0, y: 0, width: 10, height: 10, depth: 3 },
    ], bottom: [] }, stencilPadsTop: [
      { type: 'rect' as const, cx: 0, cy: 0, polarity: 'D' as const, parts: [], apertureOverride: 'closed' as const },
    ] });
    let restored: Parameters<Parameters<typeof useParameterHistory>[0]['restore']>[0] | undefined;
    const scope = effectScope();
    const history = scope.run(() => useParameterHistory({ config: () => config, context: () => [],
      restore: async snapshot => {
        restored = snapshot;
        // The caller is free to retain and later mutate the received object.
        config.componentReliefRegions = JSON.parse(JSON.stringify(snapshot.componentReliefRegions));
        config.ejectHoleDiameter = snapshot.ejectHoleDiameter;
        await nextTick();
      },
    }))!;
    try {
      config.ejectHoleDiameter = 12;
      await nextTick();
      await history.undo();
      restored!.componentReliefRegions.top[0].depth = 19;
      restored!.apertures.top[0][1] = 'open';
      await history.redo();
      await history.undo();
      expect(restored!.componentReliefRegions.top[0].depth).toBe(3);
      expect(restored!.apertures.top).toEqual([[0, 'closed']]);
      expect(config.componentReliefRegions.top[0].depth).toBe(3);
    } finally { scope.stop(); }
  });

  it('reuses sparse opening decisions during parameter edits while still recording in-place opening changes', async () => {
    let reads = 0;
    let decision: PadPolygon['apertureOverride'];
    const pad: PadPolygon = { type: 'rect', cx: 0, cy: 0, polarity: 'D', parts: [],
      get apertureOverride() { ++reads; return decision; },
      set apertureOverride(value) { decision = value; },
    };
    const config = reactive({ ...DEFAULT, stencilPadsTop: [pad], stencilPadsBottom: [] as PadPolygon[] });
    const scope = effectScope();
    const history = scope.run(() => useParameterHistory({
      config: () => config, context: () => [],
      restore: async snapshot => {
        config.ejectHoleDiameter = snapshot.ejectHoleDiameter;
        config.stencilPadsTop[0].apertureOverride = snapshot.apertures.top[0]?.[1];
        await nextTick();
      },
    }))!;
    try {
      const initialReads = reads;
      config.ejectHoleDiameter = 8;
      await nextTick();
      config.ejectHoleDiameter = 12;
      await nextTick();
      expect(reads).toBe(initialReads);

      config.stencilPadsTop[0].apertureOverride = 'closed';
      await nextTick();
      expect(reads).toBeGreaterThan(initialReads);
      await history.undo();
      expect(decision).toBeUndefined();
      expect(config.ejectHoleDiameter).toBe(12);
      await history.redo();
      expect(decision).toBe('closed');
      const restoredReads = reads;
      config.ejectHoleDiameter = 16;
      await nextTick();
      expect(reads).toBe(restoredReads);
    } finally { scope.stop(); }
  });

  it("undoes immediately, restores linked values and supports redo", async () => {
    const store = useConfigStore();
    const initial = store.config.stencilSizeX;
    const jigSize = store.config.jigSize;
    store.config.stencilSizeX = 150;
    await store.undo(); // No debounce delay or nextTick needed by the caller.
    expect(store.config.stencilSizeX).toBe(initial);
    expect(store.config.jigSize).toBe(jigSize);
    expect(store.canUndo).toBe(false);
    expect(store.canRedo).toBe(true);
    await store.redo();
    expect(store.config.stencilSizeX).toBe(150);
    expect(store.config.jigSize).toBeGreaterThan(jigSize);
  });

  it("restores screw specification and custom hole/nut overrides together", async () => {
    const store = useConfigStore();
    Object.assign(store.config, { periScrewD: 3.4, nutAcrossFlats: 5.8, nutHeight: 2.8 });
    await nextTick();
    store.clearParameterHistory();
    store.config.screwSpec = "M5";
    await nextTick();
    expect(store.config.periScrewD).toBe(5.3);
    await store.undo();
    expect(store.config.screwSpec).toBe("M3");
    expect(store.config.periScrewD).toBe(3.4);
    expect(store.config.nutAcrossFlats).toBe(5.8);
    expect(store.config.nutHeight).toBe(2.8);
    expect(store.canUndo).toBe(false);
    await store.redo();
    expect(store.config.screwSpec).toBe("M5");
    expect(store.config.nutAcrossFlats).toBe(8);
  });

  it("coalesces rapid edits to the same parameter but separates other fields", async () => {
    const store = useConfigStore();
    store.config.baseHeight = 5;
    await nextTick();
    vi.advanceTimersByTime(200);
    store.config.baseHeight = 6;
    await nextTick();
    store.config.topCoverHeight = 7;
    await nextTick();
    await store.undo();
    expect(store.config.baseHeight).toBe(6);
    expect(store.config.topCoverHeight).toBe(4);
    await store.undo();
    expect(store.config.baseHeight).toBe(4);
    expect(store.config.platterHeight).toBe(4);
    expect(store.canUndo).toBe(false);
  });

  it("keeps a slow slider drag in one step, then separates the next drag", async () => {
    const store = useConfigStore();
    store.beginParameterInteraction();
    store.config.stencilLip = 12;
    await nextTick();
    vi.advanceTimersByTime(1500);
    store.config.stencilLip = 10;
    await nextTick();
    store.endParameterInteraction();
    store.beginParameterInteraction();
    store.config.stencilLip = 8;
    await nextTick();
    store.endParameterInteraction();
    await store.undo();
    expect(store.config.stencilLip).toBe(10);
    await store.undo();
    expect(store.config.stencilLip).toBe(15);
    expect(store.canUndo).toBe(false);
  });

  it("records a later edit separately and discards redo after a new edit", async () => {
    const store = useConfigStore();
    store.config.baseHeight = 5;
    await nextTick();
    vi.advanceTimersByTime(800);
    store.config.baseHeight = 6;
    await store.undo();
    expect(store.config.baseHeight).toBe(5);
    store.config.insertHeight = 10;
    await nextTick();
    expect(store.canRedo).toBe(false);
    await store.redo();
    expect(store.config.baseHeight).toBe(5);
  });

  it("does not leave an empty undo step after dragging back to the starting value", async () => {
    const store = useConfigStore();
    store.beginParameterInteraction();
    store.config.stencilLip = 10;
    await nextTick();
    store.config.stencilLip = 15;
    await nextTick();
    store.endParameterInteraction();
    expect(store.canUndo).toBe(false);
  });

  it("clones small array parameters without copying or replacing board geometry", async () => {
    const store = useConfigStore();
    store.applyGerberImport(imported());
    await nextTick();
    const outline = store.config.pcbOutlinePoints;
    const pads = store.config.stencilPadsTop;
    store.config.pryNotchSides.push("left");
    await store.undo();
    expect(store.config.pryNotchSides).toEqual(["down"]);
    expect(store.config.pcbOutlinePoints).toBe(outline);
    expect(store.config.stencilPadsTop).toBe(pads);
    await store.redo();
    expect(store.config.pryNotchSides).toEqual(["down", "left"]);
  });

  it("starts fresh after importing, including a same-name same-payload reimport", async () => {
    const store = useConfigStore();
    const payload = imported();
    store.applyGerberImport(payload);
    await nextTick();
    store.config.pcbThickness = 2;
    await nextTick();
    expect(store.canUndo).toBe(true);
    store.applyGerberImport(payload);
    await nextTick();
    expect(store.canUndo).toBe(false);
    expect(store.canRedo).toBe(false);
    store.config.pcbThickness = 2.4;
    await store.undo();
    expect(store.config.pcbThickness).toBe(2);
  });

  it("clears previous context on panel-scope and application-mode changes", async () => {
    const store = useConfigStore();
    store.applyGerberImport(imported());
    await nextTick();
    store.config.baseHeight = 5;
    await nextTick();
    store.setPanelMode("single");
    await nextTick();
    expect(store.config.pcbSizeX).toBe(30);
    expect(store.canUndo).toBe(false);
    store.config.padShrink = 10;
    await nextTick();
    store.setMode("stencil");
    await nextTick();
    expect(store.canUndo).toBe(false);
    expect(store.canRedo).toBe(false);
  });

  it("treats applying a structure preset as one action", async () => {
    const store = useConfigStore();
    store.applyPreset("heavy");
    await nextTick();
    expect(store.config.screwSpec).toBe("M4");
    await store.undo();
    expect(store.config.screwSpec).toBe("M3");
    expect(store.config.baseHeight).toBe(4);
    expect(store.config.insertHeight).toBe(8);
    expect(store.canUndo).toBe(false);
  });

  it('resets every advanced control while retaining board work and undoing the reset together', async () => {
    const store = useConfigStore();
    store.applyGerberImport(imported());
    store.config.pcbThickness = 2;
    store.config.stencilSizeX = 150;
    store.config.stencilLip = 7;
    store.config.pryNotchSides = ['up', 'right'];
    store.config.componentReliefEnabled = true;
    store.config.jigPrintSide = 'bottom';
    store.config.componentReliefRegions = {
      top: [{ id: 'top', shape: 'rect', x: 0, y: 0, width: 4, height: 4, depth: 3 }],
      bottom: [{ id: 'bottom', shape: 'circle', x: 5, y: 0, width: 4, height: 4, depth: 5 }],
    };
    const advancedChanges = { insertHeight: 12, platterCornerRadius: 7, outerCornerRadius: 8,
      ejectSlotWidth: 0, ejectHoleDiameter: 12, windowGap: 2, pcbPocketClearance: .6,
      postClearance: .6, useHexNut: false, nutAcrossFlats: 6.2, nutHeight: 3, nutPocketClearance: .4 };
    Object.assign(store.config, advancedChanges);
    await nextTick();
    store.clearParameterHistory();
    const outline = store.config.pcbOutlinePoints;
    const plans = JSON.parse(JSON.stringify(store.config.componentReliefRegions));

    store.reset();
    await nextTick();
    for (const key of Object.keys(advancedChanges) as Array<keyof typeof advancedChanges>) {
      expect(store.config[key], key).toBe(DEFAULT[key]);
    }
    expect(store.config.pcbThickness).toBe(2);
    expect(store.config.stencilSizeX).toBe(150);
    expect(store.config.stencilLip).toBe(7);
    expect(store.config.pryNotchSides).toEqual(['up', 'right']);
    expect(store.config.pcbOutlinePoints).toBe(outline);
    expect(store.config.componentReliefEnabled).toBe(true);
    expect(store.config.jigPrintSide).toBe('bottom');
    expect(store.config.componentReliefRegions).toEqual(plans);

    await store.undo();
    for (const key of Object.keys(advancedChanges) as Array<keyof typeof advancedChanges>) {
      expect(store.config[key], key).toBe(advancedChanges[key]);
    }
    expect(store.canUndo).toBe(false);
    expect(store.config.componentReliefRegions).toEqual(plans);
    await store.redo();
    expect(store.config.windowGap).toBe(DEFAULT.windowGap);
    expect(store.config.postClearance).toBe(DEFAULT.postClearance);
    expect(store.config.componentReliefRegions).toEqual(plans);
  });

  it("allows undoing manufacturing settings with custom dimensions preserved", async () => {
    const store = useConfigStore();
    store.config.jigSize = 200;
    await nextTick();
    store.clearParameterHistory();
    const settings = { ...pickPresetSettings(store.config), screwSpec: "M4", periScrewD: 4.6, nutHeight: 3.8 };
    await store.applyUserSettings(settings);
    await store.undo();
    expect(store.config.jigSize).toBe(200);
    expect(store.config.screwSpec).toBe("M3");
    await store.redo();
    expect(store.config.periScrewD).toBe(4.6);
    expect(store.config.nutHeight).toBe(3.8);
  });

  it("restoring a saved startup preset does not create an undo step", async () => {
    const store = useConfigStore();
    const settings = { ...pickPresetSettings(store.config), baseHeight: 6 };
    vi.stubGlobal("localStorage", { getItem: (key: string) => key === PRESETS_STORAGE_KEY
      ? JSON.stringify({ version: 1, selectedId: "test", presets: [{ id: "test", name: "Saved", settings }] }) : null });
    await usePresetsStore().initialize();
    expect(store.config.baseHeight).toBe(6);
    expect(store.canUndo).toBe(false);
  });

  it("keeps the most recent 50 steps and prevents overlapping replay", async () => {
    const store = useConfigStore();
    for (let i = 0; i < 60; i++) {
      vi.advanceTimersByTime(800);
      store.config.screwSpacing = 41 + i;
      await nextTick();
    }
    await Promise.all([store.undo(), store.undo()]);
    expect(store.config.screwSpacing).toBe(99);
    for (let i = 0; i < 49; i++) await store.undo();
    expect(store.config.screwSpacing).toBe(50);
    expect(store.canUndo).toBe(false);
  });
});

describe("parameter keyboard shortcuts", () => {
  const event = { key: "z", ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, isComposing: false, defaultPrevented: false, target: null };
  it("supports Windows and Mac undo/redo", () => {
    expect(parameterHistoryShortcut(event)).toBe("undo");
    expect(parameterHistoryShortcut({ ...event, shiftKey: true })).toBe("redo");
    expect(parameterHistoryShortcut({ ...event, key: "y" })).toBe("redo");
    expect(parameterHistoryShortcut({ ...event, ctrlKey: false, metaKey: true })).toBe("undo");
  });
  it("leaves text editing, composition and consumed events alone", () => {
    expect(parameterHistoryShortcut({ ...event, target: { closest: () => ({}) } as unknown as EventTarget })).toBeNull();
    expect(parameterHistoryShortcut({ ...event, isComposing: true })).toBeNull();
    expect(parameterHistoryShortcut({ ...event, defaultPrevented: true })).toBeNull();
    expect(parameterHistoryShortcut({ ...event, altKey: true })).toBeNull();
    expect(parameterHistoryShortcut({ ...event, ctrlKey: false })).toBeNull();
  });
});
