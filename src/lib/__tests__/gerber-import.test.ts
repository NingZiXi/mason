import { beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { nextTick } from "vue";
import { useConfigStore } from "../../stores/config";
import type { PadPolygon } from "../gerber/pads";
import type { PanelVariant } from "../gerber/panel";

const ring: Array<[number, number]> = [[0, 0], [6, 0], [6, 4], [0, 0]];
const pad: PadPolygon = {
  type: "circle", cx: 3, cy: 2, polarity: "C", padRole: "component",
  parts: [{ polarity: "D", points: ring, holes: [ring] }],
};
const variant = (width: number): PanelVariant => ({
  width, height: 30, center: { x: 3, y: 4 },
  outlinePoints: ring, outlineHoles: [ring], topPads: [pad], bottomPads: [],
});

beforeEach(() => setActivePinia(createPinia()));

describe("Gerber panel selection", () => {
  it("switches mixed-panel board variants", async () => {
    const store = useConfigStore();
    const first = { ...variant(40), id: "board-1", label: "子板 1" };
    const second = { ...variant(72), id: "board-2", label: "子板 2", inferred: true, topPads: [{ ...pad, cx: 30 }] };
    store.applyGerberImport({
      filename: "mixed.zip", isPanel: true, hasPads: true, mode: "board", boardIndex: 1,
      variants: { panel: variant(120), single: first, boards: [first, second] },
    });
    await nextTick();
    expect(store.config.panelMode).toBe("board");
    expect(store.config.panelBoardIndex).toBe(1);
    expect(store.config.pcbSizeX).toBe(72);
    expect(store.config.stencilPadsTop).toEqual(second.topPads);
    expect(store.panelBoards).toEqual([first, second]);
    store.setPanelBoard(0);
    expect(store.config.pcbSizeX).toBe(40);
    expect(store.config.stencilPadsTop).toEqual([pad]);
  });
  it("routes old single-board requests through the explicit board variants", () => {
    const store = useConfigStore();
    const board = { ...variant(40), topPads: [{ ...pad, cx: 1 }] };
    store.applyGerberImport({
      filename: "mixed.zip", isPanel: true, hasPads: true, mode: "single",
      // Old automatic extraction can be the full frame rather than a board.
      variants: { panel: variant(120), single: variant(120), boards: [board, variant(72)] },
    });
    expect(store.config.panelMode).toBe("board");
    expect(store.config.panelBoardIndex).toBe(0);
    expect(store.config.pcbSizeX).toBe(40);
    expect(store.config.stencilPadsTop).toEqual(board.topPads);
    store.setPanelBoard(1);
    expect(store.config.pcbSizeX).toBe(72);
  });
  it("clears mixed-panel choices when the next file is an outline-only single board", () => {
    const store = useConfigStore();
    store.applyGerberImport({
      filename: "mixed.zip", isPanel: true, hasPads: true, mode: "board", boardIndex: 1,
      variants: { panel: variant(120), single: variant(40), boards: [variant(40), variant(72)] },
    });
    const board = { ...variant(25), topPads: undefined, bottomPads: undefined };
    store.applyGerberImport({
      filename: "single.gko", isPanel: false, hasPads: false, mode: "panel",
      variants: { panel: board, single: board },
    });
    expect(store.panelBoards).toEqual([]);
    expect(store.config.panelBoardIndex).toBeNull();
    expect(store.config.stencilPadsTop).toEqual([]);
    store.setPanelBoard(1);
    expect(store.config.pcbSizeX).toBe(25);
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
