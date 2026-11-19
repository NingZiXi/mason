/**
 * 从解析后的 Gerber 命令计算包围盒 (mm 单位)
 */
import type { ParseResult } from "./parser";

export interface BoundingBox {
  /** mm */
  minX: number;
  /** mm */
  minY: number;
  /** mm */
  maxX: number;
  /** mm */
  maxY: number;
  /** 原始单位 */
  units: "mm" | "in" | null;
  /** 检测到的命令数 */
  commandCount: number;
}

const TURN = 2 * Math.PI;

/** Signed travel, including a full turn when the two angles coincide. */
export function arcSweep(start: number, end: number, ccw: boolean): number {
  let delta = end - start;
  if (ccw) { while (delta <= 0) delta += TURN; }
  else { while (delta >= 0) delta -= TURN; }
  return delta;
}

export function computeBbox({ format, units, commands }: ParseResult): BoundingBox {
  const scale = (units === 'in' ? 25.4 : 1) / 10 ** format.places[1];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let prevX = 0, prevY = 0;
  function include(x: number, y: number) {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  for (const cmd of commands) {
    if (cmd.type !== 'op' || cmd.x === undefined || cmd.y === undefined) continue;
    const { x, y, i = 0, j = 0 } = cmd;
    include(x, y);
    if (cmd.op === 'interpolate' && cmd.isArc && (i !== 0 || j !== 0)) {
      const cx = prevX + i, cy = prevY + j, r = Math.hypot(i, j);
      const start = Math.atan2(prevY - cy, prevX - cx);
      const end = Math.atan2(y - cy, x - cx);
      const sweep = arcSweep(start, end, !!cmd.ccw);
      // Endpoints alone miss peaks between them; the other quadrants of the
      // supporting circle can be outside the panel. Only include crossed axes.
      const crosses = (axis: number) => {
        const travel = sweep > 0 ? axis - start : start - axis;
        return (travel < 0 ? travel + TURN : travel) <= Math.abs(sweep);
      };
      include(prevX, prevY);
      if (crosses(0)) include(cx + r, cy);
      if (crosses(Math.PI / 2)) include(cx, cy + r);
      if (crosses(Math.PI)) include(cx - r, cy);
      if (crosses(-Math.PI / 2)) include(cx, cy - r);
    }
    prevX = x; prevY = y;
  }
  if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: 0, maxY: 0, units, commandCount: 0 };
  return { minX: minX * scale, minY: minY * scale, maxX: maxX * scale, maxY: maxY * scale, units, commandCount: commands.length };
}
