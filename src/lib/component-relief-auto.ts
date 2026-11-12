import { MAX_RELIEF_REGIONS, MIN_RELIEF_SIZE, type ComponentReliefRegion } from './component-relief';
import { reliefEditorBounds, reliefRegionIntersectsBoard, type ReliefBounds } from './component-relief-editor';
import { pointInPolygon } from './gerber/geometry';
import { panelPadFilter } from './gerber/panel-pad-overlap';
import type { PadPolygon } from './gerber/pads';

type Ring = ReadonlyArray<readonly [number, number]>;
interface PadBox extends ReliefBounds { ref?: string }
interface Group extends ReliefBounds { pads: PadBox[] }
const round = (n: number) => Math.round(n * 1000) / 1000;
const width = (b: ReliefBounds) => b.maxX - b.minX;
const height = (b: ReliefBounds) => b.maxY - b.minY;
const union = (a: ReliefBounds, b: ReliefBounds): ReliefBounds => ({
  minX: Math.min(a.minX, b.minX), minY: Math.min(a.minY, b.minY),
  maxX: Math.max(a.maxX, b.maxX), maxY: Math.max(a.maxY, b.maxY),
});
const gap = (a: ReliefBounds, b: ReliefBounds) => Math.hypot(
  Math.max(0, a.minX - b.maxX, b.minX - a.maxX), Math.max(0, a.minY - b.maxY, b.minY - a.maxY));

function padBox(pad: PadPolygon): PadBox | null {
  if (pad.polarity !== 'D' || pad.padRole === 'testpoint') return null;
  const box: PadBox = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity, ref: pad.componentRef };
  for (const part of pad.parts) if (part.polarity === 'D') {
    for (const [x, y] of part.points) {
      if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 600 || Math.abs(y) > 600) return null;
      box.minX = Math.min(box.minX, x); box.maxX = Math.max(box.maxX, x);
      box.minY = Math.min(box.minY, y); box.maxY = Math.max(box.maxY, y);
    }
  }
  return width(box) > 1e-6 && height(box) > 1e-6 ? box : null;
}

/** A small spatial index keeps dense paste layers from doing all-pairs work. */
class GroupIndex {
  private cells = new Map<string, Set<Group>>();
  private keys(box: ReliefBounds, margin = 0): string[] {
    const keys: string[] = [];
    for (let x = Math.floor((box.minX - margin) / 8); x <= Math.floor((box.maxX + margin) / 8); x++) {
      for (let y = Math.floor((box.minY - margin) / 8); y <= Math.floor((box.maxY + margin) / 8); y++) keys.push(`${x}:${y}`);
    }
    return keys;
  }
  add(group: Group) {
    for (const key of this.keys(group)) {
      const cell = this.cells.get(key) ?? new Set<Group>(); cell.add(group); this.cells.set(key, cell);
    }
  }
  remove(group: Group) {
    for (const key of this.keys(group)) {
      const cell = this.cells.get(key); cell?.delete(group); if (!cell?.size) this.cells.delete(key);
    }
  }
  near(box: ReliefBounds, margin: number): Group[] {
    const found = new Set<Group>();
    for (const key of this.keys(box, margin)) for (const group of this.cells.get(key) ?? []) found.add(group);
    return [...found];
  }
}

function inferredGroups(pads: PadBox[]): Group[] {
  const index = new GroupIndex(), groups = new Set<Group>();
  // Fixed order makes the result independent of Gerber drawing order.
  pads.sort((a, b) => a.minX - b.minX || a.minY - b.minY || a.maxX - b.maxX || a.maxY - b.maxY);
  for (const pad of pads) {
    const group: Group = { ...pad, pads: [pad] };
    // A large exposed thermal pad is already a useful standalone proposal.
    // Keep it out of the small-footprint index instead of filling many cells.
    if (width(pad) > 16 || height(pad) > 16) { groups.add(group); continue; }
    const neighbors = index.near(pad, 1.8).sort((a, b) => gap(a, pad) - gap(b, pad));
    for (const neighbor of neighbors) {
      const combined = union(group, neighbor);
      // Never grow an unlabelled dense board into one board-sized cavity.
      if (width(combined) > 16 || height(combined) > 16 || gap(group, neighbor) > 1.8) continue;
      index.remove(neighbor); groups.delete(neighbor);
      Object.assign(group, combined); group.pads.push(...neighbor.pads);
    }
    groups.add(group); index.add(group);
  }
  // Opposing pin rows often have a component body between them and no paste
  // there. Join comparable parallel rows, rather than leaving the body on a rib.
  for (const group of [...groups]) {
    if (!groups.has(group) || group.pads.length < 3) continue;
    for (const other of index.near(group, 6)) {
      if (other === group || !groups.has(other) || other.pads.length < 3) continue;
      const horizontal = width(group) >= height(group) * 2 && width(other) >= height(other) * 2;
      const vertical = height(group) >= width(group) * 2 && height(other) >= width(other) * 2;
      if (!horizontal && !vertical) continue;
      const longA = horizontal ? width(group) : height(group), longB = horizontal ? width(other) : height(other);
      const overlap = horizontal ? Math.min(group.maxX, other.maxX) - Math.max(group.minX, other.minX)
        : Math.min(group.maxY, other.maxY) - Math.max(group.minY, other.minY);
      const combined = union(group, other);
      if (Math.min(longA, longB) < 2.5 || Math.max(longA, longB) > Math.min(longA, longB) * 1.6
        || overlap < Math.min(longA, longB) * .7 || gap(group, other) > Math.min(6, Math.min(longA, longB) * .8)
        || width(combined) > 20 || height(combined) > 20) continue;
      index.remove(group); index.remove(other); groups.delete(other);
      Object.assign(group, combined); group.pads.push(...other.pads); index.add(group);
      break;
    }
  }
  return [...groups];
}

function stableId(group: Group): string {
  const source = group.pads.map(p => `${p.ref ?? ''}:${round(p.minX)},${round(p.minY)},${round(p.maxX)},${round(p.maxY)}`).sort().join(';');
  let hash = 2166136261;
  for (let i = 0; i < source.length; i++) hash = Math.imul(hash ^ source.charCodeAt(i), 16777619);
  return `auto-relief-${(hash >>> 0).toString(36)}`;
}

/** True when an outline edge cuts into the candidate rectangle, including a
 * narrow concave notch whose four corners all happen to be inside the outline. */
function edgeEntersBox(a: readonly [number, number], b: readonly [number, number], box: ReliefBounds): boolean {
  const inset = 1e-6;
  let low = 0, high = 1;
  for (const [start, end, min, max] of [
    [a[0], b[0], box.minX + inset, box.maxX - inset],
    [a[1], b[1], box.minY + inset, box.maxY - inset],
  ]) {
    const delta = end - start;
    if (Math.abs(delta) < 1e-12) {
      if (start < min || start > max) return false;
    } else {
      const first = (min - start) / delta, last = (max - start) / delta;
      low = Math.max(low, Math.min(first, last));
      high = Math.min(high, Math.max(first, last));
      if (low > high) return false;
    }
  }
  return low <= high;
}

function coveredBy(region: ComponentReliefRegion, existing: ComponentReliefRegion): boolean {
  const corners: Array<[number, number]> = [[region.x - region.width / 2, region.y - region.height / 2],
    [region.x + region.width / 2, region.y - region.height / 2], [region.x + region.width / 2, region.y + region.height / 2],
    [region.x - region.width / 2, region.y + region.height / 2]];
  if (existing.shape === 'circle') return corners.every(([x, y]) =>
    ((x - existing.x) / (existing.width / 2)) ** 2 + ((y - existing.y) / (existing.height / 2)) ** 2 <= 1 + 1e-6);
  if (existing.shape === 'polygon') {
    const points = existing.points;
    if (!points || points.length < 3 || !corners.every(([x, y]) => pointInPolygon(x, y, points))) return false;
    const box = { minX: corners[0][0], minY: corners[0][1], maxX: corners[2][0], maxY: corners[2][1] };
    // A merged polygon already includes its original proposals. Do not recreate
    // their boxes on another automatic pass, or fill a concave support notch.
    return !points.some((point, index) => edgeEntersBox(point, points[(index + 1) % points.length], box));
  }
  return corners.every(([x, y]) => Math.abs(x - existing.x) <= existing.width / 2 + 1e-6
    && Math.abs(y - existing.y) <= existing.height / 2 + 1e-6);
}

/** Infer pockets from the DOWNWARD face's paste pads. Paste files contain pin
 * positions, not physical bodies/heights: the user must check the proposals.
 * Existing regions remain untouched; canonical coordinates are never mirrored. */
export function generateAutomaticRelief(pads: readonly PadPolygon[], outline: Ring, holes: readonly Ring[],
  boardWidth: number, boardHeight: number, existing: readonly ComponentReliefRegion[], allowance = .6):
  { regions: ComponentReliefRegion[]; added: number; limited: boolean } {
  const bounds = reliefEditorBounds(outline, boardWidth, boardHeight);
  const referenced = new Map<string, Group>(), unknown: PadBox[] = [];
  const board = outline.length >= 3 ? outline.map(([x, y]): [number, number] => [x, y])
    : [[bounds.minX, bounds.minY], [bounds.maxX, bounds.minY], [bounds.maxX, bounds.maxY], [bounds.minX, bounds.maxY]] as Array<[number, number]>;
  const boardHoles = holes.map(ring => ring.map(([x, y]): [number, number] => [x, y]));
  // Flash origins and averaged region centres need not lie in the exposed
  // shape. Share the same material-overlap check used during board selection.
  const intersectsBoard = panelPadFilter(board, boardHoles);
  for (const pad of pads) {
    const box = padBox(pad);
    if (!box || !intersectsBoard(pad)) continue;
    if (box.ref) {
      const group = referenced.get(box.ref);
      if (group) { Object.assign(group, union(group, box)); group.pads.push(box); }
      else referenced.set(box.ref, { ...box, pads: [box] });
    } else unknown.push(box);
  }
  const margin = Number.isFinite(allowance) ? Math.max(0, Math.min(5, allowance)) : .6;
  const regions = [...existing];
  const ids = new Set(existing.map(region => region.id));
  const proposals = [...referenced.values(), ...inferredGroups(unknown)].sort((a, b) => a.minX - b.minX || a.minY - b.minY);
  let limited = false;
  for (const group of proposals) {
    const minX = Math.max(bounds.minX, group.minX - margin), maxX = Math.min(bounds.maxX, group.maxX + margin);
    const minY = Math.max(bounds.minY, group.minY - margin), maxY = Math.min(bounds.maxY, group.maxY + margin);
    const region: ComponentReliefRegion = { id: stableId(group), shape: 'rect', x: round((minX + maxX) / 2),
      y: round((minY + maxY) / 2), width: round(maxX - minX), height: round(maxY - minY) };
    if (region.width < MIN_RELIEF_SIZE || region.height < MIN_RELIEF_SIZE || ids.has(region.id)
      || regions.some(existingRegion => coveredBy(region, existingRegion))
      || !reliefRegionIntersectsBoard(region, outline, holes, boardWidth, boardHeight)) continue;
    if (regions.length >= MAX_RELIEF_REGIONS) { limited = true; break; }
    regions.push(region); ids.add(region.id);
  }
  return { regions, added: regions.length - existing.length, limited };
}
