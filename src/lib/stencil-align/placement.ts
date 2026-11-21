import type { BoardInstance } from './match';
import { normalizeAngle } from './match';

export type PrintSide = 'top' | 'bottom';

/**
 * Where the board sits under the clamped stencil, in jig millimetres
 * (origin = stencil/jig centre, y up, looking down at the printing face).
 * The board is taken in its printing view: top-view Gerber for the top side,
 * the same coordinates flipped about the board X axis for the bottom side.
 */
export interface JigBoardPlacement {
  x: number;
  y: number;
  /** Counter-clockwise quarter turns applied to the printing-view board (0..3). */
  quarter: 0 | 1 | 2 | 3;
  /**
   * True when the photographed face must face down while printing this side
   * (turn the stencil over top-to-bottom, about its horizontal axis).
   */
  stencilFlipped: boolean;
  /** Measured deviation from the nearest quarter turn (radians), for warnings. */
  angleError: number;
}

/**
 * Convert a photographed copy into the tray placement for one printing side.
 *
 * Photo:   s = R(θ)·M·b + t           (b = top-view board mm, M = mirror-X if mirrored)
 * Print:   b' = S·b, S = I (top) or diag(1, -1) (bottom), matching the tray orientation
 * So       s = K·b' + t with K = R(θ)·M·S.
 * A proper rotation K means the photographed face is up while printing. Otherwise
 * the sheet is turned over about its X axis: s' = F·s with F = diag(1, -1).
 */
export function jigPlacementFromInstance(instance: BoardInstance, side: PrintSide): JigBoardPlacement {
  const c = Math.cos(instance.rotation), s = Math.sin(instance.rotation);
  // K = R·M·S, built column by column.
  const mx = instance.mirrored ? -1 : 1;
  const sy = side === 'bottom' ? -1 : 1;
  // det(K) = det(M)·det(S); only the first column is needed for the angle.
  const stencilFlipped = mx * sy < 0;
  const k00 = c * mx;
  const k10 = (stencilFlipped ? -1 : 1) * s * mx;
  const tx = instance.x;
  const ty = stencilFlipped ? -instance.y : instance.y;
  const angle = Math.atan2(k10, k00);
  const quarterRaw = Math.round(angle / (Math.PI / 2));
  const quarter = (((quarterRaw % 4) + 4) % 4) as 0 | 1 | 2 | 3;
  return {
    x: tx, y: ty, quarter, stencilFlipped,
    angleError: normalizeAngle(angle - quarterRaw * (Math.PI / 2)),
  };
}

/** Apply a placement to a printing-view board point. */
export function placePoint(p: JigBoardPlacement, [x, y]: readonly [number, number]): [number, number] {
  let u = x, v = y;
  for (let q = 0; q < p.quarter; q++) [u, v] = [-v, u];
  return [u + p.x, v + p.y];
}
