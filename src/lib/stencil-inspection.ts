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
  shortEdge: number; area: number;
  decision: 'auto' | 'open' | 'closed';
}
export interface ApertureOverlap { sourceIndices: number[]; polygons: InspectionPolygon[] }
export interface StencilInspection {
  side: 'top' | 'bottom'; mirrored: boolean;
  outline: InspectionPolygon[]; original: InspectionPolygon[]; openings: InspectionPolygon[];
  filtered: FilteredPad[];
  pads: InspectionPad[];
  overlaps: ApertureOverlap[];
  summary: { sourcePads: number; filteredPads: number; openings: number; invalidPads: number };
}
export interface InspectionViewport { x: number; y: number; width: number; height: number }

export function polygonPath(polygons: InspectionPolygon[]) {
  return polygons.flatMap(polygon => [polygon.outer, ...polygon.holes])
    .filter(ring => ring.length >= 3)
    .map(ring => `M${ring.map(([x, y]) => `${x},${-y}`).join('L')}Z`).join(' ');
}

/** Match the engine's area centroid relative to the SVG path's fill-box. */
export function inspectionScaleOrigin(polygons: InspectionPolygon[]): { x: number; y: number } | null {
  let left = Infinity, top = -Infinity;
  for (const { outer } of polygons) {
    if (outer.length < 3) continue;
    for (const [x, y] of outer) {
      left = Math.min(left, x);
      top = Math.max(top, y);
    }
  }
  if (!Number.isFinite(left) || !Number.isFinite(top)) return null;

  let area = 0, momentX = 0, momentY = 0;
  function addRing(ring: InspectionRing, sign: number) {
    if (ring.length < 3) return;
    const [x0, y0] = ring[0];
    let twiceArea = 0, xMoment = 0, yMoment = 0;
    // Work relative to a vertex so coordinates far from (0, 0) retain precision.
    for (let i = 1; i + 1 < ring.length; i++) {
      const [ax, ay] = ring[i], [bx, by] = ring[i + 1];
      const ux = ax - x0, uy = ay - y0, vx = bx - x0, vy = by - y0;
      const cross = ux * vy - uy * vx;
      twiceArea += cross;
      xMoment += (ux + vx) * cross;
      yMoment += (uy + vy) * cross;
    }
    const direction = sign * Math.sign(twiceArea);
    const weight = direction * twiceArea; // Signed double area, independent of winding.
    area += weight;
    momentX += weight * (x0 - left) + direction * xMoment / 3;
    momentY += weight * (top - y0) - direction * yMoment / 3;
  }
  for (const { outer, holes } of polygons) {
    if (outer.length < 3) continue;
    addRing(outer, 1);
    for (const hole of holes) addRing(hole, -1);
  }
  if (!(area > 0)) return null;
  const x = momentX / area, y = momentY / area;
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
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
