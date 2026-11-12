import { describe, expect, it } from 'vitest';
import { reliefPadGuide } from '../relief-pad-guide';
import type { PadPart, PadPolygon } from '../gerber/pads';

const rect = (x0: number, y0: number, x1: number, y1: number): Array<[number, number]> =>
  [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
const part = (points = rect(-5, -5, 5, 5), polarity: 'D' | 'C' = 'D', holes?: Array<Array<[number, number]>>): PadPart =>
  ({ points, polarity, ...(holes ? { holes } : {}) });
const pad = (parts = [part()], polarity: 'D' | 'C' = 'D'): PadPolygon =>
  ({ type: 'macro', cx: 0, cy: 0, polarity, parts });

/** Evaluate the SVG nonzero rule, including each separately closed contour. */
function filled(path: string, x: number, y: number): boolean {
  let winding = 0;
  for (const subpath of path.match(/M[^Z]+Z/g) ?? []) {
    const points = subpath.slice(1, -1).split('L').map(point => point.split(',').map(Number));
    for (let i = 0; i < points.length; i++) {
      const a = points[i], b = points[(i + 1) % points.length];
      const cross = (b[0] - a[0]) * (y - a[1]) - (x - a[0]) * (b[1] - a[1]);
      if (a[1] <= y && b[1] > y && cross > 0) winding++;
      if (a[1] > y && b[1] <= y && cross < 0) winding--;
    }
  }
  return winding !== 0;
}
function visible(guide: ReturnType<typeof reliefPadGuide>, x: number, y: number): boolean {
  const paint = (exposures: typeof guide.exposures, local = false) => {
    let material = false;
    for (const exposure of exposures) {
      if (!filled(exposure.path, x, y)) continue;
      if (!local && exposure.maskIndex !== undefined) {
        const mask = guide.masked.find(item => item.sourceIndex === exposure.maskIndex)!;
        if (!paint(mask.exposures, true)) continue;
      }
      material = exposure.polarity === 'D';
    }
    return material;
  };
  return paint(guide.exposures);
}

describe('relief editor pad reference mask', () => {
  it('unions overlapping and repeated positive pads regardless of their winding', () => {
    const points = rect(-5, -5, 5, 5);
    const source = [pad([part(points)]), pad([part([...points].reverse())]), pad([part(rect(0, -5, 8, 5))])];
    const original = JSON.stringify(source);
    const guide = reliefPadGuide(source);
    expect(guide.masked).toHaveLength(0);
    expect(guide.exposures).toHaveLength(1);
    expect(visible(guide, 0, 0)).toBe(true);
    expect(visible(guide, 4, 0)).toBe(true);
    expect(visible(guide, 7, 0)).toBe(true);
    expect(JSON.stringify(source)).toBe(original);
  });

  it('preserves a pad hole while allowing another positive pad to fill it', () => {
    const ring = pad([part(rect(-5, -5, 5, 5), 'D', [rect(-2, -2, 2, 2)])]);
    expect(visible(reliefPadGuide([ring]), 0, 0)).toBe(false);
    expect(visible(reliefPadGuide([ring]), 4, 0)).toBe(true);
    expect(visible(reliefPadGuide([ring, pad([part(rect(-1, -1, 1, 1))])]), 0, 0)).toBe(true);
  });

  it('unions repeated clear exposures instead of restoring their overlap', () => {
    const clear = rect(-2, -2, 2, 2);
    const guide = reliefPadGuide([pad(), pad([part(clear)], 'C'), pad([part([...clear].reverse())], 'C')]);
    expect(visible(guide, 0, 0)).toBe(false);
    expect(visible(guide, 4, 0)).toBe(true);
  });

  it('keeps clear macro parts local to their own aperture', () => {
    const macro = pad([part(), part(rect(-2, -2, 2, 2), 'C')]);
    const guide = reliefPadGuide([macro, pad([part(rect(-1, -1, 1, 1))])]);
    expect(guide.masked).toHaveLength(1);
    expect(visible(guide, 0, 0)).toBe(true);
    expect(visible(guide, 1.5, 0)).toBe(false);
    expect(visible(guide, 4, 0)).toBe(true);
  });

  it('preserves the internal opening of a clear macro and ignores empty parts', () => {
    const clearMacro = pad([part(rect(-3, -3, 3, 3)), part(rect(-1, -1, 1, 1), 'C')], 'C');
    const guide = reliefPadGuide([pad(), clearMacro, pad([part([], 'C')])]);
    expect(guide.masked).toHaveLength(1);
    expect(visible(guide, 0, 0)).toBe(true);
    expect(visible(guide, 2, 0)).toBe(false);
    expect(visible(guide, 4, 0)).toBe(true);
  });

  it('allows a later dark image exposure to refill a cleared area', () => {
    const refill = pad([part(rect(-1, -1, 1, 1))]);
    const clear = pad([part(rect(-3, -3, 3, 3))], 'C');
    expect(visible(reliefPadGuide([clear, refill]), 0, 0)).toBe(true);
    const guide = reliefPadGuide([pad(), clear, refill]);
    expect(visible(guide, 0, 0)).toBe(true);
    expect(visible(guide, 2, 0)).toBe(false);
    expect(visible(guide, 4, 0)).toBe(true);
  });

  it('applies macro primitives in order before placing the aperture on the image', () => {
    const clear = part(rect(-3, -3, 3, 3), 'C');
    const refill = part(rect(-1, -1, 1, 1));
    expect(visible(reliefPadGuide([pad([clear, refill])]), 0, 0)).toBe(true);
    const macro = pad([part(), clear, refill]);
    const guide = reliefPadGuide([macro]);
    expect(visible(guide, 0, 0)).toBe(true);
    expect(visible(guide, 2, 0)).toBe(false);
    expect(visible(guide, 4, 0)).toBe(true);
    // A clear macro erases only its own positive material, preserving its hole.
    const inverted = reliefPadGuide([pad(), { ...macro, polarity: 'C' }]);
    expect(visible(inverted, 0, 0)).toBe(false);
    expect(visible(inverted, 2, 0)).toBe(true);
    expect(visible(inverted, 4, 0)).toBe(false);
  });

  it('keeps dense ordinary layers in one path and batches only adjacent polarities', () => {
    const positives = Array.from({ length: 2000 }, (_, i) => pad([part(rect(i, 0, i + .5, .5))]));
    const guide = reliefPadGuide(positives);
    expect(guide.exposures).toHaveLength(1);
    expect(guide.masked).toHaveLength(0);
    const mixed = reliefPadGuide([...positives, pad([part()], 'C'), pad([part()], 'C'), ...positives]);
    expect(mixed.exposures.map(exposure => exposure.polarity)).toEqual(['D', 'C', 'D']);
  });
});
