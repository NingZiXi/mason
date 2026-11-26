import { describe, expect, it } from 'vitest';
import { indexPadSizes, mergeSelection, padsInSelection, prepareSelectionPads, selectionRect } from '../inspection-selection';
import type { InspectionPad, InspectionPolygon } from '../stencil-inspection';

const pad = (sourceIndex: number, polygons: InspectionPolygon[]): InspectionPad => ({ sourceIndex, polygons, width: 4, height: 4, shortEdge: 4, area: 16, decision: 'auto' });
const square: InspectionPolygon = { outer: [[0, 0], [4, 0], [4, 4], [0, 4]], holes: [] };

describe('inspection box selection', () => {
  it('normalizes a box dragged in any direction and matches mirrored SVG coordinates', () => {
    const prepared = prepareSelectionPads([pad(7, [square])]);
    const a = { x: 3, y: -3 }, b = { x: 1, y: -1 };
    expect(selectionRect(a, b)).toEqual(selectionRect(b, a));
    expect(padsInSelection(prepared, selectionRect(a, b))).toEqual([7]);
    expect(padsInSelection(prepared, { x: 1, y: 1, width: 2, height: 2 })).toEqual([]);
  });
  it('selects shapes crossing the box edge without selecting empty bounding-box corners', () => {
    const triangle: InspectionPolygon = { outer: [[0, 0], [4, 0], [0, 4]], holes: [] };
    const prepared = prepareSelectionPads([pad(3, [triangle])]);
    expect(padsInSelection(prepared, { x: 3, y: -4, width: 1, height: 1 })).toEqual([]);
    expect(padsInSelection(prepared, { x: -1, y: -1, width: 6, height: .1 })).toEqual([3]);
  });
  it('ignores a box entirely inside an interior hole and handles multipart and tiny pads', () => {
    const ring: InspectionPolygon = { ...square, holes: [[[1, 1], [3, 1], [3, 3], [1, 3]]] };
    const tiny: InspectionPolygon = { outer: [[10, 0], [10.01, 0], [10.01, .01], [10, .01]], holes: [] };
    const prepared = prepareSelectionPads([pad(2, [ring]), pad(8, [tiny, { ...tiny, outer: tiny.outer.map(([x, y]) => [x + 5, y]) }])]);
    expect(padsInSelection(prepared, { x: 1.5, y: -2.5, width: 1, height: 1 })).toEqual([]);
    expect(padsInSelection(prepared, { x: .5, y: -2, width: 1, height: .5 })).toEqual([2]);
    expect(padsInSelection(prepared, { x: 14.9, y: -.1, width: .3, height: .3 })).toEqual([8]);
  });
  it('indexes original short edges and areas as cumulative slider thresholds', () => {
    const pads = [
      { ...pad(9, [square]), shortEdge: 1.25, area: .5 },
      { ...pad(3, [square]), shortEdge: .5 + 2e-16, area: 2.00124 },
      { ...pad(11, [square]), shortEdge: .5007, area: .8 },
      { ...pad(8, [square]), shortEdge: .4999, area: .5 + 2e-16 },
    ];
    const edges = indexPadSizes(pads, 'shortEdge');
    expect(edges.steps).toEqual([{ limit: .5, count: 2 }, { limit: .501, count: 3 }, { limit: 1.25, count: 4 }]);
    expect(edges.steps.map(step => new Set(edges.padIds.slice(0, step.count)))).toEqual([
      new Set([3, 8]), new Set([3, 8, 11]), new Set([3, 8, 11, 9]),
    ]);
    const areas = indexPadSizes(pads, 'area');
    expect(areas.steps).toEqual([{ limit: .5, count: 2 }, { limit: .8, count: 3 }, { limit: 2.0013, count: 4 }]);
    expect(areas.steps.map(step => new Set(areas.padIds.slice(0, step.count)))).toEqual([
      new Set([9, 8]), new Set([9, 8, 11]), new Set([9, 8, 11, 3]),
    ]);
  });
  it('ignores invalid sizes for the chosen metric and keeps a tiny positive pad selectable', () => {
    const pads = [0, -1, NaN, Infinity, -Infinity].map((shortEdge, i) => ({ ...pad(i, [square]), shortEdge }));
    expect(indexPadSizes(pads, 'shortEdge')).toEqual({ steps: [], padIds: [] });
    expect(indexPadSizes([...pads, { ...pad(7, [square]), shortEdge: .0000001 }], 'shortEdge')).toEqual({
      steps: [{ limit: .001, count: 1 }], padIds: [7],
    });
    expect(indexPadSizes(pads, 'area').steps).toEqual([{ limit: 16, count: 5 }]);
  });
  it('replaces, adds and toggles a selection once per unique pad', () => {
    expect(mergeSelection([1, 3], [3, 5], 'replace')).toEqual([3, 5]);
    expect(mergeSelection([1, 3], [3, 5], 'add')).toEqual([1, 3, 5]);
    expect(mergeSelection([1, 3], [3, 3, 5], 'toggle')).toEqual([1, 5]);
    expect(mergeSelection([1, 3], [], 'replace')).toEqual([]);
    expect(mergeSelection([1, 3], [], 'add')).toEqual([1, 3]);
  });
});
