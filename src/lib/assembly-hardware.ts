import { SCREW_SPECS, type AppConfig } from '../stores/config';

// The metal sheet in the clamp is independent of the printable stencil's
// thickness setting. It has no measured thickness input yet: label this estimate.
export const CLAMP_SHEET_ESTIMATE = 0.2;
// Matches build_base(): the nut seats against a pocket nutHeight + 0.2 deep.
const NUT_DEPTH_ALLOWANCE = 0.2;
const COMMON_LENGTHS = [4, 5, 6, 8, 10, 12, 14, 16, 18, 20, 22, 25, 30, 35, 40, 45, 50, 55, 60, 70, 80, 90, 100];
const EPSILON = 1e-7;

type HardwareConfig = Pick<AppConfig, 'screwSpec' | 'baseHeight' | 'topCoverHeight' | 'useHexNut'
  | 'periScrewD' | 'nutAcrossFlats' | 'nutHeight'>;
export type HardwareState = 'ready' | 'off' | 'selfTap' | 'invalid' | 'holeTooSmall' | 'pocketThrough' | 'customLength';

/** Only perimeter holes get fasteners; count comes from the actual layout.
 * Length is measured UNDER a non-countersunk head. The tray is never clamped.
 * Require full nut engagement and reject lengths protruding below the base.
 */
export function assemblyHardware(c: HardwareConfig, perimeterCount: number) {
  const count = Number.isFinite(perimeterCount) ? Math.max(0, Math.floor(perimeterCount)) : 0;
  const nominal = SCREW_SPECS[c.screwSpec];
  const result = {
    state: 'ready' as HardwareState, screwCount: count, nutCount: c.useHexNut ? count : 0,
    screwLength: null as number | null, lengthRange: null as [number, number] | null,
    customFit: !!nominal && (Math.abs(c.periScrewD - nominal.holeD) > EPSILON
      || Math.abs(c.nutAcrossFlats - nominal.nutAcross) > EPSILON || Math.abs(c.nutHeight - nominal.nutHeight) > EPSILON),
  };
  if (!count) return { ...result, state: 'off' as const };
  // The current no-nut geometry retains clearance through-holes, not a
  // validated tapping pilot. Never suggest a machine screw will hold in it.
  if (!c.useHexNut) return { ...result, state: 'selfTap' as const };
  if (!nominal || ![c.baseHeight, c.topCoverHeight, c.periScrewD, c.nutAcrossFlats, c.nutHeight]
    .every(value => Number.isFinite(value) && value > 0)) return { ...result, state: 'invalid' as const };
  if (c.periScrewD <= Number(c.screwSpec.slice(1))) return { ...result, state: 'holeTooSmall' as const };
  const pocketDepth = c.nutHeight + NUT_DEPTH_ALLOWANCE;
  if (pocketDepth >= c.baseHeight - EPSILON) return { ...result, state: 'pocketThrough' as const };
  const stack = c.topCoverHeight + c.baseHeight + CLAMP_SHEET_ESTIMATE;
  const minimum = stack - pocketDepth + c.nutHeight;
  result.lengthRange = [minimum, stack];
  result.screwLength = COMMON_LENGTHS.find(length => length >= minimum - EPSILON && length <= stack + EPSILON) ?? null;
  if (result.screwLength === null) result.state = 'customLength';
  return result;
}
