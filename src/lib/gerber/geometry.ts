/** Point containment including polygon edges, with coordinates in millimetres. */
export function pointInPolygon(
  x: number,
  y: number,
  polygon: Array<[number, number]>,
  tolerance = 1e-6
): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [ax, ay] = polygon[j];
    const [bx, by] = polygon[i];
    const dx = bx - ax, dy = by - ay;
    const lengthSquared = dx * dx + dy * dy;
    const t = lengthSquared > 0
      ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / lengthSquared))
      : 0;
    if (Math.hypot(x - ax - t * dx, y - ay - t * dy) <= tolerance) return true;
    if ((ay > y) !== (by > y) && x < ax + (y - ay) * dx / dy) inside = !inside;
  }
  return inside;
}
