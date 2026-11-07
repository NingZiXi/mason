import { describe, expect, it } from 'vitest';
import { mergeSelection, padsInSelection, prepareSelectionPads, selectionRect } from '../inspection-selection';
import type { InspectionPad, InspectionPolygon } from '../stencil-inspection';

const pad = (sourceIndex: number, polygons: InspectionPolygon[]): InspectionPad => ({ sourceIndex, polygons, width: 4, height: 4, decision: 'auto' });
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
  it('replaces, adds and toggles a selection once per unique pad', () => {
    expect(mergeSelection([1, 3], [3, 5], 'replace')).toEqual([3, 5]);
    expect(mergeSelection([1, 3], [3, 5], 'add')).toEqual([1, 3, 5]);
    expect(mergeSelection([1, 3], [3, 3, 5], 'toggle')).toEqual([1, 5]);
    expect(mergeSelection([1, 3], [], 'replace')).toEqual([]);
    expect(mergeSelection([1, 3], [], 'add')).toEqual([1, 3]);
  });
});
