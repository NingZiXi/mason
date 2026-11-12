import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { nextTick } from "vue";
import { DEFAULT, useConfigStore } from "../../stores/config";
import { usePresetsStore } from "../../stores/presets";
import { useWorkSessionStore } from "../../stores/work-session";
import { DEFAULT_PRESET_ID, PRESETS_STORAGE_KEY, pickPresetSettings, readPresetSettings } from "../config-presets";
import type { PanelVariant } from "../gerber/panel";

let disk: Map<string, string>;
let storage: { getItem: (key: string) => string | null; setItem: (key: string, value: string) => void };
beforeEach(() => {
  disk = new Map();
  storage = { getItem: (key) => disk.get(key) ?? null, setItem: (key, value) => { disk.set(key, value); } };
  vi.stubGlobal("localStorage", storage);
  setActivePinia(createPinia());
});
afterEach(() => vi.unstubAllGlobals());

describe("persistent configuration presets", () => {
  it("compares notch selections as enabled edges without changing their click order", async () => {
    const config = useConfigStore();
    const store = usePresetsStore(); await store.initialize();
    config.config.pryNotchSides = ['down', 'left'];
    store.saveAs('Two edges');
    config.config.pryNotchSides = ['left'];
    expect(store.dirty).toBe(true);
    config.config.pryNotchSides.push('down');
    expect(store.dirty).toBe(false);
    expect(config.config.pryNotchSides).toEqual(['left', 'down']);
    expect(pickPresetSettings(config.config).pryNotchSides).toEqual(['down', 'left']);
  });

  it("loads older presets with unordered notch edges without showing unsaved changes", async () => {
    disk.set(PRESETS_STORAGE_KEY, JSON.stringify({ version: 1, selectedId: 'legacy',
      presets: [{ id: 'legacy', name: 'Legacy', settings: { pryNotchSides: ['right', 'down', 'left'] } }] }));
    const store = usePresetsStore(); await store.initialize();
    expect(store.selectedId).toBe('legacy');
    expect(store.dirty).toBe(false);
    expect(store.selected?.settings.pryNotchSides).toEqual(['down', 'left', 'right']);
  });

  it("keeps the unexported-work reminder after saving edits as a preset", async () => {
    const presets = usePresetsStore();
    await presets.initialize();
    const session = useWorkSessionStore();
    await session.initialize();
    useConfigStore().config.postClearance = 0.3;
    expect(session.hasUnexportedChanges).toBe(true);
    presets.saveAs("新预设");
    expect(presets.dirty).toBe(false);
    expect(session.hasUnexportedChanges).toBe(true);
    session.markExported(session.captureExport());
    expect(session.hasUnexportedChanges).toBe(false);
  });

  it("saves edits made under Default as a new preset without reapplying settings or changing the board", async () => {
    const config = useConfigStore();
    const store = usePresetsStore();
    await store.initialize();
    expect(store.selectedId).toBe(DEFAULT_PRESET_ID);
    config.config.pcbSizeX = 65;
    config.config.pcbThickness = 2;
    config.config.screwSpec = "M4";
    config.config.baseHeight = 6;
    await nextTick();
    config.config.postClearance = .3;
    config.config.padShrink = 12;
    await nextTick();
    const before = JSON.parse(JSON.stringify(config.config));
    const settings = pickPresetSettings(config.config);
    store.saveAs("我的打印配置");
    expect(store.selectedId).not.toBe(DEFAULT_PRESET_ID);
    expect(store.selected?.name).toBe("我的打印配置");
    expect(store.selected?.settings).toEqual(settings);
    expect(store.dirty).toBe(false);
    expect(config.config).toEqual(before);
    expect(DEFAULT.postClearance).toBe(.225);
    expect(DEFAULT.padShrink).toBe(0);

    const id = store.selectedId;
    setActivePinia(createPinia());
    const reopened = usePresetsStore();
    await reopened.initialize();
    expect(reopened.selectedId).toBe(id);
    expect(pickPresetSettings(useConfigStore().config)).toEqual(settings);
  });

  it("restores the last saved preset on restart, retaining custom screw overrides", async () => {
    const config = useConfigStore();
    const store = usePresetsStore();
    await store.initialize();
    config.config.screwSpec = "M5";
    config.config.baseHeight = 6;
    await nextTick();
    Object.assign(config.config, { periScrewD: 5.8, nutAcrossFlats: 8.3, nutHeight: 4.2, postClearance: 0.45, nutPocketClearance: 0.35 });
    store.saveAs("树脂打印机");
    const id = store.selectedId;
    const saved = pickPresetSettings(config.config);
    config.config.postClearance = 0.8;
    expect(store.dirty).toBe(true);

    setActivePinia(createPinia()); // Simulate a fresh application process.
    const reopened = usePresetsStore();
    await reopened.initialize();
    expect(reopened.selectedId).toBe(id);
    expect(reopened.dirty).toBe(false);
    expect(pickPresetSettings(useConfigStore().config)).toEqual(saved);
    expect(useConfigStore().config.platterHeight).toBe(6);
    useConfigStore().config.screwSpec = "M3";
    await nextTick();
    expect(useConfigStore().config.periScrewD).toBe(3.2); // Normal linkage resumes.
  });

  it("switches manufacturing settings while preserving the board, mode and panel scopes", async () => {
    const config = useConfigStore();
    const store = usePresetsStore();
    await store.initialize();
    config.config.postClearance = 0.4;
    config.config.pcbPocketClearance = 0.35;
    store.saveAs("FDM");
    const id = store.selectedId;
    const variant = (width: number): PanelVariant => ({
      width, height: 30, center: { x: 0, y: 0 },
      outlinePoints: [[-10, -10], [10, -10], [10, 10]], outlineHoles: [],
      topPads: [{ type: "rect", cx: 0, cy: 0, polarity: "D", parts: [] }], bottomPads: [],
    });
    config.applyGerberImport({
      filename: "real-board.zip", isPanel: true, hasPads: true, panelGrid: { nx: 2, ny: 1 },
      mode: "single", variants: { panel: variant(110), single: variant(45) },
    });
    config.config.appMode = "stencil";
    config.config.pcbThickness = 2;
    await nextTick();
    expect(config.config.postClearance).toBe(0.4);
    expect(store.dirty).toBe(false); // Importing another board does not modify a preset.
    const boardKeys = ["pcbSizeX", "pcbSizeY", "pcbThickness", "stencilSizeX", "stencilSizeY", "gerberFilename", "pcbOutlinePoints", "pcbOutlineHoles", "stencilPadsTop", "stencilPadsBottom", "appMode", "panelMode", "panelAvailable", "panelGrid"] as const;
    const board = () => JSON.stringify(boardKeys.map((key) => config.config[key]));
    const before = board();
    await store.select(DEFAULT_PRESET_ID);
    expect(config.config.postClearance).toBe(DEFAULT.postClearance);
    expect(board()).toBe(before);
    await store.select(id);
    expect(config.config.postClearance).toBe(0.4);
    expect(config.config.pcbPocketClearance).toBe(0.35);
    expect(board()).toBe(before);
    config.setPanelMode("panel");
    expect(config.config.pcbSizeX).toBe(110);
    expect(disk.get(PRESETS_STORAGE_KEY)).not.toContain("real-board.zip");
    expect(disk.get(PRESETS_STORAGE_KEY)).not.toContain("stencilPadsTop");
  });

  it("supports independent saves, updates, renames and deletion without silently saving edits", async () => {
    const config = useConfigStore();
    const store = usePresetsStore();
    await store.initialize();
    store.saveAs("A");
    const first = store.selectedId;
    config.config.padShrink = 10;
    store.saveAs("B");
    const second = store.selectedId;
    expect(store.presets).toHaveLength(2);
    expect(store.presets[0].settings.padShrink).toBe(0);
    config.config.padShrink = 15;
    store.rename(" B 改名 ");
    expect(store.selected?.name).toBe("B 改名");
    expect(store.selected?.settings.padShrink).toBe(10);
    expect(store.dirty).toBe(true);
    store.update();
    expect(store.dirty).toBe(false);
    await store.select(first);
    expect(config.config.padShrink).toBe(0);
    await store.select(second);
    expect(config.config.padShrink).toBe(15);
    await store.removeSelected();
    expect(store.selectedId).toBe(DEFAULT_PRESET_ID);
    expect(config.config.padShrink).toBe(0);
    expect(store.presets.map((p) => p.id)).toEqual([first]);
    expect(store.dirty).toBe(false);
    setActivePinia(createPinia());
    await usePresetsStore().initialize();
    expect(usePresetsStore().selectedId).toBe(DEFAULT_PRESET_ID);
    expect(usePresetsStore().presets.map((p) => p.id)).toEqual([first]);
  });

  it("rejects duplicate or reserved names and keeps the built-in default immutable", async () => {
    const store = usePresetsStore();
    await store.initialize();
    store.saveAs("Printer");
    for (const name of [" printer ", "", "   ", "默认配置", "Default", "デフォルト", "기본 설정", "x".repeat(41)]) {
      expect(() => store.saveAs(name)).toThrow("presets.invalidName");
    }
    await store.select(DEFAULT_PRESET_ID);
    useConfigStore().config.padShrink = 20;
    store.update();
    expect(DEFAULT.padShrink).toBe(0);
    expect(store.dirty).toBe(true);
  });

  it("reports storage failures without pretending to save or switching the current settings", async () => {
    const store = usePresetsStore();
    await store.initialize();
    store.saveAs("A");
    const id = store.selectedId;
    useConfigStore().config.padShrink = 20;
    const diskBefore = disk.get(PRESETS_STORAGE_KEY);
    vi.spyOn(storage, "setItem").mockImplementation(() => { throw new Error("quota"); });
    expect(() => store.update()).toThrow("presets.storageFailed");
    expect(() => store.saveAs("B")).toThrow("presets.storageFailed");
    await expect(store.select(DEFAULT_PRESET_ID)).rejects.toThrow("presets.storageFailed");
    await expect(store.removeSelected()).rejects.toThrow("presets.storageFailed");
    expect(store.selectedId).toBe(id);
    expect(useConfigStore().config.padShrink).toBe(20);
    expect(store.presets).toHaveLength(1);
    expect(disk.get(PRESETS_STORAGE_KEY)).toBe(diskBefore);
    expect(store.busy).toBe(false);
  });

  it.each(["{broken", JSON.stringify({ version: 2, presets: [] }), JSON.stringify({
    version: 1, presets: [{ id: "a", name: "Bad", settings: { padShrink: -1 } }],
  })])("handles invalid storage without overwriting it: %s", async (raw) => {
    disk.set(PRESETS_STORAGE_KEY, raw);
    const store = usePresetsStore();
    await store.initialize();
    expect(store.loadError).toBe("presets.loadFailed");
    expect(store.presets).toEqual([]);
    expect(disk.get(PRESETS_STORAGE_KEY)).toBe(raw);
    expect(useConfigStore().config.stencilFilterTestPoints).toBe(true);
  });

  it("fills new settings from defaults and never applies injected board fields", async () => {
    const config = useConfigStore();
    await config.applyUserSettings({ postClearance: 0.6, pcbSizeX: 999, gerberFilename: "bad.zip" });
    expect(config.config.postClearance).toBe(0.6);
    expect(config.config.pcbSizeX).toBe(50);
    expect(config.config.gerberFilename).toBeNull();
    expect(config.config.stencilFilterTestPoints).toBe(true);
    expect(config.config.nutPocketClearance).toBe(0.2);
    expect(() => readPresetSettings({ nutPocketClearance: -0.1 }, DEFAULT)).toThrow();
    expect(() => readPresetSettings({ postClearance: NaN }, DEFAULT)).toThrow();
    expect(() => readPresetSettings({ pryNotchSides: ["up", "up"] }, DEFAULT)).toThrow();
  });

});
