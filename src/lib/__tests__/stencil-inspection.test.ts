import { describe, expect, it } from 'vitest';
import { inspectionBounds, polygonPath, zoomViewport, type StencilInspection } from '../stencil-inspection';

describe('inspection viewport geometry', () => {
  it('preserves interior rings and flips Y only for SVG display', () => {
    expect(polygonPath([{ outer: [[0, 0], [4, 0], [4, 4]], holes: [[[1, 1], [2, 1], [2, 2]]] }]))
      .toBe('M0,0L4,0L4,-4Z M1,-1L2,-1L2,-2Z');
  });
  it('fits source pads outside the board instead of silently hiding them', () => {
    const data: StencilInspection = { side: 'top', mirrored: true,
      outline: [{ outer: [[-5, -5], [5, -5], [5, 5]], holes: [] }],
      original: [{ outer: [[20, 10], [21, 10], [21, 11]], holes: [] }], openings: [], filtered: [], pads: [],
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
