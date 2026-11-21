import { orientBoardPads, orientBoardRing, type JigPrintSide } from './component-relief';
import type { PadPolygon } from './gerber/pads';

export type QuarterTurn = 0 | 1 | 2 | 3;

/**
 * Where the board sits under the clamped stencil (jig mode). The printing-view
 * board (top view for the top side, flipped about X for the bottom side) is
 * turned quarter × 90° counter-clockwise, then moved (x, y) mm from the
 * stencil centre. Matches Python `_jig_placed_params`.
 */
export interface BoardPlacement {
  x: number;
  y: number;
  quarter: QuarterTurn;
  /** Display only: print this side with the photographed stencil face down. */
  stencilFlipped?: boolean;
}

/** The fields the CAD engine reads. */
export function enginePlacement(p: BoardPlacement | null): Pick<BoardPlacement, 'x' | 'y' | 'quarter'> | null {
  return p ? { x: p.x, y: p.y, quarter: p.quarter } : null;
}

/** One placement per printing side: a double-sided stencil holds both faces' copies. */
export type StencilPlacementPlans = Record<JigPrintSide, BoardPlacement | null>;

export const emptyPlacementPlans = (): StencilPlacementPlans => ({ top: null, bottom: null });

export const MAX_PLACEMENT_OFFSET = 300;

interface PlacementConfig {
  stencilPlacementEnabled: boolean;
  stencilPlacements: StencilPlacementPlans;
  jigPrintSide: JigPrintSide;
}

/** The placement used for the side being printed; null keeps the board centred. */
export function activeBoardPlacement(c: PlacementConfig): BoardPlacement | null {
  return c.stencilPlacementEnabled ? c.stencilPlacements[c.jigPrintSide] ?? null : null;
}

export function placeBoardPoint(p: BoardPlacement, [x, y]: readonly [number, number]): [number, number] {
  let u = x, v = y;
  for (let q = 0; q < p.quarter; q++) [u, v] = [-v, u];
  return [u + p.x, v + p.y];
}

/** Board ring in jig coordinates for the side being printed. */
export function placeBoardRing(ring: readonly (readonly [number, number])[], side: JigPrintSide, p: BoardPlacement): Array<[number, number]> {
  return orientBoardRing(ring, side).map(point => placeBoardPoint(p, point));
}

/** Paste openings of the printed side as they appear on the clamped stencil. */
export function placeBoardPads(pads: readonly PadPolygon[], side: JigPrintSide, p: BoardPlacement): PadPolygon[] {
  const ring = (points: ReadonlyArray<readonly [number, number]>) => points.map(point => placeBoardPoint(p, point));
  return orientBoardPads(pads, side).map(pad => {
    const [cx, cy] = placeBoardPoint(p, [pad.cx, pad.cy]);
    return { ...pad, cx, cy, parts: pad.parts.map(part => ({
      ...part, points: ring(part.points), ...(part.holes ? { holes: part.holes.map(ring) } : {}),
    })) };
  });
}

interface BoundsConfig extends PlacementConfig {
  pcbSizeX: number;
  pcbSizeY: number;
  pcbOutlinePoints: ReadonlyArray<readonly [number, number]>;
}

/** Axis-aligned bounds of the placed board in jig coordinates, or null when centred. */
export function placedBoardBounds(c: BoundsConfig): { minX: number; minY: number; maxX: number; maxY: number } | null {
  const placement = activeBoardPlacement(c);
  if (!placement) return null;
  const w = c.pcbSizeX / 2, h = c.pcbSizeY / 2;
  const ring = c.pcbOutlinePoints.length >= 3 ? c.pcbOutlinePoints
    : [[-w, -h], [w, -h], [w, h], [-w, h]] as Array<[number, number]>;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of placeBoardRing(ring, c.jigPrintSide, placement)) {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  return { minX, minY, maxX, maxY };
}

export function isValidPlacement(p: unknown): p is BoardPlacement {
  if (!p || typeof p !== 'object') return false;
  const { x, y, quarter } = p as Record<string, unknown>;
  return typeof x === 'number' && Number.isFinite(x) && Math.abs(x) <= MAX_PLACEMENT_OFFSET
    && typeof y === 'number' && Number.isFinite(y) && Math.abs(y) <= MAX_PLACEMENT_OFFSET
    && (quarter === 0 || quarter === 1 || quarter === 2 || quarter === 3);
}
