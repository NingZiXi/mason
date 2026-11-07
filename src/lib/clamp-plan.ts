import { platterHalfXY, windowHalfXY, type AppConfig } from '../stores/config';

/** Same centred, per-axis nominal dimensions as the jig model. SVG masks compute the
 * visible contact as metal sheet minus window, including zero overlap cases.
 * This is a plan of the grip, not a pad/printing-opening preview.
 */
export function clampPlan(c: AppConfig) {
  const platter = platterHalfXY(c), window = windowHalfXY(c);
  // Matches plater_radius()/get_polys() in the engine, including its legacy 0 fallback.
  const radius = Math.max(0, Math.min(c.platterCornerRadius || 4.5, Math.min(platter.hx, platter.hy) - .5));
  const windowRadius = Math.min(radius, c.windowGap + .5);
  const halfX = Math.max(c.stencilSizeX / 2, window.hx, c.pcbSizeX / 2);
  const halfY = Math.max(c.stencilSizeY / 2, window.hy, c.pcbSizeY / 2);
  const scale = Math.min(264 / Math.max(1, halfX * 2), 142 / Math.max(1, halfY * 2));
  const rect = (hx: number, hy: number, r = 0) => ({ x: -hx * scale, y: -hy * scale,
    width: hx * 2 * scale, height: hy * 2 * scale, rx: r * scale });
  return {
    scale,
    sheet: rect(c.stencilSizeX / 2, c.stencilSizeY / 2),
    platter: rect(platter.hx, platter.hy, radius),
    window: rect(window.hx, window.hy, windowRadius),
    gripX: Math.max(0, c.stencilSizeX / 2 - window.hx),
    gripY: Math.max(0, c.stencilSizeY / 2 - window.hy),
  };
}

export function pcbPlanPath(outline: readonly (readonly [number, number])[], holes: readonly (readonly (readonly [number, number])[])[], width: number, height: number) {
  const ring = (points: readonly (readonly [number, number])[]) => points.length >= 3
    ? `M${points.map(([x, y]) => `${x},${y}`).join('L')}Z` : '';
  return outline.length >= 3 ? [ring(outline), ...holes.map(ring)].join(' ')
    : `M${-width / 2},${-height / 2}h${width}v${height}h${-width}Z`;
}
