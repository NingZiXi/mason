import { pointInPolygon } from "./geometry";
import type { GerberBoardOutline } from "./parser";

type Point = [number, number];
const EPS = 1e-6;
const MAX_BRIDGE_WIDTH = 6; // mm; conservative fallback for common routing tabs
const cross = (a: Point, b: Point, c: Point) =>
  (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);

function area(ring: Point[]): number {
  return ring.reduce((sum, p, i) => {
    const q = ring[(i + 1) % ring.length];
    return sum + p[0] * q[1] - q[0] * p[1];
  }, 0) / 2;
}

function normalize(points: Point[], clockwise: boolean): Point[] {
  let ring = points.filter((p, i) => !i || Math.hypot(p[0] - points[i - 1][0], p[1] - points[i - 1][1]) > EPS);
  const last = ring[ring.length - 1];
  if (ring.length > 1 && Math.hypot(ring[0][0] - last[0], ring[0][1] - last[1]) <= 0.02) ring.pop();
  // Treat a subdivided straight tab edge exactly like a single stroke.
  ring = ring.filter((b, i) => {
    const a = ring[(i + ring.length - 1) % ring.length], c = ring[(i + 1) % ring.length];
    return Math.abs(cross(a, b, c)) > 1e-8 ||
      (b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1]) < 0;
  });
  if ((area(ring) < 0) !== clockwise) ring.reverse();
  return ring;
}

/**
 * Infer sub-boards joined by straight, axis-aligned routing tabs. Four reflex
 * corners and two opposing edges must enclose solid PCB material. Reconnect
 * the original boundaries across both ends of each tab, preserving curves
 * and holes. The full-panel geometry is never changed by this operation.
 * This is a geometric inference, so callers must label the resulting boards.
 */
export function splitBridgedOutline(points: Point[], holes: Point[][]): GerberBoardOutline[] {
  const rings = [normalize(points, false), ...holes.map((h) => normalize(h, true))];
  if (rings.some((ring) => ring.length < 3)) return [];
  const vertices: Point[] = [];
  const edges: Array<{ from: number; to: number; axis: 0 | 1 | null; reflex: boolean }> = [];
  for (const ring of rings) {
    const offset = vertices.length;
    vertices.push(...ring);
    for (let i = 0; i < ring.length; i++) {
      const next = (i + 1) % ring.length;
      const a = ring[i], b = ring[next];
      edges.push({
        from: offset + i, to: offset + next,
        axis: Math.abs(a[0] - b[0]) < EPS ? 1 : Math.abs(a[1] - b[1]) < EPS ? 0 : null,
        reflex: cross(ring[(i + ring.length - 1) % ring.length], a, b) < -EPS &&
          cross(a, b, ring[(next + 1) % ring.length]) < -EPS,
      });
    }
  }
  const solid = (x: number, y: number) => pointInPolygon(x, y, rings[0]) &&
    !rings.slice(1).some((hole) => pointInPolygon(x, y, hole));
  const candidates: Array<{ a: number; b: number; width: number; length: number; bounds: number[] }> = [];
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i];
    if (!e.reflex || e.axis === null) continue;
    const axis = e.axis, across = 1 - axis;
    const a = vertices[e.from], b = vertices[e.to];
    const lo = Math.min(a[axis], b[axis]), hi = Math.max(a[axis], b[axis]);
    const length = hi - lo;
    if (length < 0.2) continue;
    for (let j = i + 1; j < edges.length; j++) {
      const f = edges[j];
      if (!f.reflex || f.axis !== axis) continue;
      const c = vertices[f.from], d = vertices[f.to];
      // Endpoints must oppose one another, including the winding of cutouts.
      if (Math.abs(a[axis] - d[axis]) > EPS || Math.abs(b[axis] - c[axis]) > EPS) continue;
      const width = Math.abs(a[across] - c[across]);
      if (width < 0.2 || width > MAX_BRIDGE_WIDTH || length > width * 6) continue;
      const bounds = [Math.min(a[0], b[0], c[0], d[0]), Math.min(a[1], b[1], c[1], d[1]),
        Math.max(a[0], b[0], c[0], d[0]), Math.max(a[1], b[1], c[1], d[1])];
      // Do not cut across another boundary or a void (e.g. a narrow slot).
      if (vertices.some(([x, y]) => x > bounds[0] + EPS && x < bounds[2] - EPS &&
          y > bounds[1] + EPS && y < bounds[3] - EPS)) continue;
      let filled = true;
      for (const u of [0.25, 0.5, 0.75]) for (const v of [0.25, 0.5, 0.75]) {
        if (!solid(bounds[0] + (bounds[2] - bounds[0]) * u, bounds[1] + (bounds[3] - bounds[1]) * v)) filled = false;
      }
      if (filled) candidates.push({ a: i, b: j, width, length, bounds });
    }
  }
  const removed = new Set<number>();
  const caps: Array<{ from: number; to: number }> = [];
  const chosen: typeof candidates = [];
  for (const bridge of candidates.sort((a, b) => a.width - b.width)) {
    if (removed.has(bridge.a) || removed.has(bridge.b)) continue;
    if (chosen.some((other) => Math.min(other.bounds[2], bridge.bounds[2]) - Math.max(other.bounds[0], bridge.bounds[0]) > EPS &&
        Math.min(other.bounds[3], bridge.bounds[3]) - Math.max(other.bounds[1], bridge.bounds[1]) > EPS)) continue;
    const a = edges[bridge.a], b = edges[bridge.b];
    removed.add(bridge.a); removed.add(bridge.b);
    caps.push({ from: a.from, to: b.to }, { from: b.from, to: a.to });
    chosen.push(bridge);
  }
  if (!chosen.length) return [];

  const remaining = new Map([...edges.filter((_, i) => !removed.has(i)), ...caps].map((e) => [e.from, e.to]));
  const loops: Array<{ points: Point[]; area: number }> = [];
  while (remaining.size) {
    const start = remaining.keys().next().value!;
    let current = start;
    const loop: Point[] = [];
    do {
      loop.push(vertices[current]);
      const next = remaining.get(current);
      if (next === undefined) return []; // Never offer a broken boundary.
      remaining.delete(current);
      current = next;
    } while (current !== start);
    loops.push({ points: [...loop, loop[0]], area: area(loop) });
  }
  const outers = loops.filter((loop) => loop.area > EPS);
  if (outers.length < 2) return [];
  const largestBridge = Math.max(...chosen.map((bridge) => bridge.width));
  const boards = outers.map((outer): GerberBoardOutline => {
    const xs = outer.points.map((p) => p[0]), ys = outer.points.map((p) => p[1]);
    return {
      points: outer.points,
      holes: loops.filter((h) => h.area < -EPS && pointInPolygon(h.points[0][0], h.points[0][1], outer.points)).map((h) => h.points),
      bbox: { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) },
      inferred: true,
    };
  });
  // Reject thin slivers and check material conservation after removing tabs.
  if (boards.some((b, i) => Math.min(b.bbox.maxX - b.bbox.minX, b.bbox.maxY - b.bbox.minY) < largestBridge * 2 ||
      outers[i].area < largestBridge * largestBridge * 4)) return [];
  const originalArea = rings.reduce((sum, ring) => sum + area(ring), 0);
  const resultArea = loops.reduce((sum, loop) => sum + loop.area, 0);
  const tabArea = chosen.reduce((sum, bridge) => sum + bridge.width * bridge.length, 0);
  return Math.abs(originalArea - resultArea - tabArea) < 1e-3 ? boards : [];
}
