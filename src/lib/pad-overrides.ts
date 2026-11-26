import type { PadPolygon } from './gerber/pads';
import type { GerberVariants, PanelVariant } from './gerber/panel';

export type ApertureOverride = NonNullable<PadPolygon['apertureOverride']>;
export const APERTURE_SCALE_MIN = 50;
export const APERTURE_SCALE_ORIGINAL = 100;
export const APERTURE_SCALE_MAX = 200;

/** The UI shows how much of the original size remains; saved settings use the amount removed. */
export function defaultApertureScaleFromShrink(shrink: number) {
  return Math.max(APERTURE_SCALE_MIN, APERTURE_SCALE_ORIGINAL - Math.max(0, Number.isFinite(shrink) ? shrink : 0));
}
export type PadSide = 'top' | 'bottom';
export interface ApertureSnapshot {
  top: Array<[number, ApertureOverride]>;
  bottom: Array<[number, ApertureOverride]>;
  topScales: Array<[number, number]>;
  bottomScales: Array<[number, number]>;
}
const close = (a: number, b: number) => Math.abs(a - b) < 1e-5;

/** Compare in the original Gerber coordinate system. Panel and child boards
 * have independent origins and indexes. */
function samePad(a: PadPolygon, ac: PanelVariant['center'], b: PadPolygon, bc: PanelVariant['center']) {
  if (a.polarity !== b.polarity || a.type !== b.type || a.parts.length !== b.parts.length
    || !close(a.cx + ac.x, b.cx + bc.x) || !close(a.cy + ac.y, b.cy + bc.y)) return false;
  const ringMatches = (ar: Array<[number, number]>, br: Array<[number, number]>) => ar.length === br.length
    && ar.every(([x, y], i) => close(x + ac.x, br[i][0] + bc.x) && close(y + ac.y, br[i][1] + bc.y));
  return a.parts.every((part, i) => {
    const other = b.parts[i], holes = part.holes ?? [], otherHoles = other.holes ?? [];
    return part.polarity === other.polarity && ringMatches(part.points, other.points)
      && holes.length === otherHoles.length && holes.every((ring, h) => ringMatches(ring, otherHoles[h]));
  });
}

/** Index the edited positions once. Match the same physical pad across board
 * scopes without replacing any pad objects or their geometry arrays. */
function syncPadEdits<T>(pads: PadPolygon[], edits: Iterable<readonly [number, T]>,
  assign: (pad: PadPolygon, value: T) => void, side: PadSide, variants: GerberVariants | null,
  active: PanelVariant | null) {
  const selected = new Map<PadPolygon, T>();
  for (const [index, value] of edits) {
    const pad = Number.isInteger(index) ? pads[index] : undefined;
    if (pad?.polarity === 'D') selected.set(pad, value);
  }
  if (!selected.size) return;
  for (const [pad, value] of selected) assign(pad, value);
  if (!variants || !active) return;
  const cell = .1;
  const bucket = (x: number, y: number) => `${Math.floor(x / cell)}:${Math.floor(y / cell)}`;
  const anchors = new WeakMap<PadPolygon, readonly [number, number]>();
  const anchor = (pad: PadPolygon, center: PanelVariant['center']) => {
    let point = anchors.get(pad);
    if (!point) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const part of pad.parts) {
        if (part.polarity !== 'D') continue;
        for (const [x, y] of part.points) {
          minX = Math.min(minX, x); minY = Math.min(minY, y);
          maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
        }
      }
      // Offset macros often share a flash origin despite occupying distinct
      // locations. Index their actual dark bounds; holes/clear parts stay in
      // the exact comparison and cannot distort this spatial acceleration.
      point = Number.isFinite(minX + minY + maxX + maxY)
        ? [(minX + maxX) / 2, (minY + maxY) / 2] : [pad.cx, pad.cy];
      anchors.set(pad, point);
    }
    return [point[0] + center.x, point[1] + center.y] as const;
  };
  const locations = new Map<string, Array<[PadPolygon, T]>>();
  for (const edit of selected) {
    const [x, y] = anchor(edit[0], active.center);
    const key = bucket(x, y);
    const entries = locations.get(key) ?? [];
    entries.push(edit); locations.set(key, entries);
  }
  const field = side === 'top' ? 'topPads' : 'bottomPads';
  for (const variant of new Set([variants.panel, variants.single, ...(variants.boards ?? [])])) {
    for (const candidate of variant[field] ?? []) {
      if (selected.has(candidate) || candidate.polarity !== 'D') continue;
      const [x, y] = anchor(candidate, variant.center);
      // Check neighboring cells to catch floating point drift around bin edges.
      search: for (const dx of [-cell, 0, cell]) {
        for (const dy of [-cell, 0, cell]) {
          const match = locations.get(bucket(x + dx, y + dy))?.find(([pad]) =>
            samePad(pad, active.center, candidate, variant.center));
          if (match) {
            assign(candidate, match[1]);
            break search;
          }
        }
      }
    }
  }
}

export function setPadOverrides(pads: PadPolygon[], indices: readonly number[], value: ApertureOverride | undefined,
  side: PadSide, variants: GerberVariants | null, active: PanelVariant | null) {
  syncPadEdits(pads, indices.map(index => [index, value] as const), (pad, override) => {
    if (pad.apertureOverride === override) return;
    if (override === undefined) delete pad.apertureOverride;
    else pad.apertureOverride = override;
  }, side, variants, active);
}

export function setPadScales(pads: PadPolygon[], edits: Iterable<readonly [number, number | undefined]>,
  side: PadSide, variants: GerberVariants | null, active: PanelVariant | null) {
  syncPadEdits(pads, edits, (pad, scale) => {
    if (pad.apertureScale === scale) return;
    if (scale === undefined) delete pad.apertureScale;
    else if (Number.isInteger(scale) && scale >= APERTURE_SCALE_MIN && scale <= APERTURE_SCALE_MAX) {
      pad.apertureScale = scale;
    }
  }, side, variants, active);
}

/** History copies only sparse pad edits, never Gerber vertices. */
export function apertureSnapshot(top: PadPolygon[], bottom: PadPolygon[]): ApertureSnapshot {
  const snapshot = (pads: PadPolygon[]) => {
    const decisions: Array<[number, ApertureOverride]> = [];
    const scales: Array<[number, number]> = [];
    pads.forEach((pad, index) => {
      if (pad.apertureOverride) decisions.push([index, pad.apertureOverride]);
      if (pad.apertureScale !== undefined) scales.push([index, pad.apertureScale]);
    });
    return { decisions, scales };
  };
  const topEdits = snapshot(top), bottomEdits = snapshot(bottom);
  return { top: topEdits.decisions, bottom: bottomEdits.decisions, topScales: topEdits.scales, bottomScales: bottomEdits.scales };
}
