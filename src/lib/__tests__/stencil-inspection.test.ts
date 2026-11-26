import { describe, expect, it } from 'vitest';
import { inspectionBounds, inspectionScaleOrigin, polygonPath, zoomViewport, type InspectionRing, type StencilInspection } from '../stencil-inspection';

describe('inspection viewport geometry', () => {
  it('preserves interior rings and flips Y only for SVG display', () => {
    expect(polygonPath([{ outer: [[0, 0], [4, 0], [4, 4]], holes: [[[1, 1], [2, 1], [2, 2]]] }]))
      .toBe('M0,0L4,0L4,-4Z M1,-1L2,-1L2,-2Z');
  });
  it('fits source pads outside the board instead of silently hiding them', () => {
    const data: StencilInspection = { side: 'top', mirrored: true,
      outline: [{ outer: [[-5, -5], [5, -5], [5, 5]], holes: [] }],
      original: [{ outer: [[20, 10], [21, 10], [21, 11]], holes: [] }], openings: [], filtered: [], pads: [], overlaps: [],
      summary: { sourcePads: 1, openings: 0, filteredPads: 0, invalidPads: 0 } };
    const bounds = inspectionBounds(data);
    expect(bounds.x).toBeLessThan(-5);
    expect(bounds.x + bounds.width).toBeGreaterThan(21);
    expect(bounds.y).toBeLessThan(-11);
    expect(bounds.y + bounds.height).toBeGreaterThan(5);
  });
  it('keeps the point under the zoom cursor fixed', () => {
    const view = { x: -20, y: -10, width: 100, height: 60 }, anchor = { x: 10, y: 5 };
    const zoomed = zoomViewport(view, .5, anchor);
    expect((anchor.x - zoomed.x) / zoomed.width).toBeCloseTo((anchor.x - view.x) / view.width);
    expect((anchor.y - zoomed.y) / zoomed.height).toBeCloseTo((anchor.y - view.y) / view.height);
    expect(zoomViewport(zoomed, 2, anchor)).toEqual(view);
  });
});

describe('inspection aperture scale origins', () => {
  it.each([0, 2 ** 40])('finds the centroid of a concave pad at coordinate offset %s', offset => {
    const outline: InspectionRing = [[0, 0], [4, 0], [4, 1], [1, 1], [1, 4], [0, 4], [0, 0]];
    const outer = outline.map(([x, y]): [number, number] => [x + offset, y - offset]);
    const origin = inspectionScaleOrigin([{ outer, holes: [] }]);
    // Union of a 4×1 base and a 1×3 stem; neither axis uses the box midpoint.
    expect(origin?.x).toBeCloseTo(19 / 14, 10);
    expect(origin?.y).toBeCloseTo(37 / 14, 10);
  });

  it.each([false, true])('subtracts an off-center hole and includes a separate island (reverse hole: %s)', reverse => {
    const outer: InspectionRing = [[-5, -2], [1, -2], [1, 2], [-5, 2]];
    const hole: InspectionRing = [[-1, 0], [0, 0], [0, 1], [-1, 1]];
    const island: InspectionRing = [[3, 3], [5, 3], [5, 1], [3, 1]]; // Opposite winding to the first outer ring.
    const origin = inspectionScaleOrigin([{ outer, holes: [reverse ? hole.reverse() : hole] },
      { outer: island, holes: [] }]);
    expect(origin?.x).toBeCloseTo(23 / 6, 10);
    expect(origin?.y).toBeCloseTo(49 / 18, 10);
  });

  it('rejects missing and zero-area shapes', () => {
    expect(inspectionScaleOrigin([])).toBeNull();
    expect(inspectionScaleOrigin([{ outer: [[2, 2], [4, 4], [6, 6]], holes: [] }])).toBeNull();
  });
});
