import type { PadPolygon } from './gerber/pads';
import type { PanelVariant } from './gerber/panel';
import type { GerberVariants } from './gerber/panel';

export type ApertureOverride = NonNullable<PadPolygon['apertureOverride']>;
export type PadSide = 'top' | 'bottom';
export interface ApertureSnapshot { top: Array<[number, ApertureOverride]>; bottom: Array<[number, ApertureOverride]> }
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

/** Mutate only decision metadata, keeping large geometry arrays and history
 * context stable. Synchronize the same physical pad across panel scopes. */
/** Index selected locations once instead of scanning every panel for each pad.
 * A large box selection stays linear in the imported geometry size. */
export function setPadOverrides(pads: PadPolygon[], indices: readonly number[], value: ApertureOverride | undefined,
  side: PadSide, variants: GerberVariants | null, active: PanelVariant | null) {
  const selected = [...new Set(indices)].filter(index => Number.isInteger(index) && pads[index]?.polarity === 'D')
    .map(index => pads[index]);
  if (!selected.length) return;
  const assign = (target: PadPolygon) => {
    if (target.apertureOverride === value) return;
    if (value) target.apertureOverride = value;
    else delete target.apertureOverride;
  };
  selected.forEach(assign);
  if (!variants || !active) return;
  const cell = .1;
  const bucket = (x: number, y: number) => `${Math.floor(x / cell)}:${Math.floor(y / cell)}`;
  const locations = new Map<string, PadPolygon[]>();
  for (const pad of selected) {
    const key = bucket(pad.cx + active.center.x, pad.cy + active.center.y);
    const entries = locations.get(key) ?? [];
    entries.push(pad); locations.set(key, entries);
  }
  const field = side === 'top' ? 'topPads' : 'bottomPads';
  const selectedObjects = new Set(selected);
  for (const variant of new Set([variants.panel, variants.single, ...(variants.boards ?? [])])) {
    for (const candidate of variant[field] ?? []) {
      if (selectedObjects.has(candidate)) continue;
      const x = candidate.cx + variant.center.x, y = candidate.cy + variant.center.y;
      let matched = false;
      for (const dx of [-cell, 0, cell]) {
        for (const dy of [-cell, 0, cell]) {
          if (locations.get(bucket(x + dx, y + dy))?.some(pad => samePad(pad, active.center, candidate, variant.center))) matched = true;
        }
      }
      if (matched) assign(candidate);
    }
  }
}

/** History copies only sparse decisions, never Gerber vertices. */
export function apertureSnapshot(top: PadPolygon[], bottom: PadPolygon[]): ApertureSnapshot {
  const snapshot = (pads: PadPolygon[]) => pads.flatMap((pad, i): Array<[number, ApertureOverride]> =>
    pad.apertureOverride ? [[i, pad.apertureOverride]] : []);
  return { top: snapshot(top), bottom: snapshot(bottom) };
}
