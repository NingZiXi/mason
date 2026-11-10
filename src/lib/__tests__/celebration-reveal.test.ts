import { describe, expect, it } from 'vitest';
import { celebrationClipPath, type RevealJob } from '../celebration-reveal';

type Point = { x: number; y: number };
const viewport = { width: 800, height: 600 };
const base: RevealJob = {
  kind: 'paint', rect: { left: 100, top: 50, width: 200, height: 100 },
  points: [{ x: 10, y: 50 }, { x: 190, y: 50 }], width: 20, start: 100, duration: 1000,
};

function polygons(css: string): Point[][] {
  return Array.from(css.matchAll(/M([^Z]+)Z/g), match => {
    const coordinates = Array.from(match[1].matchAll(/-?\d+(?:\.\d+)?/g), value => Number(value[0]));
    return Array.from({ length: coordinates.length / 2 }, (_, index) => ({ x: coordinates[index * 2], y: coordinates[index * 2 + 1] }));
  });
}

function contains(css: string, point: Point): boolean {
  let winding = 0;
  for (const polygon of polygons(css)) {
    for (let index = 0; index < polygon.length; index++) {
      const first = polygon[index], last = polygon[(index + 1) % polygon.length];
      const cross = (last.x - first.x) * (point.y - first.y) - (point.x - first.x) * (last.y - first.y);
      if (first.y <= point.y && last.y > point.y && cross > 0) winding++;
      if (first.y > point.y && last.y <= point.y && cross < 0) winding--;
    }
  }
  return winding !== 0;
}

describe('celebration reveal geometry', () => {
  it('reveals nothing before the first worker reaches its surface', () => {
    expect(celebrationClipPath([base], 0, viewport)).toBe("path('M0 0Z')");
    expect(celebrationClipPath([base], 100, viewport)).toBe("path('M0 0Z')");
  });

  it('reveals the brush body and cap up to the current tip, without revealing ahead', () => {
    const css = celebrationClipPath([base], 600, viewport);
    expect(contains(css, { x: 150, y: 100 })).toBe(true);
    expect(contains(css, { x: 205, y: 100 })).toBe(true);
    expect(contains(css, { x: 211, y: 100 })).toBe(false);
    expect(contains(css, { x: 150, y: 111 })).toBe(false);
    // The cap/body overlap must not cancel under CSS's nonzero winding rule.
    expect(contains(css, { x: 111, y: 100 })).toBe(true);
  });

  it('uses distance along all segments rather than equal time per vertex', () => {
    const job: RevealJob = { ...base, rect: { left: 0, top: 0, width: 200, height: 120 },
      points: [{ x: 20, y: 20 }, { x: 140, y: 20 }, { x: 140, y: 80 }], width: 10, duration: 900 };
    const halfway = celebrationClipPath([job], 550, viewport);
    expect(contains(halfway, { x: 109, y: 20 })).toBe(true);
    expect(contains(halfway, { x: 121, y: 20 })).toBe(false);
    expect(contains(halfway, { x: 140, y: 40 })).toBe(false);
    const turned = celebrationClipPath([job], 850, viewport);
    expect(contains(turned, { x: 140, y: 52 })).toBe(true);
    expect(contains(turned, { x: 140, y: 61 })).toBe(false);
  });

  it('clips wide caps and diagonal strokes to their panel and the viewport', () => {
    const job: RevealJob = { ...base, rect: { left: -10, top: 20, width: 100, height: 60 },
      points: [{ x: -20, y: -20 }, { x: 130, y: 90 }], width: 100 };
    const points = polygons(celebrationClipPath([job], 1100, viewport)).flat();
    expect(points.length).toBeGreaterThan(3);
    for (const point of points) {
      expect(point.x).toBeGreaterThanOrEqual(0);
      expect(point.x).toBeLessThanOrEqual(90);
      expect(point.y).toBeGreaterThanOrEqual(20);
      expect(point.y).toBeLessThanOrEqual(80);
    }
  });

  it('grows accent reveals from the control center only after delivery', () => {
    const job: RevealJob = { ...base, kind: 'accent' };
    expect(celebrationClipPath([job], 99, viewport)).toBe("path('M0 0Z')");
    const halfway = celebrationClipPath([job], 600, viewport);
    expect(contains(halfway, { x: 200, y: 100 })).toBe(true);
    expect(contains(halfway, { x: 151, y: 76 })).toBe(true);
    expect(contains(halfway, { x: 140, y: 100 })).toBe(false);
    const delivered = celebrationClipPath([job], 1100, viewport);
    expect(contains(delivered, { x: 101, y: 51 })).toBe(true);
    expect(contains(delivered, { x: 299, y: 149 })).toBe(true);
  });

  it('waits for a closed frame before revealing its interior from the bottom', () => {
    const job: RevealJob = { ...base, kind: 'edge', width: 3,
      points: [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 100 }, { x: 0, y: 100 }, { x: 0, y: 0 }] };
    expect(contains(celebrationClipPath([job], 1099, viewport), { x: 200, y: 100 })).toBe(false);
    expect(contains(celebrationClipPath([job], 1100, viewport), { x: 200, y: 100 })).toBe(false);
    const filling = celebrationClipPath([job], 1350, viewport);
    expect(contains(filling, { x: 200, y: 125 })).toBe(true);
    expect(contains(filling, { x: 200, y: 75 })).toBe(false);
    expect(contains(celebrationClipPath([job], 1600, viewport), { x: 200, y: 75 })).toBe(true);
  });

  it('unions independent workers without revealing the space between them', () => {
    const other: RevealJob = { ...base, rect: { left: 500, top: 300, width: 200, height: 100 } };
    const css = celebrationClipPath([base, other], 600, viewport);
    expect(contains(css, { x: 150, y: 100 })).toBe(true);
    expect(contains(css, { x: 550, y: 350 })).toBe(true);
    expect(contains(css, { x: 400, y: 250 })).toBe(false);
  });

  it('does not uncover untouched space until the final cleanup sweep', () => {
    expect(celebrationClipPath([], 4100, viewport)).toBe("path('M0 0Z')");
    const halfway = celebrationClipPath([], 4450, viewport);
    expect(contains(halfway, { x: 400, y: 450 })).toBe(true);
    expect(contains(halfway, { x: 400, y: 150 })).toBe(false);
    const done = celebrationClipPath([], 4800, viewport);
    expect(contains(done, { x: 1, y: 1 })).toBe(true);
    expect(contains(done, { x: 799, y: 599 })).toBe(true);
  });

  it.each([
    [NaN, viewport], [1000, { width: 0, height: 600 }], [1000, { width: 800, height: Infinity }],
  ])('ignores invalid timing or viewport dimensions', (elapsed, dimensions) => {
    expect(celebrationClipPath([base], elapsed as number, dimensions as typeof viewport)).toBe("path('M0 0Z')");
  });

  it('skips invalid job geometry without emitting NaN into CSS', () => {
    for (const job of [
      { ...base, width: NaN },
      { ...base, rect: { ...base.rect, left: Infinity } },
      { ...base, points: [{ x: 0, y: NaN }] },
    ]) expect(celebrationClipPath([job], 1000, viewport)).toBe("path('M0 0Z')");
  });
});
