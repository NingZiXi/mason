import { describe, expect, it } from "vitest";
import { splitBridgedOutline } from "../bridges";
import { extractOutline } from "../parser";
import { makePanelVariant } from "../panel";
import { extractPads } from "../pads";

type Point = [number, number];
const close = (ring: Point[]): Point[] => [...ring, ring[0]];
// Three different boards joined by three 5 mm bridges. One bridge forms a
// cycle, making the apparent closed contours an exterior and a cutout.
const outer: Point[] = close([
  [0, 35], [46.5, 35], [46.5, 28], [34, 28], [34, 4], [64, 4],
  [64, 13.5], [70, 13.5], [70, 3], [106, 3], [106, 29], [90.5, 29],
  [90.5, 35], [140, 35], [140, 120], [0, 120],
]);
const cutout: Point[] = close([
  [51.5, 35], [85.5, 35], [85.5, 29], [70, 29],
  [70, 18.5], [64, 18.5], [64, 28], [51.5, 28],
]);
const hole: Point[] = close([[10, 50], [14, 50], [14, 54], [10, 54]]);
const sizes = (boards: ReturnType<typeof splitBridgedOutline>) => boards.map((b) =>
  [b.bbox.maxX - b.bbox.minX, b.bbox.maxY - b.bbox.minY].map((n) => Number(n.toFixed(4)))
);
const header = "%FSLAX46Y46*%\n%MOMM*%\nG01*\n";
const coord = (p: Point) => `X${Math.round(p[0] * 1e6)}Y${Math.round(p[1] * 1e6)}`;
function gerber(rings: Point[][]) {
  // KiCad often sorts individual edges instead of drawing a continuous path.
  return header + rings.flatMap((ring) => ring.slice(1).map((p, i) =>
    `${coord(ring[i])}D02*\n${coord(p)}D01*\n`
  )).reverse().join("") + "M02*\n";
}

describe("boards joined by routing bridges", () => {
  it("separates three boards across exterior and cutout edges, without keeping tabs", () => {
    const boards = splitBridgedOutline(outer, [cutout, hole]);
    expect(boards).toHaveLength(3);
    expect(sizes(boards)).toEqual(expect.arrayContaining([[140, 85], [30, 24], [36, 26]]));
    expect(boards.every((b) => b.inferred)).toBe(true);
    expect(boards.find((b) => b.bbox.maxX === 140)?.holes).toEqual([expect.any(Array)]);
    expect(outer).toHaveLength(17); // Source geometry is not mutated.
  });

  it("handles reversed winding and collinear tab-edge subdivisions", () => {
    const subdivided = [...outer.slice(0, 2), [46.5, 31] as Point, ...outer.slice(2)];
    const boards = splitBridgedOutline(subdivided.reverse(), [[...cutout].reverse()]);
    expect(sizes(boards)).toEqual(expect.arrayContaining([[140, 85], [30, 24], [36, 26]]));
  });

  it("retains curves and the original full panel while the single scope selects a real board", () => {
    // Replace one corner by a short chamfer to ensure non-axis segments survive.
    const chamfered = [...outer.slice(0, 14), [140, 119] as Point, [139, 120] as Point, ...outer.slice(15)];
    const text = gerber([chamfered, cutout, hole]);
    const panel = extractOutline(text, { panel: true });
    expect(panel.isPanel).toBe(true);
    expect(panel.boards).toHaveLength(3);
    expect(panel.points).toHaveLength(chamfered.length);
    expect(panel.holes).toHaveLength(2);
    const board = panel.boards!.find((b) => b.bbox.maxX === 140)!;
    expect(board.points).toContainEqual([139, 120]);
    expect(board.holes).toHaveLength(1);
    const single = extractOutline(text, { panel: false });
    expect([single.bbox.maxX - single.bbox.minX, single.bbox.maxY - single.bbox.minY]).toEqual([140, 85]);
    expect(single.holes).toHaveLength(1);
  });

  it("assigns top/bottom pads to the inferred boards, excluding holes and bridge pads", () => {
    const panel = extractOutline(gerber([outer, cutout, hole]), { panel: true });
    const paste = header + "%ADD10C,0.5*%\nD10*\n" +
      ([[20, 60], [40, 10], [100, 10], [12, 52], [49, 31]] as Point[])
        .map((p) => `${coord(p)}D03*\n`).join("");
    const pads = extractPads(paste).pads;
    const variants = panel.boards!.map((board) => makePanelVariant(board, pads, pads));
    expect(variants.every((board) => board.topPads?.length === 1 && board.bottomPads?.length === 1)).toBe(true);
    expect(variants.every((board) => board.inferred)).toBe(true);
    // Full panel keeps the pad on the physical bridge; only the cutout pad is excluded.
    expect(makePanelVariant(panel, pads).topPads).toHaveLength(4);
  });

  it("does not split rectangular boards, L shapes or internal slots", () => {
    const rectangle: Point[] = close([[0, 0], [50, 0], [50, 40], [0, 40]]);
    const slots = [close([[10, 5], [14, 5], [14, 35], [10, 35]] as Point[]),
      close([[19, 5], [23, 5], [23, 35], [19, 35]] as Point[])];
    expect(splitBridgedOutline(rectangle, [])).toEqual([]);
    expect(splitBridgedOutline(rectangle, slots)).toEqual([]);
    expect(splitBridgedOutline(close([[0, 0], [20, 0], [20, 5], [5, 5], [5, 20], [0, 20]]), [])).toEqual([]);
    expect(extractOutline(gerber([rectangle, ...slots])).isPanel).toBe(false);
  });

  it("rejects slivers rather than creating a spurious small board", () => {
    const shape: Point[] = close([[0, 0], [20, 0], [20, 8], [23, 8], [23, 6], [25, 6],
      [25, 14], [23, 14], [23, 12], [20, 12], [20, 20], [0, 20]]);
    expect(splitBridgedOutline(shape, [])).toEqual([]);
  });
});
