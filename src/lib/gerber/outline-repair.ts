export type OutlinePoint = [number, number];

export const OUTLINE_EPS_MM = 1e-7;
export const NEAR_JOIN_MM = 0.03;
// Large enough to consider export rounding and short routing gaps; longer
// missing edges need source geometry. This is a search radius, not a snap radius.
export const MAX_JOIN_MM = 0.25;

interface OutlineEnd {
  point: OutlinePoint;
  direction: OutlinePoint;
  edgeLength: number;
  curved: boolean;
}

export function outlineEnd(points: OutlinePoint[], reverse: boolean, tangent?: OutlinePoint): OutlineEnd | undefined {
  const origin = reverse ? points.length - 1 : 0;
  const point = points[origin];
  for (let offset = 1; offset < points.length; offset++) {
    const inner = points[origin + (reverse ? -offset : offset)];
    const dx = point[0] - inner[0], dy = point[1] - inner[1];
    const edgeLength = Math.hypot(dx, dy);
    if (edgeLength > OUTLINE_EPS_MM) {
      return { point, direction: tangent ?? [dx / edgeLength, dy / edgeLength], edgeLength, curved: !!tangent };
    }
  }
}

const cross = (a: OutlinePoint, b: OutlinePoint) => a[0] * b[1] - a[1] * b[0];
const dot = (a: OutlinePoint, b: OutlinePoint) => a[0] * b[0] + a[1] * b[1];

/** A point reshapes the seam; null keeps both endpoints and inserts a tiny bridge. */
export function proposeOutlineJoin(a: OutlineEnd, b: OutlineEnd, gap: number): { point: OutlinePoint | null } | undefined {
  const between: OutlinePoint = [b.point[0] - a.point[0], b.point[1] - a.point[1]];
  const turn = cross(a.direction, b.direction);
  const maxMove = Math.min(MAX_JOIN_MM, gap * 1.25);
  // Do not trim/extend past the local feature, even on a large PCB.
  const canMove = (end: OutlineEnd, point: OutlinePoint) =>
    Math.hypot(point[0] - end.point[0], point[1] - end.point[1]) <=
      Math.min(maxMove, end.edgeLength / 2) + OUTLINE_EPS_MM;

  // Restore line corners at the intersection of their supporting lines. A
  // diagonal snap would tilt the edges and shorten a rectangular routed slot.
  if (!a.curved && !b.curved && Math.abs(turn) >= 0.25) {
    const travel = cross(between, b.direction) / turn;
    const point: OutlinePoint = [a.point[0] + travel * a.direction[0], a.point[1] + travel * a.direction[1]];
    if (canMove(a, point) && canMove(b, point)) return { point };
  }

  const facing = dot(a.direction, b.direction) <= -0.97;
  const offset = Math.max(Math.abs(cross(a.direction, between)), Math.abs(cross(b.direction, between)));
  const followsTangents = facing && offset <= Math.min(NEAR_JOIN_MM, gap / 4) + OUTLINE_EPS_MM;
  if (a.curved !== b.curved) {
    const curve = a.curved ? a : b, line = a.curved ? b : a;
    // Preserve the declared arc endpoint. This also trims an overshooting
    // tangent edge instead of inserting an overlapping, doubled-back segment.
    const onLine = Math.abs(cross(line.direction, between)) <= OUTLINE_EPS_MM;
    if ((followsTangents || (onLine && Math.abs(turn) >= 0.25)) && canMove(line, curve.point)) {
      return { point: curve.point };
    }
  } else if (a.curved && followsTangents && dot(a.direction, between) > 0 && dot(b.direction, between) < 0) {
    return { point: null };
  }

  if (gap <= NEAR_JOIN_MM || (!a.curved && !b.curved && followsTangents)) {
    const point: OutlinePoint = [(a.point[0] + b.point[0]) / 2, (a.point[1] + b.point[1]) / 2];
    if (canMove(a, point) && canMove(b, point)) return { point };
  }
}
