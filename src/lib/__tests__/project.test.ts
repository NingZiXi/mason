import { beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { nextTick } from "vue";
import { useConfigStore } from "../../stores/config";
import type { PadPolygon } from "../gerber/pads";
import type { PanelVariant } from "../gerber/panel";

const ring: Array<[number, number]> = [[0, 0], [6, 0], [6, 4], [0, 0]];
const pad: PadPolygon = {
  type: "circle", cx: 3, cy: 2, polarity: "C",
  parts: [{ polarity: "D", points: ring, holes: [ring] }],
};
const variant = (width: number): PanelVariant => ({
  width, height: 30, center: { x: 3, y: 4 },
  outlinePoints: ring, outlineHoles: [ring], topPads: [pad], bottomPads: [],
});

beforeEach(() => setActivePinia(createPinia()));

describe("project save/load", () => {
  it.each(["jig", "stencil"] as const)("round-trips all %s settings without watcher overrides", async (appMode) => {
    const store = useConfigStore();
    Object.assign(store.config, {
      appMode, pcbSizeX: 65, pcbSizeY: 34, stencilSizeX: 120, stencilSizeY: 90,
      pcbThickness: 2, pcbPocketClearance: 0.35, baseHeight: 5, screwSpec: "M5",
      postClearance: 0.45, pryNotchSides: ["left", "up"], pryNotchScale: 1.4,
      windowGap: 0.8, useHexNut: false, stencilFrameShape: "rect",
      stencilFilterTestPoints: false, stencilGrid: true, stencilStagger: true,
      stencilPadsTop: [pad], stencilPadsBottom: [{ ...pad, polarity: "D" }],
      pcbOutlinePoints: ring, pcbOutlineHoles: [ring], gerberFilename: "board.zip",
    });
    await nextTick();
    // Advanced overrides must survive a load that also changes screwSpec/baseHeight.
    Object.assign(store.config, { periScrewD: 5.7, nutAcrossFlats: 8.3, nutHeight: 4.2 });
    await nextTick();
    const expected = JSON.parse(JSON.stringify(store.config));
    // Exercise the real JSON boundary used by IPC and project files.
    const saved = JSON.parse(JSON.stringify(store.projectConfig()));
    Object.assign(store.config, { appMode: "jig", baseHeight: 3, screwSpec: "M2.5", postClearance: 9 });
    await nextTick();

    await store.restoreProject(saved, "board.zip");
    await nextTick();
    expect(store.config).toEqual(expected);
    expect(store.projectConfig()).toEqual(saved);
    // Ordinary edits should still trigger the standard screw-size linkage after loading.
    store.config.screwSpec = "M3";
    await nextTick();
    expect(store.config.periScrewD).toBe(3.2);
    expect(store.config.nutHeight).toBe(2.4);
  });

  it("restores both panel variants and can switch scope after reopening", async () => {
    const store = useConfigStore();
    store.applyGerberImport({
      filename: "panel.zip", isPanel: true, panelGrid: { nx: 2, ny: 1 }, hasPads: true,
      mode: "single", variants: { panel: variant(90), single: variant(40) },
    });
    await nextTick();
    const saved = JSON.parse(JSON.stringify(store.projectConfig()));
    store.clearPanelScope();
    await store.restoreProject(saved, "panel.zip");
    expect(store.config.panelMode).toBe("single");
    expect(store.config.panelGrid).toEqual({ nx: 2, ny: 1 });
    store.setPanelMode("panel");
    await nextTick();
    expect(store.config.pcbSizeX).toBe(90);
    expect(store.config.stencilPadsTop).toEqual([pad]);
    store.setPanelMode("single");
    expect(store.config.pcbSizeX).toBe(40);
  });

  it.each([
    { platter_width: 110, lip: 15 },
    { platter_margin: 10, lip: 34.8 },
  ])("migrates legacy stencil and platter sizes: %j", async ({ lip, ...legacy }) => {
    const store = useConfigStore();
    await store.restoreProject({
      pcb_size_x: 50, pcb_size_y: 30, pcb_pocket_clearance: 0.2,
      stencil_size: 140, ...legacy,
    }, "legacy.zip");
    expect(store.config.stencilSizeX).toBe(140);
    expect(store.config.stencilSizeY).toBe(140);
    expect(store.config.stencilLip).toBeCloseTo(lip);
  });

  it("loads legacy vertex pads and part-list pads without confusing their shapes", async () => {
    const store = useConfigStore();
    await store.restoreProject({
      stencil_pads: [ring], stencil_pads_bottom: [[{ polarity: "C", points: ring, holes: [ring] }]],
      pry_notch_side: "off",
    }, null);
    expect(store.config.stencilPadsTop[0].parts).toEqual([{ polarity: "D", points: ring }]);
    expect(store.config.stencilPadsBottom[0].parts).toEqual([{ polarity: "C", points: ring, holes: [ring] }]);
    expect(store.config.pryNotchSides).toEqual([]);
  });

  it("uses defaults for missing legacy fields and clears the preceding project's scopes", async () => {
    const store = useConfigStore();
    store.applyGerberImport({
      filename: "panel.zip", isPanel: true, hasPads: true,
      mode: "single", variants: { panel: variant(90), single: variant(40) },
    });
    store.config.postClearance = 9;
    store.config.appMode = "stencil";
    await store.restoreProject({ pcb_size_x: 60, pcb_size_y: 40 }, null);
    expect(store.config.postClearance).toBe(0.15);
    expect(store.config.pocketClearance).toBe(0.3);
    expect(store.config.appMode).toBe("jig");
    expect(store.config.panelAvailable).toBe(false);
    expect(store.config.stencilPadsTop).toEqual([]);
    store.setPanelMode("single");
    expect(store.config.pcbSizeX).toBe(60);
  });

  it("does not partly overwrite the active project if validation fails", async () => {
    const store = useConfigStore();
    const before = store.projectConfig();
    await expect(store.restoreProject({ pcb_size_x: 90, stencil_pads_top: ["invalid"] }, null)).rejects.toThrow();
    expect(store.projectConfig()).toEqual(before);
  });
});

describe("Gerber replacement", () => {
  it.each(["panel", "single"] as const)(
    "clears both preceding pad layers when importing an outline-only %s scope",
    async (mode) => {
      const store = useConfigStore();
      store.applyGerberImport({
        filename: "A.zip", isPanel: true, hasPads: true, mode: "panel",
        variants: {
          panel: { ...variant(90), bottomPads: [pad] },
          single: { ...variant(40), bottomPads: [pad] },
        },
      });
      await nextTick();
      const outlineOnly = (width: number): PanelVariant => ({
        ...variant(width), topPads: undefined, bottomPads: undefined,
      });
      store.applyGerberImport({
        filename: "B.gko", isPanel: true, hasPads: false, mode,
        variants: { panel: outlineOnly(120), single: outlineOnly(50) },
      });
      await nextTick();
      store.setMode("stencil");
      expect(store.config.gerberFilename).toBe("B.gko");
      expect(store.config.stencilPadsTop).toEqual([]);
      expect(store.config.stencilPadsBottom).toEqual([]);
      store.setPanelMode(mode === "single" ? "panel" : "single");
      expect(store.config.stencilPadsTop).toEqual([]);
      expect(store.config.stencilPadsBottom).toEqual([]);

      const saved = JSON.parse(JSON.stringify(store.projectConfig()));
      await store.restoreProject(saved, "B.gko");
      expect(store.config.stencilPadsTop).toEqual([]);
      expect(store.config.stencilPadsBottom).toEqual([]);
    }
  );

  it("replaces both layers when the next ZIP only contains bottom paste", () => {
    const store = useConfigStore();
    store.applyGerberImport({
      filename: "A.zip", isPanel: false, hasPads: true, mode: "panel",
      variants: { panel: variant(90), single: variant(90) },
    });
    const bottomOnly = { ...variant(60), topPads: [], bottomPads: [pad] };
    store.applyGerberImport({
      filename: "B.zip", isPanel: false, hasPads: true, mode: "panel",
      variants: { panel: bottomOnly, single: bottomOnly },
    });
    expect(store.config.stencilPadsTop).toEqual([]);
    expect(store.config.stencilPadsBottom).toEqual([pad]);
  });
});
