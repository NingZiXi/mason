/** A zero diameter retains the legacy board-adaptive hole. The saved request
 * stays unchanged when a smaller board temporarily limits the actual hole. */
export interface EjectHoleConfig {
  pcbSizeX: number;
  pcbSizeY: number;
  pcbPocketClearance: number;
  pcbOutlinePoints: ReadonlyArray<readonly [number, number]>;
  ejectHoleDiameter: number;
}

export const MIN_EJECT_HOLE_DIAMETER = 4;
export const MAX_EJECT_HOLE_DIAMETER = 40;
const EDGE_SUPPORT = 4;
const finite = (value: number, fallback = 0) => Number.isFinite(value) ? value : fallback;

/** Board-dependent limits are separate so dragging a diameter slider never
 * rescans a detailed Gerber outline. */
export function ejectHoleLimits(config: Omit<EjectHoleConfig, 'ejectHoleDiameter'>) {
  let width = Math.max(0, finite(config.pcbSizeX)), height = Math.max(0, finite(config.pcbSizeY));
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, count = 0;
  for (const [x, y] of config.pcbOutlinePoints) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    ++count;
  }
  if (count >= 3) {
    width = maxX - minX;
    height = maxY - minY;
  }
  const shortest = Math.min(width, height) + 2 * Math.max(0, finite(config.pcbPocketClearance));
  let autoDiameter = shortest * .35;
  if (autoDiameter < 12) autoDiameter = shortest >= 26 ? 12 : 0;
  autoDiameter = Math.min(autoDiameter, 30);
  if (autoDiameter < 8) autoDiameter = 0;
  const availableDiameter = Math.max(0, Math.min(MAX_EJECT_HOLE_DIAMETER, shortest - EDGE_SUPPORT));
  const available = availableDiameter >= MIN_EJECT_HOLE_DIAMETER;
  return {
    min: MIN_EJECT_HOLE_DIAMETER,
    max: Math.max(MIN_EJECT_HOLE_DIAMETER, Math.floor((availableDiameter + 1e-8) * 2) / 2),
    autoDiameter, availableDiameter, available,
  };
}

export function resolveEjectHoleSize(limits: ReturnType<typeof ejectHoleLimits>, requestedDiameter: number) {
  const requested = Math.max(0, finite(requestedDiameter));
  const custom = requested > 0;
  const diameter = custom ? limits.available ? Math.min(requested, limits.availableDiameter) : 0 : limits.autoDiameter;
  return {
    diameter, min: limits.min, max: limits.max,
    autoDiameter: limits.autoDiameter, clamped: custom && diameter < requested, custom, available: limits.available,
  };
}

export function ejectHoleSize(config: EjectHoleConfig) {
  return resolveEjectHoleSize(ejectHoleLimits(config), config.ejectHoleDiameter);
}
