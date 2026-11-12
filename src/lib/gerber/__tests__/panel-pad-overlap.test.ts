import { describe, expect, it } from 'vitest';
import { makePanelVariant } from '../panel';
import { extractPads, type PadPolygon } from '../pads';

type Point = [number, number];
const rect = (x: number, y: number, width: number, height: number): Point[] =>
  [[x, y], [x + width, y], [x + width, y + height], [x, y + height], [x, y]];
const board = (points: Point[], holes: Point[][] = []) => ({ points, holes, bbox: {
  minX: Math.min(...points.map(p => p[0])), maxX: Math.max(...points.map(p => p[0])),
  minY: Math.min(...points.map(p => p[1])), maxY: Math.max(...points.map(p => p[1])),
} });
const pad = (points: Point[], holes: Point[][] = [], polarity: 'D' | 'C' = 'D'): PadPolygon => ({
  type: 'region', polarity,
  cx: points.reduce((sum, p) => sum + p[0], 0) / points.length,
  cy: points.reduce((sum, p) => sum + p[1], 0) / points.length,
  parts: [{ polarity: 'D', points, ...(holes.length ? { holes } : {}) }],
});
const selected = (points: Point[], pads: PadPolygon[], holes: Point[][] = []) => makePanelVariant(board(points, holes), pads, []).topPads!;

describe('panel pad assignment by actual material overlap', () => {
  it('keeps an L-shaped region wholly on an L-shaped PCB when its averaged centre lies in the notch', () => {
    const lBoard: Point[] = [[0, 0], [10, 0], [10, 2], [2, 2], [2, 10], [0, 10], [0, 0]];
    const region = extractPads([
      '%FSLAX34Y34*%', '%MOMM*%', 'G36*', 'X1000Y1000D02*', 'X99000Y1000D01*',
      'X99000Y19000D01*', 'X19000Y19000D01*', 'X19000Y99000D01*', 'X1000Y99000D01*', 'G37*',
    ].join('\n')).pads;
    expect(region[0].cx).toBeGreaterThan(2);
    expect(region[0].cy).toBeGreaterThan(2);
    expect(selected(lBoard, region)).toHaveLength(1);
  });

  it('keeps an offset macro whose flash origin is outside the board', () => {
    const macro = extractPads([
      '%FSLAX34Y34*%', '%MOMM*%', '%AMOFFSET*21,1,2,1,4,0,0*%', '%ADD10OFFSET*%',
      'D10*', 'X-20000Y50000D03*', 'M02*',
    ].join('\n')).pads;
    expect(macro[0].cx).toBe(-2);
    const result = selected(rect(0, 0, 10, 10), macro);
    expect(result).toHaveLength(1);
    expect(result[0].parts[0].points[0]).toEqual([-4, -.5]);
    expect(macro[0].parts[0].points[0]).toEqual([1, 4.5]);
  });

  it('keeps interlocking-board pads isolated despite overlapping board bounding boxes', () => {
    const lBoard: Point[] = [[0, 0], [10, 0], [10, 2], [2, 2], [2, 10], [0, 10], [0, 0]];
    const pads = [pad(rect(.5, 5, 1, 1)), pad(rect(5, 5, 1, 1))];
    expect(selected(lBoard, pads)).toHaveLength(1);
    expect(selected(rect(3, 3, 6, 6), pads)).toHaveLength(1);
  });

  it('rejects contacts along only a shared edge or corner, with either winding direction', () => {
    for (const shape of [rect(0, 0, 10, 10), rect(0, 0, 10, 10).reverse()]) {
      const pads = [pad(rect(10, 2, 2, 2)), pad(rect(10, 10, 2, 2)), pad(rect(-2, 2, 2, 2))];
      expect(selected(shape, pads)).toHaveLength(0);
    }
  });

  it('retains exactly coincident filled polygons and coincident board-hole boundaries with material on the same side', () => {
    expect(selected(rect(0, 0, 10, 10), [pad(rect(0, 0, 10, 10).reverse())])).toHaveLength(1);
    const ring = pad(rect(0, 0, 10, 10), [rect(2, 2, 6, 6)]);
    expect(selected(rect(0, 0, 10, 10), [ring], [rect(2, 2, 6, 6).reverse()])).toHaveLength(1);
  });

  it('rejects pads wholly within a board hole, including an exactly matching hole boundary', () => {
    const pads = [pad(rect(3, 3, 1, 1)), pad(rect(2, 2, 6, 6)), pad(rect(2, 2, 6, 6).reverse())];
    expect(selected(rect(0, 0, 10, 10), pads, [rect(2, 2, 6, 6)])).toHaveLength(0);
  });

  it('rejects a donut aperture when the entire board is in its hole', () => {
    const ring = pad(rect(-5, -5, 20, 20), [rect(0, 0, 10, 10)]);
    expect(selected(rect(2, 2, 2, 2), [ring])).toHaveLength(0);
    expect(selected(rect(0, 0, 10, 10), [ring])).toHaveLength(0);
  });

  it('retains a crossing clear object on each affected board even when its centre belongs to neither', () => {
    const clear = pad(rect(5, 4, 20, 2), [], 'C');
    clear.cx = 15; clear.cy = 5;
    expect(selected(rect(0, 0, 10, 10), [clear])).toHaveLength(1);
    expect(selected(rect(20, 0, 10, 10), [clear])).toHaveLength(1);
    expect(selected(rect(40, 0, 10, 10), [clear])).toHaveLength(0);
    expect(selected(rect(0, 0, 10, 10), [pad(rect(3, 3, 1, 1), [], 'C')], [rect(2, 2, 6, 6)])).toHaveLength(0);
  });

  it('detects perpendicular thin strips crossing with no vertex or edge midpoint inside the board', () => {
    expect(selected(rect(0, 0, 10, 10), [pad(rect(-20, .5, 60, 1))])).toHaveLength(1);
  });

  it('assigns multipart apertures only through their dark material, preserving per-part holes', () => {
    const multipart: PadPolygon = { type: 'macro', polarity: 'D', cx: -100, cy: -100,
      parts: [{ polarity: 'D', points: rect(20, 20, 2, 2) }, { polarity: 'D', points: rect(2, 2, 6, 6), holes: [rect(3, 3, 4, 4)] },
        { polarity: 'C', points: rect(30, 30, 2, 2) }] };
    expect(selected(rect(0, 0, 10, 10), [multipart])).toHaveLength(1);
    expect(selected(rect(4, 4, 1, 1), [multipart])).toHaveLength(0);
    expect(selected(rect(30, 30, 2, 2), [multipart])).toHaveLength(0);
  });

  it('keeps normal dense board pads while rejecting remote pads before edge-pair work', () => {
    const pads = Array.from({ length: 10000 }, (_, i) => pad(rect((i % 100) + .1, Math.floor(i / 100) + .1, .2, .2)));
    const result = selected(rect(0, 0, 50, 100), pads);
    expect(result).toHaveLength(5000);
    expect(pads.every(p => p.apertureOverride === undefined)).toBe(true);
  });
});
