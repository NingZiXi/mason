export type InspectionRing = [number, number][];
export interface InspectionPolygon { outer: InspectionRing; holes: InspectionRing[] }
export interface FilteredPad {
  sourceIndex: number;
  reason: 'explicit' | 'inferred' | 'probe';
  polygons: InspectionPolygon[];
  width: number; height: number;
}
export interface InspectionPad {
  sourceIndex: number;
  polygons: InspectionPolygon[];
  width: number; height: number;
  decision: 'auto' | 'open' | 'closed';
}
export interface StencilInspection {
  side: 'top' | 'bottom'; mirrored: boolean;
  outline: InspectionPolygon[]; original: InspectionPolygon[]; openings: InspectionPolygon[];
  filtered: FilteredPad[];
  pads: InspectionPad[];
  summary: { sourcePads: number; filteredPads: number; openings: number; invalidPads: number };
}
export interface InspectionViewport { x: number; y: number; width: number; height: number }

export function polygonPath(polygons: InspectionPolygon[]) {
  return polygons.flatMap(polygon => [polygon.outer, ...polygon.holes])
    .filter(ring => ring.length >= 3)
    .map(ring => `M${ring.map(([x, y]) => `${x},${-y}`).join('L')}Z`).join(' ');
}

export function inspectionBounds(data: StencilInspection): InspectionViewport {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const polygon of [...data.outline, ...data.original, ...data.openings, ...data.filtered.flatMap(pad => pad.polygons)]) {
    for (const [x, y] of polygon.outer) {
      x0 = Math.min(x0, x); x1 = Math.max(x1, x);
      y0 = Math.min(y0, -y); y1 = Math.max(y1, -y);
    }
  }
  if (!Number.isFinite(x0)) return { x: -10, y: -10, width: 20, height: 20 };
  const margin = Math.max(x1 - x0, y1 - y0, 1) * .08;
  return { x: x0 - margin, y: y0 - margin, width: x1 - x0 + margin * 2, height: y1 - y0 + margin * 2 };
}

/** Preserve the world coordinate under the cursor when zooming. */
export function zoomViewport(view: InspectionViewport, ratio: number, anchor: { x: number; y: number }): InspectionViewport {
  return { x: anchor.x - (anchor.x - view.x) * ratio, y: anchor.y - (anchor.y - view.y) * ratio,
    width: view.width * ratio, height: view.height * ratio };
}
