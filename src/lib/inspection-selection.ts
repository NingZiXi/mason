import type { InspectionPad, InspectionPolygon, InspectionRing } from './stencil-inspection';

export interface SelectionPoint { x: number; y: number }
export interface SelectionRect { x: number; y: number; width: number; height: number }
export type SelectionOperation = 'replace' | 'add' | 'toggle';
export interface SelectionPad { sourceIndex: number; bounds: SelectionRect; polygons: InspectionPolygon[] }

export function selectionRect(a: SelectionPoint, b: SelectionPoint): SelectionRect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) };
}

/** Cache bounds in SVG coordinates once per engine result. */
export function prepareSelectionPads(pads: InspectionPad[]): SelectionPad[] {
  return pads.map(pad => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const polygon of pad.polygons) for (const [x, y] of polygon.outer) {
      x0 = Math.min(x0, x); x1 = Math.max(x1, x);
      y0 = Math.min(y0, -y); y1 = Math.max(y1, -y);
    }
    return { sourceIndex: pad.sourceIndex, polygons: pad.polygons,
      bounds: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } };
  }).filter(pad => Number.isFinite(pad.bounds.x) && Number.isFinite(pad.bounds.y));
}

const contains = (rect: SelectionRect, x: number, y: number) => x >= rect.x && x <= rect.x + rect.width
  && y >= rect.y && y <= rect.y + rect.height;
function inRing(x: number, y: number, ring: InspectionRing) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// Liang–Barsky clipping: a segment intersects the rectangular window.
function segmentIntersects(ax: number, ay: number, bx: number, by: number, rect: SelectionRect) {
  let lo = 0, hi = 1;
  const dx = bx - ax, dy = by - ay;
  for (const [p, q] of [[-dx, ax - rect.x], [dx, rect.x + rect.width - ax],
    [-dy, ay - rect.y], [dy, rect.y + rect.height - ay]]) {
    if (Math.abs(p) < 1e-12) { if (q < 0) return false; continue; }
    const t = q / p;
    if (p < 0) lo = Math.max(lo, t); else hi = Math.min(hi, t);
    if (lo > hi) return false;
  }
  return true;
}

function polygonIntersects(polygon: InspectionPolygon, rect: SelectionRect) {
  for (const ring of [polygon.outer, ...polygon.holes]) {
    for (let i = 0; i < ring.length; i++) {
      const [ax, ay] = ring[i], [bx, by] = ring[(i + 1) % ring.length];
      if (contains(rect, ax, ay) || segmentIntersects(ax, ay, bx, by, rect)) return true;
    }
  }
  return [[rect.x, rect.y], [rect.x + rect.width, rect.y], [rect.x, rect.y + rect.height],
    [rect.x + rect.width, rect.y + rect.height]].some(([x, y]) =>
    inRing(x, y, polygon.outer) && !polygon.holes.some(hole => inRing(x, y, hole)));
}

/** Select every pad touched by the box, respecting shape and interior voids.
 * Source polygons use engine Y; the gesture rectangle uses SVG Y. */
export function padsInSelection(pads: readonly SelectionPad[], rect: SelectionRect): number[] {
  const engineRect = { ...rect, y: -rect.y - rect.height };
  return pads.filter(pad => {
    const b = pad.bounds;
    return b.x <= rect.x + rect.width && b.x + b.width >= rect.x
      && b.y <= rect.y + rect.height && b.y + b.height >= rect.y
      && pad.polygons.some(polygon => polygonIntersects(polygon, engineRect));
  }).map(pad => pad.sourceIndex);
}

export function mergeSelection(current: readonly number[], hits: readonly number[], operation: SelectionOperation) {
  const result = new Set(operation === 'replace' ? [] : current);
  for (const index of new Set(hits)) {
    if (operation === 'toggle' && result.has(index)) result.delete(index);
    else result.add(index);
  }
  return [...result].sort((a, b) => a - b);
}
