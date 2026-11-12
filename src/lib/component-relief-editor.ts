import { MAX_RELIEF_VERTICES, type ComponentReliefRegion } from './component-relief';

export interface ReliefPoint { x: number; y: number }
export interface ReliefBounds { minX: number; minY: number; maxX: number; maxY: number }
export interface ReliefView { x: number; y: number; width: number; height: number }
export type ReliefCorner = 'nw' | 'ne' | 'sw' | 'se';
const MIN_SIZE = 0.5;
const finite = (value: number, fallback: number) => Number.isFinite(value) ? value : fallback;
const round = (value: number) => Math.round(value * 1000) / 1000;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

/** SVG meet fitting may be constrained by either axis. Keep grips and labels
 * the same screen size for portrait boards and after the editor is resized. */
export function reliefHandleSize(view: ReliefView, viewportWidth: number, viewportHeight: number): number {
  const width = Math.max(1, finite(viewportWidth, 600)), height = Math.max(1, finite(viewportHeight, 400));
  return Math.max(view.width / width, view.height / height) * 8;
}
type Ring = ReadonlyArray<readonly [number, number]>;
const EPSILON = 1e-8;
const cross = (a: readonly number[], b: readonly number[], c: readonly number[]) =>
  (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
const samePoint = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0] - b[0], a[1] - b[1]) <= 1e-6;
function pointOnSegment(point: readonly number[], a: readonly number[], b: readonly number[]) {
  return Math.abs(cross(a, b, point)) <= EPSILON && point[0] >= Math.min(a[0], b[0]) - EPSILON
    && point[0] <= Math.max(a[0], b[0]) + EPSILON && point[1] >= Math.min(a[1], b[1]) - EPSILON
    && point[1] <= Math.max(a[1], b[1]) + EPSILON;
}
function segmentsMeet(a: readonly number[], b: readonly number[], c: readonly number[], d: readonly number[]) {
  const abC = cross(a, b, c), abD = cross(a, b, d), cdA = cross(c, d, a), cdB = cross(c, d, b);
  return (((abC > EPSILON && abD < -EPSILON) || (abC < -EPSILON && abD > EPSILON))
    && ((cdA > EPSILON && cdB < -EPSILON) || (cdA < -EPSILON && cdB > EPSILON)))
    || pointOnSegment(a, c, d) || pointOnSegment(b, c, d) || pointOnSegment(c, a, b) || pointOnSegment(d, a, b);
}

/** Keep the bounding box derived from the real vertices, including during a drag. */
export function reliefPolygonRegion(points: Ring, id: string, depth?: number): ComponentReliefRegion {
  const copy: Array<[number, number]> = points.map(([x, y]) => [round(x), round(y)]);
  const xs = copy.map(point => point[0]), ys = copy.map(point => point[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  return { id, shape: 'polygon', points: copy, x: round((minX + maxX) / 2), y: round((minY + maxY) / 2),
    width: round(maxX - minX), height: round(maxY - minY), ...(depth !== undefined ? { depth } : {}) };
}

export function isValidReliefPolygon(points: Ring): boolean {
  if (points.length < 3 || points.length > MAX_RELIEF_VERTICES
    || points.some(([x, y]) => !Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 600 || Math.abs(y) > 600)) return false;
  let twiceArea = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length], c = points[(i + 2) % points.length];
    if (samePoint(a, b)) return false;
    // Adjacent edges may be collinear, but must not fold back over one another.
    if (Math.abs(cross(a, b, c)) <= EPSILON && (b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1]) < 0) return false;
    twiceArea += a[0] * b[1] - b[0] * a[1];
    for (let j = i + 1; j < points.length; j++) {
      if (j === i + 1 || i === 0 && j === points.length - 1) continue;
      if (segmentsMeet(a, b, points[j], points[(j + 1) % points.length])) return false;
    }
  }
  const region = reliefPolygonRegion(points, 'validate');
  return Math.abs(twiceArea) >= 2e-4 && region.width >= MIN_SIZE && region.height >= MIN_SIZE;
}

export function createReliefPolygon(points: Ring, id: string, depth?: number): ComponentReliefRegion | null {
  const copy = points.length > 1 && samePoint(points[0], points[points.length - 1]) ? points.slice(0, -1) : points;
  const region = reliefPolygonRegion(copy, id, depth);
  return isValidReliefPolygon(region.points!) ? region : null;
}

/** Prevent a new open segment crossing an already drawn part of the outline. */
export function canAppendReliefVertex(points: Ring, next: readonly [number, number]): boolean {
  if (points.length >= MAX_RELIEF_VERTICES || !next.every(Number.isFinite) || next.some(value => Math.abs(value) > 600)) return false;
  if (!points.length) return true;
  const last = points[points.length - 1];
  if (samePoint(last, next) || points.some(point => samePoint(point, next))) return false;
  if (points.length > 1) {
    const previous = points[points.length - 2];
    if (Math.abs(cross(previous, last, next)) <= EPSILON
      && (last[0] - previous[0]) * (next[0] - last[0]) + (last[1] - previous[1]) * (next[1] - last[1]) < 0) return false;
  }
  for (let i = 0; i < points.length - 2; i++) if (segmentsMeet(last, next, points[i], points[i + 1])) return false;
  return true;
}

function transformReliefRegion(region: ComponentReliefRegion, box: Pick<ComponentReliefRegion, 'x' | 'y' | 'width' | 'height'>): ComponentReliefRegion {
  if (region.shape !== 'polygon' || !region.points?.length) return { ...region, ...box };
  return { ...region, ...reliefPolygonRegion(region.points.map(([x, y]) => [
    box.x + (x - region.x) * box.width / region.width,
    box.y + (y - region.y) * box.height / region.height,
  ]), region.id) };
}

export function updateReliefVertex(region: ComponentReliefRegion, index: number, point: ReliefPoint,
  bounds: ReliefBounds): ComponentReliefRegion {
  if (region.shape !== 'polygon' || !region.points || index < 0 || index >= region.points.length) return region;
  const clamped = clampReliefPoint(point, bounds);
  return { ...region, ...reliefPolygonRegion(region.points.map((vertex, i) => i === index ? [clamped.x, clamped.y] : vertex), region.id) };
}

export function reliefEditorBounds(outline: ReadonlyArray<readonly [number, number]>, width: number, height: number): ReliefBounds {
  const points = outline.filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
  if (points.length >= 3) {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const [x, y] of points) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
    if (maxX - minX >= MIN_SIZE && maxY - minY >= MIN_SIZE) return { minX, maxX, minY, maxY };
  }
  const w = Math.max(1, finite(width, 50)), h = Math.max(1, finite(height, 50));
  return { minX: -w / 2, maxX: w / 2, minY: -h / 2, maxY: h / 2 };
}

export function clampReliefPoint(point: ReliefPoint, bounds: ReliefBounds): ReliefPoint {
  return { x: clamp(point.x, bounds.minX, bounds.maxX), y: clamp(point.y, bounds.minY, bounds.maxY) };
}

/** Canonical imported coordinates remain unchanged when the PCB is flipped. */
export function reliefScreenPoint(point: ReliefPoint, side: 'top' | 'bottom'): ReliefPoint {
  return { x: point.x, y: side === 'top' ? -point.y : point.y };
}

export function fitReliefView(bounds: ReliefBounds, side: 'top' | 'bottom'): ReliefView {
  const padding = Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY) * 0.12 + 1;
  const a = reliefScreenPoint({ x: bounds.minX, y: bounds.minY }, side);
  const b = reliefScreenPoint({ x: bounds.maxX, y: bounds.maxY }, side);
  return { x: Math.min(a.x, b.x) - padding, y: Math.min(a.y, b.y) - padding,
    width: bounds.maxX - bounds.minX + 2 * padding, height: bounds.maxY - bounds.minY + 2 * padding };
}

export function drawReliefRegion(shape: 'rect' | 'circle', start: ReliefPoint, end: ReliefPoint,
  bounds: ReliefBounds, id: string, depth?: number): ComponentReliefRegion | null {
  const a = clampReliefPoint(start, bounds), b = clampReliefPoint(end, bounds);
  let width = Math.abs(b.x - a.x), height = Math.abs(b.y - a.y);
  if (shape === 'circle') width = height = Math.min(width, height);
  if (width < MIN_SIZE || height < MIN_SIZE) return null;
  const x = a.x + Math.sign(b.x - a.x) * width / 2;
  const y = a.y + Math.sign(b.y - a.y) * height / 2;
  return { id, shape, x: round(x), y: round(y), width: round(width), height: round(height), ...(depth !== undefined ? { depth } : {}) };
}

export function moveReliefRegion(region: ComponentReliefRegion, delta: ReliefPoint, bounds: ReliefBounds): ComponentReliefRegion {
  return transformReliefRegion(region, { width: region.width, height: region.height,
    x: round(clamp(region.x + delta.x, bounds.minX + region.width / 2, bounds.maxX - region.width / 2)),
    y: round(clamp(region.y + delta.y, bounds.minY + region.height / 2, bounds.maxY - region.height / 2)) });
}

/** The opposite corner stays fixed; a circle stays circular in every quadrant. */
export function resizeReliefRegion(region: ComponentReliefRegion, corner: ReliefCorner, point: ReliefPoint,
  bounds: ReliefBounds): ComponentReliefRegion {
  const left = corner.endsWith('w'), lower = corner.startsWith('s');
  const anchor = { x: region.x + (left ? 1 : -1) * region.width / 2,
    y: region.y + (lower ? 1 : -1) * region.height / 2 };
  const end = clampReliefPoint(point, bounds);
  const sx = left ? -1 : 1, sy = lower ? -1 : 1;
  let width = Math.max(MIN_SIZE, sx * (end.x - anchor.x));
  let height = Math.max(MIN_SIZE, sy * (end.y - anchor.y));
  width = Math.min(width, sx < 0 ? anchor.x - bounds.minX : bounds.maxX - anchor.x);
  height = Math.min(height, sy < 0 ? anchor.y - bounds.minY : bounds.maxY - anchor.y);
  if (region.shape === 'circle') width = height = Math.min(width, height);
  return transformReliefRegion(region, { x: round(anchor.x + sx * width / 2), y: round(anchor.y + sy * height / 2),
    width: round(width), height: round(height) });
}

export function updateReliefDimensions(region: ComponentReliefRegion, change: Partial<Pick<ComponentReliefRegion, 'x' | 'y' | 'width' | 'height'>>,
  bounds: ReliefBounds): ComponentReliefRegion {
  // Number inputs emit their current value again on blur/Enter. Merged
  // polygons can contain more precision than the compact property fields
  // display, so rounding the whole region in that case would turn a no-op
  // into a geometry edit. Preserve the source object when every requested
  // field is exactly its current value; a deliberately rounded value still
  // flows through the normal clamping/scaling path below.
  const requested = Object.entries(change).filter(([, value]) => value !== undefined);
  if (requested.length > 0 && requested.every(([key, value]) => value === region[key as keyof typeof region])) return region;
  let width = clamp(finite(change.width ?? region.width, region.width), MIN_SIZE, bounds.maxX - bounds.minX);
  let height = clamp(finite(change.height ?? region.height, region.height), MIN_SIZE, bounds.maxY - bounds.minY);
  if (region.shape === 'circle') {
    const diameter = change.width !== undefined ? width : change.height !== undefined ? height : Math.min(width, height);
    width = height = Math.min(diameter, bounds.maxX - bounds.minX, bounds.maxY - bounds.minY);
  }
  return transformReliefRegion(region, { width: round(width), height: round(height),
    x: round(clamp(finite(change.x ?? region.x, region.x), bounds.minX + width / 2, bounds.maxX - width / 2)),
    y: round(clamp(finite(change.y ?? region.y, region.y), bounds.minY + height / 2, bounds.maxY - height / 2)) });
}

export function zoomReliefView(view: ReliefView, anchor: ReliefPoint, factor: number, fit: ReliefView): ReliefView {
  const width = clamp(view.width / factor, fit.width / 20, fit.width * 3);
  const ratio = width / view.width;
  return { x: anchor.x - (anchor.x - view.x) * ratio, y: anchor.y - (anchor.y - view.y) * ratio,
    width, height: view.height * ratio };
}

function pointInRing(point: ReliefPoint, ring: ReadonlyArray<readonly [number, number]>): boolean {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
    const [x, y] = ring[index], [px, py] = ring[previous];
    if ((y > point.y) !== (py > point.y) && point.x < (px - x) * (point.y - y) / (py - y) + x) inside = !inside;
  }
  return inside;
}

/** Select every region touched by a marquee in canonical board coordinates.
 * Circle corners and concave polygon gaps must remain empty even when their
 * bounding boxes overlap the marquee. Input order and region data are retained. */
export function reliefRegionsInMarquee(regions: readonly ComponentReliefRegion[], start: ReliefPoint, end: ReliefPoint): string[] {
  if (![start.x, start.y, end.x, end.y].every(Number.isFinite)) return [];
  const minX = Math.min(start.x, end.x), maxX = Math.max(start.x, end.x);
  const minY = Math.min(start.y, end.y), maxY = Math.max(start.y, end.y);
  const corners: Array<[number, number]> = [[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY]];
  const inMarquee = ([x, y]: readonly [number, number]) => x >= minX - EPSILON && x <= maxX + EPSILON
    && y >= minY - EPSILON && y <= maxY + EPSILON;
  return regions.filter(region => {
    if (region.shape === 'polygon') {
      const points = region.points ?? [];
      if (points.length < 3 || points.some(point => !point.every(Number.isFinite))) return false;
      return points.some(inMarquee) || corners.some(([x, y]) => pointInRing({ x, y }, points))
        || points.some((a, i) => corners.some((c, j) => segmentsMeet(a, points[(i + 1) % points.length], c, corners[(j + 1) % corners.length])));
    }
    if (![region.x, region.y, region.width, region.height].every(Number.isFinite) || region.width <= 0 || region.height <= 0) return false;
    if (region.shape === 'circle') {
      const dx = (clamp(region.x, minX, maxX) - region.x) / (region.width / 2);
      const dy = (clamp(region.y, minY, maxY) - region.y) / (region.height / 2);
      return dx * dx + dy * dy <= 1 + EPSILON;
    }
    return region.x + region.width / 2 >= minX - EPSILON && region.x - region.width / 2 <= maxX + EPSILON
      && region.y + region.height / 2 >= minY - EPSILON && region.y - region.height / 2 <= maxY + EPSILON;
  }).map(region => region.id);
}

function strictlyInRing(point: ReliefPoint, ring: Ring): boolean {
  const pair: [number, number] = [point.x, point.y];
  return !ring.some((a, index) => pointOnSegment(pair, a, ring[(index + 1) % ring.length])) && pointInRing(point, ring);
}

/** Split a polygon edge at every PCB boundary crossing. Its open subsegments
 * either lie fully in PCB material or fully outside it, including concave boards
 * and internal holes. A tiny inward probe resolves coincident boundary edges. */
function polygonIntersectsBoard(points: Ring, exterior: Ring, holes: ReadonlyArray<Ring>): boolean {
  if (!isValidReliefPolygon(points)) return false;
  const boundaries = [exterior, ...holes];
  const inMaterial = (point: ReliefPoint) => strictlyInRing(point, exterior)
    && !holes.some(hole => pointInRing(point, hole) || hole.some((a, i) => pointOnSegment([point.x, point.y], a, hole[(i + 1) % hole.length])));
  // A PCB boundary vertex strictly inside the relief has material on one side.
  if (boundaries.some(ring => ring.some(([x, y]) => strictlyInRing({ x, y }, points)))) return true;
  const signedArea = points.reduce((sum, a, i) => {
    const b = points[(i + 1) % points.length]; return sum + a[0] * b[1] - b[0] * a[1];
  }, 0);
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    const dx = b[0] - a[0], dy = b[1] - a[1], length = Math.hypot(dx, dy);
    const fractions = [0, 1];
    for (const ring of boundaries) for (let j = 0; j < ring.length; j++) {
      const c = ring[j], d = ring[(j + 1) % ring.length];
      const ex = d[0] - c[0], ey = d[1] - c[1], divisor = dx * ey - dy * ex;
      if (Math.abs(divisor) > EPSILON) {
        const t = ((c[0] - a[0]) * ey - (c[1] - a[1]) * ex) / divisor;
        const u = ((c[0] - a[0]) * dy - (c[1] - a[1]) * dx) / divisor;
        if (t > 0 && t < 1 && u >= -EPSILON && u <= 1 + EPSILON) fractions.push(t);
      } else if (Math.abs(cross(a, b, c)) <= EPSILON) {
        const projection = (p: readonly [number, number]) => ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (length * length);
        for (const t of [projection(c), projection(d)]) if (t > 0 && t < 1) fractions.push(t);
      }
    }
    fractions.sort((x, y) => x - y);
    for (let j = 1; j < fractions.length; j++) {
      if (fractions[j] - fractions[j - 1] < EPSILON) continue;
      const t = (fractions[j] + fractions[j - 1]) / 2;
      const point = { x: a[0] + dx * t, y: a[1] + dy * t };
      if (inMaterial(point)) return true;
      const inward = Math.sign(signedArea) * 1e-6 / length;
      const probe = { x: point.x - dy * inward, y: point.y + dx * inward };
      if (strictlyInRing(probe, points) && inMaterial(probe)) return true;
    }
  }
  return false;
}

/** At least some positive area must meet PCB material. Boundary-only touches do
 * not count. Test real circle/segment distance rather than sampling a polygon. */
export function reliefRegionIntersectsBoard(region: ComponentReliefRegion, outline: ReadonlyArray<readonly [number, number]>,
  holes: ReadonlyArray<ReadonlyArray<readonly [number, number]>>, width: number, height: number): boolean {
  const bounds = reliefEditorBounds(outline, width, height);
  const exterior = outline.length >= 3 ? outline : [[bounds.minX, bounds.minY], [bounds.maxX, bounds.minY],
    [bounds.maxX, bounds.maxY], [bounds.minX, bounds.maxY]] as Array<[number, number]>;
  if (region.shape === 'polygon') return polygonIntersectsBoard(region.points ?? [], exterior, holes);
  if (pointInRing(region, exterior) && !holes.some(hole => pointInRing(region, hole))) return true;
  const epsilon = 1e-7;
  const segmentInside = (a: readonly [number, number], b: readonly [number, number]) => {
    if (region.shape === 'circle') {
      const ax = (a[0] - region.x) / (region.width / 2), ay = (a[1] - region.y) / (region.height / 2);
      const dx = (b[0] - a[0]) / (region.width / 2), dy = (b[1] - a[1]) / (region.height / 2);
      const length = dx * dx + dy * dy;
      const fraction = length ? clamp(-(ax * dx + ay * dy) / length, 0, 1) : 0;
      return (ax + fraction * dx) ** 2 + (ay + fraction * dy) ** 2 < 1 - epsilon;
    }
    // Clip against a minimally inset rectangle so touching its border is rejected.
    const minX = region.x - region.width / 2 + epsilon, maxX = region.x + region.width / 2 - epsilon;
    const minY = region.y - region.height / 2 + epsilon, maxY = region.y + region.height / 2 - epsilon;
    let lo = 0, hi = 1;
    for (const [start, delta, min, max] of [[a[0], b[0] - a[0], minX, maxX], [a[1], b[1] - a[1], minY, maxY]]) {
      if (Math.abs(delta) < epsilon) { if (start < min || start > max) return false; }
      else {
        const t1 = (min - start) / delta, t2 = (max - start) / delta;
        lo = Math.max(lo, Math.min(t1, t2)); hi = Math.min(hi, Math.max(t1, t2));
        if (lo > hi) return false;
      }
    }
    return lo <= hi;
  };
  for (const ring of [exterior, ...holes]) {
    for (let index = 0; index < ring.length; index++) {
      if (segmentInside(ring[index], ring[(index + 1) % ring.length])) return true;
    }
  }
  return false;
}
