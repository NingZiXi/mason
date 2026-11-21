import { describe, expect, it } from 'vitest';
import type { PadPolygon } from '../gerber/pads';
import { alignStencilPhoto, detectStencilQuad, jigPlacementFromInstance, StencilPhotoError, type BoardInstance, type Quad } from '../stencil-align';
import { applyHomography, solveHomography, type Vec2 } from '../stencil-align/homography';
import { createGray } from '../stencil-align/image';
import { findBoardInstances, padFeatures } from '../stencil-align/match';
import { placeBoardPoint } from '../stencil-placement';

function rectPad(cx: number, cy: number, w: number, h: number): PadPolygon {
  const points: Array<[number, number]> = [[cx - w / 2, cy - h / 2], [cx + w / 2, cy - h / 2], [cx + w / 2, cy + h / 2], [cx - w / 2, cy + h / 2]];
  return { type: 'rect', cx, cy, polarity: 'D', parts: [{ polarity: 'D', points }] };
}

/** Deterministic, asymmetric pad field on a 20 × 30 mm board. */
function boardPads(count: number, seed: number): PadPolygon[] {
  let s = seed;
  const rand = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  const pads: PadPolygon[] = [];
  while (pads.length < count) {
    const w = 0.6 + rand() * 1.6, h = 0.6 + rand() * 1.6;
    const x = -8.5 + rand() * 17, y = -13.5 + rand() * 27;
    if (pads.some(p => Math.abs(p.cx - x) < 2.4 && Math.abs(p.cy - y) < 2.4)) continue;
    pads.push(rectPad(x, y, w, h));
  }
  return pads;
}

interface Copy { pads: PadPolygon[]; x: number; y: number; rotation: number; mirrored: boolean }

/**
 * Render a photo of a 100 × 100 mm stencil on paper. Openings show the paper;
 * the sheet brightness sweeps from glare to dark so openings change polarity.
 */
function renderPhoto(quad: Quad, copies: Copy[], hole = 150, size = 100) {
  const W = 1200, H = 900;
  const img = createGray(W, H);
  const toSheet = solveHomography(quad, [[0, 0], [size, 0], [size, size], [0, size]]);
  // Rasterise openings on a fine stencil grid for fast lookups.
  const ppm = 20;
  const mask = new Uint8Array(size * ppm * size * ppm);
  for (const copy of copies) {
    const c = Math.cos(copy.rotation), s = Math.sin(copy.rotation);
    for (const pad of copy.pads) {
      const pts = pad.parts[0].points.map(([x, y]) => {
        const mx = copy.mirrored ? -x : x;
        // Centred y-up stencil mm → top-left y-down raster mm.
        return [c * mx - s * y + copy.x + size / 2, size / 2 - (s * mx + c * y + copy.y)] as Vec2;
      });
      const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
      for (let gy = Math.floor(Math.min(...ys) * ppm); gy <= Math.ceil(Math.max(...ys) * ppm); gy++) {
        for (let gx = Math.floor(Math.min(...xs) * ppm); gx <= Math.ceil(Math.max(...xs) * ppm); gx++) {
          const px = (gx + 0.5) / ppm, py = (gy + 0.5) / ppm;
          let inside = false;
          for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
            if ((pts[i][1] > py) !== (pts[j][1] > py)
              && px < pts[j][0] + ((py - pts[j][1]) * (pts[i][0] - pts[j][0])) / (pts[i][1] - pts[j][1])) inside = !inside;
          }
          if (inside && gx >= 0 && gy >= 0 && gx < size * ppm && gy < size * ppm) mask[gy * size * ppm + gx] = 1;
        }
      }
    }
  }
  let noise = 7;
  const rand = () => ((noise = (noise * 1103515245 + 12345) % 2147483648) / 2147483648) - 0.5;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const [u, v] = applyHomography(toSheet, [x + 0.5, y + 0.5]);
      let value = 205 + 6 * (x / W); // paper
      if (u >= 0 && v >= 0 && u < size && v < size) {
        // Glare on the left, dark metal on the right: by default openings
        // change polarity across the sheet and vanish where they cross.
        value = mask[Math.floor(v * ppm) * size * ppm + Math.floor(u * ppm)] ? hole : 230 - 1.9 * u;
      }
      img.data[y * W + x] = value + rand() * 16;
    }
  }
  return img;
}

const QUAD: Quad = [[262, 141], [948, 128], [972, 820], [238, 806]];
const TOP = boardPads(36, 11);
const BOTTOM = boardPads(6, 29);

describe('stencil photo alignment', () => {
  it('finds the stencil corners under perspective', () => {
    const img = renderPhoto(QUAD, []);
    const quad = detectStencilQuad(img)!;
    expect(quad).not.toBeNull();
    quad.forEach((p, i) => {
      expect(Math.hypot(p[0] - QUAD[i][0], p[1] - QUAD[i][1])).toBeLessThan(2.5);
    });
  });

  it('locates an off-centre top copy and its mirrored bottom copy', () => {
    const img = renderPhoto(QUAD, [
      { pads: TOP, x: -20, y: 6, rotation: 0, mirrored: false },
      { pads: BOTTOM, x: 22, y: -4, rotation: 0, mirrored: true },
    ]);
    const result = alignStencilPhoto({ image: img, stencilSizeX: 100, stencilSizeY: 100,
      topPads: TOP, bottomPads: BOTTOM, boardWidth: 20, boardHeight: 30 });
    expect(result.top).toHaveLength(1);
    expect(result.bottom).toHaveLength(1);
    const [top] = result.top, [bottom] = result.bottom;
    expect(top.mirrored).toBe(false);
    expect(top.x).toBeCloseTo(-20, 0);
    expect(top.y).toBeCloseTo(6, 0);
    expect(Math.abs(top.x + 20) + Math.abs(top.y - 6)).toBeLessThan(0.5);
    expect(Math.abs(top.rotation)).toBeLessThan(0.02);
    // Openings vanish where the sheet brightness crosses the paper's.
    expect(top.inliers / top.total).toBeGreaterThan(0.7);
    expect(bottom.mirrored).toBe(true);
    expect(Math.abs(bottom.x - 22) + Math.abs(bottom.y + 4)).toBeLessThan(0.5);
  });

  it('reports every copy of a small board, rotated a quarter turn', () => {
    // Rotated, each copy is 30 mm wide; cut them side by side without overlap.
    const copies = [-32, 0, 32].map(x => ({ pads: TOP, x, y: 0, rotation: Math.PI / 2, mirrored: false }));
    const img = renderPhoto(QUAD, copies, 20);
    const result = alignStencilPhoto({ image: img, stencilSizeX: 100, stencilSizeY: 100,
      topPads: TOP, bottomPads: [], boardWidth: 20, boardHeight: 30, quad: QUAD });
    const xs = result.top.map(i => i.x).sort((a, b) => a - b);
    expect(xs).toHaveLength(3);
    [-32, 0, 32].forEach((x, k) => expect(Math.abs(xs[k] - x)).toBeLessThan(0.3));
    for (const instance of result.top) {
      expect(jigPlacementFromInstance(instance, 'top')).toMatchObject({ quarter: 1, stencilFlipped: false });
    }
  });

  it('reports a sheet without the board as no match', () => {
    const img = renderPhoto(QUAD, [{ pads: BOTTOM, x: 0, y: 0, rotation: 0, mirrored: true }]);
    expect(() => alignStencilPhoto({ image: img, stencilSizeX: 100, stencilSizeY: 100,
      topPads: TOP, bottomPads: [], boardWidth: 20, boardHeight: 30, quad: QUAD }))
      .toThrow(StencilPhotoError);
  });
});

describe('pattern matching', () => {
  it('rejects a translation that explains only a few openings', () => {
    const feats = padFeatures(TOP);
    const blobs = feats.slice(0, 8).map(f => ({ ...f, x: f.x + 3, y: f.y }));
    expect(findBoardInstances(feats, blobs)).toEqual([]);
  });
});

describe('jig placement from a photographed copy', () => {
  const instance = (x: number, y: number, rotation: number, mirrored: boolean): BoardInstance => ({
    x, y, rotation, mirrored, scale: 1, inliers: 10, total: 10, rms: 0.05, blobs: [],
  });
  /** Where the photographed copy puts a board point, viewed on the face printed. */
  function photographed(i: BoardInstance, [x, y]: Vec2, flipped: boolean): Vec2 {
    const mx = i.mirrored ? -x : x;
    const p: Vec2 = [Math.cos(i.rotation) * mx - Math.sin(i.rotation) * y + i.x, Math.sin(i.rotation) * mx + Math.cos(i.rotation) * y + i.y];
    return flipped ? [p[0], -p[1]] : p;
  }

  for (const [label, i, side] of [
    ['top, face up', instance(-10, 1, 0, false), 'top'],
    ['bottom copy cut mirrored on the same face', instance(17, 0.7, 0, true), 'bottom'],
    ['top photographed from the back', instance(5, -3, Math.PI / 2, true), 'top'],
    ['bottom photographed from the back', instance(-8, 12, -Math.PI / 2, false), 'bottom'],
  ] as const) {
    it(`maps every board point onto its opening: ${label}`, () => {
      const placement = jigPlacementFromInstance(i, side);
      for (const point of [[0, 0], [3, -2], [-7, 11]] as Vec2[]) {
        // The jig sees the printing view: bottom boards flipped about X.
        const view: Vec2 = side === 'bottom' ? [point[0], -point[1]] : point;
        const placed = placeBoardPoint({ x: placement.x, y: placement.y, quarter: placement.quarter }, view);
        const expected = photographed(i, point, placement.stencilFlipped);
        expect(placed[0]).toBeCloseTo(expected[0], 6);
        expect(placed[1]).toBeCloseTo(expected[1], 6);
      }
    });
  }

  it('keeps the photographed face up for a conventional double-sided stencil', () => {
    expect(jigPlacementFromInstance(instance(-10, 1, 0, false), 'top').stencilFlipped).toBe(false);
    expect(jigPlacementFromInstance(instance(17, 1, 0, true), 'bottom')).toMatchObject({ stencilFlipped: false, quarter: 2 });
  });
});
