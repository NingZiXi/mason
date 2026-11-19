import { describe, expect, it } from 'vitest';
import { extractOutline } from '../parser';

type Point = [number, number];
const header = '%FSLAX45Y45*%\n%MOMM*%\n';
const xy = ([x, y]: Point) => `X${Math.round(x * 1e5)}Y${Math.round(y * 1e5)}`;
const line = (...points: Point[]) => 'G01*\n' + points.map((p, i) => `${xy(p)}D0${i ? 1 : 2}*\n`).join('');
const arc = (from: Point, to: Point, i: number, j: number) =>
  `${xy(from)}D02*\nG03*\n${xy(to)}I${Math.round(i * 1e5)}J${Math.round(j * 1e5)}D01*\n`;

// Like issue #5: four independent lines, followed by the four corner arcs.
// The start of the bottom edge is 28 microns away from its matching arc.
const rounded = [
  line([50, 3], [50, 37]), line([47, 40], [3, 40]),
  line([0, 37], [0, 3]), line([3.028, 0], [47, 0]),
  arc([50, 37], [47, 40], -3, 0), arc([3, 40], [0, 37], 0, -3),
  arc([0, 3], [3, 0], 3, 0), arc([47, 0], [50, 3], 0, 3),
];

describe('stitching Gerber outline strokes', () => {
  it.each([0, 3])('retains all four corners and straight edges, starting with stroke %i', start => {
    const o = extractOutline(header + [...rounded.slice(start), ...rounded.slice(0, start)].join(''));
    expect(o.isPanel).toBe(false);
    expect(o.holes).toHaveLength(0);
    expect(o.points.length).toBeGreaterThan(4);
    expect(o.points[o.points.length - 1]).toEqual(o.points[0]);
    const longEdges = o.points.slice(1).map(([x, y], i) =>
      [Math.abs(x - o.points[i][0]), Math.abs(y - o.points[i][1])])
      .filter(([dx, dy]) => Math.max(dx, dy) > 1);
    expect(longEdges).toHaveLength(4);
    expect(longEdges.every(([dx, dy]) => Math.min(dx, dy) < 0.03)).toBe(true);
    for (const [cx, cy, sx, sy] of [[3, 3, -1, -1], [47, 3, 1, -1], [3, 37, -1, 1], [47, 37, 1, 1]]) {
      const x = cx + sx * 3 / Math.SQRT2, y = cy + sy * 3 / Math.SQRT2;
      expect(o.points.some(p => Math.hypot(p[0] - x, p[1] - y) < 0.08)).toBe(true);
    }
  });

  it('keeps adjacent segmented boards separate even when their endpoints are within tolerance', () => {
    const a = line([0, 0], [10, 0]) + line([10, 8], [0, 8], [0, 0]);
    const b = line([10.012, 0], [18, 0], [18, 8], [10.012, 8]);
    const hole = line([2, 2], [4, 2], [4, 4], [2, 4], [2, 2]);
    const o = extractOutline(header + a + b + line([10, 8], [10, 0]) + line([10.012, 8], [10.012, 0]) + hole);
    expect(o.boards?.map(b => [b.bbox.minX, b.bbox.maxX, b.holes.length])).toEqual([[0, 10, 1], [10.012, 18, 0]]);
  });

  it.each([0.02, 0.06])('leaves a %s mm gap open when two continuations are geometrically plausible', (gap) => {
    const edge = line([0, 0], [10, 0]);
    const perimeter = line([10 + gap, 0], [12, 0], [12, 8], [0, 8], [0, 0]);
    const branch = line([10.1, 0.04], [10.1, 1]);
    expect(extractOutline(header + edge + perimeter).points).not.toHaveLength(0);
    expect(extractOutline(header + edge + perimeter + branch).points).toHaveLength(0);
    expect(extractOutline(header + branch + perimeter + edge).points).toHaveLength(0);
  });

  it('rejects a uniquely joinable outline with a nonzero area and crossing edges', () => {
    const crossing = line([0, 0], [12, 10], [0, 10], [8, 0], [0.08, 0]);
    expect(extractOutline(header + crossing).points).toHaveLength(0);
  });

  it('keeps an exact slot when a repairable cutout would cross it', () => {
    const outer = [[0, 0], [20, 0], [20, 20], [0, 20], [0, 0]] satisfies Point[];
    const slot = [[8, 8], [12, 8], [12, 12], [8, 12], [8, 8]] satisfies Point[];
    const crossing = line([10, 6], [14, 6], [14, 10], [10, 10], [10, 6.08]);
    expect(extractOutline(header + line(...outer) + crossing).holes).toHaveLength(1);
    const result = extractOutline(header + line(...outer) + line(...slot) + crossing);
    expect(result.points).toEqual(outer);
    expect(result.holes).toEqual([slot]);
    expect(result.isPanel).toBe(false);
  });

  it('ignores repeated coordinates at an endpoint that must move', () => {
    const edge = line([0, 0], [10, 0], [10, 8], [0, 8], [0, 8]);
    const side = line([0, 8.1], [0, 8.1], [0, 0]);
    expect(extractOutline(header + edge + side).points).toEqual([[0, 0], [10, 0], [10, 8], [0, 8], [0, 0]]);
  });

  it('rejects a new crossing with an open stroke and keeps existing intersections', () => {
    const edge = line([0, 0], [10, 0]);
    const rest = line([10, 0.2], [10, 8], [0, 8], [0, 0]);
    const crossingAt = (y: number) => line([9.5, y], [12, y]);
    const rectangle = [[0, 0], [10, 0], [10, 8], [0, 8], [0, 0]] satisfies Point[];
    expect(extractOutline(header + edge + rest + crossingAt(0.1)).points).toHaveLength(0);
    expect(extractOutline(header + edge + rest + crossingAt(0.3)).points).toEqual(rectangle);
    expect(extractOutline(header + line(...rectangle) + crossingAt(0.1)).points).toEqual(rectangle);
  });

  it('repairs each step-repeat copy without competing with the adjacent copy', () => {
    const profile = line([0, 0], [10, 0]) + line([10, 0.08], [10, 8], [0, 8], [0, 0.08]);
    const result = extractOutline(header + '%SRX2Y1I10.1J0*%\n' + profile + '%SR*%\n');
    expect(result.isPanel).toBe(true);
    expect(result.boards?.map(board => [board.bbox.minX, board.bbox.maxX])).toEqual([[0, 10], [10.1, 20.1]]);
  });

  it('does not turn an open path into a board or an internal cutout', () => {
    const open = line([1, 1], [9, 1], [9, 9], [1, 9]);
    expect(extractOutline(header + open).points).toHaveLength(0);
    const inside = line([3, 3], [4, 3], [4, 4], [3, 4], [3, 3]);
    expect(extractOutline(header + open + inside).points).toHaveLength(0);
    const board = line([0, 0], [12, 0], [12, 12], [0, 12], [0, 0]);
    const slot = line([10, 2], [11, 2], [11, 3], [10, 3], [10, 2]);
    expect(extractOutline(header + board + open + slot).holes).toEqual([[[10, 2], [11, 2], [11, 3], [10, 3], [10, 2]]]);
  });
});
