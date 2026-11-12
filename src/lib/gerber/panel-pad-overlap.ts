import type { PadPart, PadPolygon } from './pads';

type Point = [number, number];
interface Bounds { minX: number; minY: number; maxX: number; maxY: number }
interface Edge { a: Point; b: Point; dx: number; dy: number; length: number; materialSide: number }
interface Ring { points: Point[]; bounds: Bounds; edges: Edge[] }
interface Polygon { outer: Ring; holes: Ring[] }
// Same millimetre tolerance for strict interior, edge contacts and bbox pruning.
const EPS = 1e-6;
const bounds = (points: Point[]): Bounds => {
  const result = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const [x, y] of points) {
    result.minX = Math.min(result.minX, x); result.maxX = Math.max(result.maxX, x);
    result.minY = Math.min(result.minY, y); result.maxY = Math.max(result.maxY, y);
  }
  return result;
};
const overlaps = (a: Bounds, b: Bounds) => Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX) > EPS
  && Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY) > EPS;
const nearBounds = (x: number, y: number, b: Bounds) => x >= b.minX - EPS && x <= b.maxX + EPS
  && y >= b.minY - EPS && y <= b.maxY + EPS;

function prepareRing(points: Point[], hole: boolean, preparedBounds?: Bounds): Ring {
  let twiceArea = 0;
  const edges: Edge[] = [];
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    twiceArea += a[0] * b[1] - b[0] * a[1];
    const dx = b[0] - a[0], dy = b[1] - a[1], length = Math.hypot(dx, dy);
    if (length > EPS) edges.push({ a, b, dx, dy, length, materialSide: 0 });
  }
  const materialSide = (twiceArea >= 0 ? 1 : -1) * (hole ? -1 : 1);
  edges.forEach(edge => { edge.materialSide = materialSide; });
  return { points, bounds: preparedBounds ?? bounds(points), edges };
}
const preparePolygon = (outer: Point[], holes: Point[][], outerBounds?: Bounds): Polygon => ({
  outer: prepareRing(outer, false, outerBounds), holes: holes.map(hole => prepareRing(hole, true)),
});

/** -1 outside, 0 on boundary, 1 strictly inside. */
function inRing(x: number, y: number, ring: Ring): number {
  if (!nearBounds(x, y, ring.bounds)) return -1;
  let inside = false;
  for (const { a, b, dx, dy, length } of ring.edges) {
    const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / (length * length)));
    if (Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy) <= EPS) return 0;
    if ((a[1] > y) !== (b[1] > y) && x < a[0] + (y - a[1]) * dx / dy) inside = !inside;
  }
  return inside ? 1 : -1;
}
function inMaterial(x: number, y: number, polygon: Polygon) {
  if (inRing(x, y, polygon.outer) !== 1) return false;
  return polygon.holes.every(hole => inRing(x, y, hole) === -1);
}
const allRings = (polygon: Polygon) => [polygon.outer, ...polygon.holes];
function hasInteriorBoundary(a: Polygon, b: Polygon) {
  for (const ring of allRings(a)) {
    for (const edge of ring.edges) {
      if (inMaterial(edge.a[0], edge.a[1], b)
        || inMaterial((edge.a[0] + edge.b[0]) / 2, (edge.a[1] + edge.b[1]) / 2, b)) return true;
    }
  }
  return false;
}
const side = (edge: Edge, point: Point) => {
  const distance = (edge.dx * (point[1] - edge.a[1]) - edge.dy * (point[0] - edge.a[0])) / edge.length;
  return distance > EPS ? 1 : distance < -EPS ? -1 : 0;
};
function crossingOrSharedMaterial(a: Edge, b: Edge) {
  const b0 = side(a, b.a), b1 = side(a, b.b), a0 = side(b, a.a), a1 = side(b, a.b);
  if (b0 * b1 < 0 && a0 * a1 < 0) return true;
  if (b0 || b1 || a0 || a1) return false;
  // Collinear contacts enclose common area only when material lies on the same
  // side. Opposite sides are adjacent boards/pads sharing just a boundary.
  const t0 = ((b.a[0] - a.a[0]) * a.dx + (b.a[1] - a.a[1]) * a.dy) / a.length;
  const t1 = ((b.b[0] - a.a[0]) * a.dx + (b.b[1] - a.a[1]) * a.dy) / a.length;
  if (Math.min(a.length, Math.max(t0, t1)) - Math.max(0, Math.min(t0, t1)) <= EPS) return false;
  return (a.dx * b.dx + a.dy * b.dy) * a.materialSide * b.materialSide > 0;
}
function intersects(a: Polygon, b: Polygon) {
  if (!overlaps(a.outer.bounds, b.outer.bounds)) return false;
  // Ordinary pads usually succeed on their first vertex: avoid pairwise edge
  // checks unless shapes meet only at their boundaries or cross as thin strips.
  if (hasInteriorBoundary(a, b) || hasInteriorBoundary(b, a)) return true;
  for (const ar of allRings(a)) for (const br of allRings(b)) {
    for (const ae of ar.edges) for (const be of br.edges) {
      if (crossingOrSharedMaterial(ae, be)) return true;
    }
  }
  return false;
}

/** Keep a source object if its actual positive material overlaps PCB material.
 * Its Gerber flash origin / averaged region centre need not lie on the board.
 * Do not clip here: original geometry is needed for panel override matching,
 * and the manufacturing pipeline already clips openings to the selected PCB.
 * Part-level clear subtraction remains with that pipeline; conservatively
 * retaining a cancelled dark part cannot introduce a new manufactured opening.
 */
export function panelPadFilter(outer: Point[], holes: Point[][]) {
  const board = preparePolygon(outer, holes);
  const cache = new WeakMap<PadPolygon, boolean>();
  const partIntersects = (part: PadPart) => {
    if (part.polarity !== 'D' || part.points.length < 3) return false;
    const partBounds = bounds(part.points);
    if (!overlaps(partBounds, board.outer.bounds)) return false;
    // Most circular/rectangular pads are wholly inside one board. Their first
    // vertex already proves positive overlap, without allocating pad edges.
    const first = part.points[0];
    if (!part.holes?.length && inMaterial(first[0], first[1], board)) return true;
    return intersects(preparePolygon(part.points, part.holes ?? [], partBounds), board);
  };
  return (pad: PadPolygon) => {
    const previous = cache.get(pad);
    if (previous !== undefined) return previous;
    const result = pad.parts.some(partIntersects);
    cache.set(pad, result);
    return result;
  };
}
