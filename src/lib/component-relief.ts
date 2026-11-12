import type { PadPolygon } from './gerber/pads';

export type JigPrintSide = 'top' | 'bottom';

/** Millimetres in the imported board's original top-view coordinates.
 * x/y are the bounding-box centre; circles use width = height = diameter.
 * Polygon points use the same absolute board coordinates. */
export interface ComponentReliefRegion {
  id: string;
  shape: 'rect' | 'circle' | 'polygon';
  x: number;
  y: number;
  width: number;
  height: number;
  points?: Array<[number, number]>;
  /** Distance below the PCB support surface. Legacy regions use the default. */
  depth?: number;
  /** Cut through the complete tray; retain depth for returning to a blind pocket. */
  through?: boolean;
}

export interface ComponentReliefMergeResult {
  valid: boolean;
  regions: ComponentReliefRegion[];
  /** Number of regions removed by merging. */
  merged: number;
  /** Input regions retained because their merged outline cannot be represented safely. */
  skipped: number;
  error?: string;
}

export type ComponentReliefPlans = Record<JigPrintSide, ComponentReliefRegion[]>;
export const MAX_RELIEF_REGIONS = 100;
export const MAX_RELIEF_VERTICES = 128;
export const MIN_RELIEF_SIZE = 0.5;
export const RELIEF_FLOOR_THICKNESS = 1.2;

export const emptyReliefPlans = (): ComponentReliefPlans => ({ top: [], bottom: [] });

export function reliefRegionDepth(region: ComponentReliefRegion, defaultDepth: number): number {
  return region.depth ?? defaultDepth;
}

export function reliefDepthRange(regions: readonly ComponentReliefRegion[], defaultDepth: number): { min: number; max: number } | null {
  const depths = regions.filter(region => !region.through).map(region => reliefRegionDepth(region, defaultDepth));
  if (!depths.length) return null;
  return { min: Math.min(...depths), max: Math.max(...depths) };
}

/** Freeze legacy fallback depths before changing the default for new regions. */
export function materializeReliefDepths(plans: ComponentReliefPlans, defaultDepth: number): ComponentReliefPlans {
  const fill = (regions: ComponentReliefRegion[]) => regions.map(region => region.depth === undefined
    ? { ...region, depth: defaultDepth } : region);
  return { top: fill(plans.top), bottom: fill(plans.bottom) };
}

interface ReliefConfig {
  appMode: 'jig' | 'stencil';
  componentReliefEnabled: boolean;
  componentReliefDepth: number;
  componentReliefRegions: ComponentReliefPlans;
  jigPrintSide: JigPrintSide;
  insertHeight: number;
  pcbThickness: number;
}

export function activeReliefRegions(config: ReliefConfig): ComponentReliefRegion[] {
  return config.appMode === 'jig' && config.componentReliefEnabled
    ? config.componentReliefRegions[config.jigPrintSide] : [];
}

/** Increase the material below the PCB, never the PCB-to-stencil gap. */
export function effectiveInsertHeight(config: ReliefConfig): number {
  const range = reliefDepthRange(activeReliefRegions(config), config.componentReliefDepth);
  return range
    ? Math.max(config.insertHeight, config.pcbThickness + range.max + RELIEF_FLOOR_THICKNESS)
    : config.insertHeight;
}

export function effectiveJigPrintSide(config: ReliefConfig): JigPrintSide {
  return config.appMode === 'jig' && config.componentReliefEnabled ? config.jigPrintSide : 'top';
}

/** Flip about the board X axis, matching the tray, its holes and both pad masks. */
export function orientBoardRing(ring: readonly (readonly [number, number])[], side: JigPrintSide): Array<[number, number]> {
  return ring.map(([x, y]) => [x, side === 'bottom' ? -y : y]);
}

export function orientBoardPads(pads: readonly PadPolygon[], side: JigPrintSide): PadPolygon[] {
  if (side === 'top') return [...pads];
  return pads.map(pad => ({
    ...pad, cy: -pad.cy,
    parts: pad.parts.map(part => ({
      ...part, points: orientBoardRing(part.points, side),
      ...(part.holes ? { holes: part.holes.map(hole => orientBoardRing(hole, side)) } : {}),
    })),
  }));
}
