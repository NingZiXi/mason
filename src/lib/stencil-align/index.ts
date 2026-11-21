import type { PadPolygon } from '../gerber/pads';
import { detectApertures, rectifyStencil } from './apertures';
import type { GrayImage } from './image';
import { findBoardInstances, padFeatures, type BoardInstance, type PadFeature, type StencilBlob } from './match';
import { detectStencilQuad, type Quad } from './quad';

export type { BoardInstance, StencilBlob } from './match';
export type { Quad } from './quad';
export type { GrayImage } from './image';
export { detectStencilQuad, orderCorners } from './quad';
export { rgbaToGray, downscale } from './image';
export { photoMapper, stencilToPhoto } from './apertures';
export { jigPlacementFromInstance, placePoint, type JigBoardPlacement, type PrintSide } from './placement';

export interface StencilPhotoInput {
  image: GrayImage;
  stencilSizeX: number;
  stencilSizeY: number;
  topPads: readonly PadPolygon[];
  bottomPads: readonly PadPolygon[];
  /** Board bounds in the pads' coordinates (centred on the board origin). */
  boardWidth: number;
  boardHeight: number;
  /** Corners supplied or corrected by the user; detected automatically when omitted. */
  quad?: Quad;
}

export interface StencilPhotoResult {
  quad: Quad;
  /** Openings found on the sheet, centred stencil millimetres, photo view, y up. */
  blobs: StencilBlob[];
  top: BoardInstance[];
  bottom: BoardInstance[];
}

export class StencilPhotoError extends Error {
  constructor(readonly code: 'stencilNotFound' | 'noPads' | 'noMatch') {
    super(code);
  }
}

/** Rectified resolution; capped so large sheets stay fast. */
function rectifyPpm(sizeX: number, sizeY: number) {
  return Math.max(4, Math.min(10, Math.sqrt(4e6 / (sizeX * sizeY))));
}

/**
 * Locate the stencil in a photo and find where each paste layer was cut on it.
 */
export function alignStencilPhoto(input: StencilPhotoInput): StencilPhotoResult {
  const { stencilSizeX: sx, stencilSizeY: sy } = input;
  const top = padFeatures(input.topPads);
  const bottom = padFeatures(input.bottomPads);
  if (top.length === 0 && bottom.length === 0) throw new StencilPhotoError('noPads');
  const quad = input.quad ?? detectStencilQuad(input.image, sx / sy);
  if (!quad) throw new StencilPhotoError('stencilNotFound');

  const ppm = rectifyPpm(sx, sy);
  const rect = rectifyStencil(input.image, quad, sx, sy, ppm);
  const maxFeature = Math.max(1, ...[...top, ...bottom].map(f => Math.max(f.width, f.height)));
  const maxArea = Math.max(...[...top, ...bottom].map(f => f.area));

  const blobs = detectApertures(rect, { ppm, maxFeature })
    .filter(b => b.area >= 0.02 && b.area <= maxArea * 4 + 1)
    .map(b => ({ ...b, x: b.x - sx / 2, y: sy / 2 - b.y }));
  const footprint = { width: input.boardWidth, height: input.boardHeight, sheetX: sx / 2, sheetY: sy / 2 };
  const matched = matchLayers(top, bottom, blobs, footprint);
  if (matched.top.length === 0 && matched.bottom.length === 0) throw new StencilPhotoError('noMatch');
  return { quad, blobs, ...matched };
}

interface Footprint { width: number; height: number; sheetX: number; sheetY: number }
interface Box { x0: number; y0: number; x1: number; y1: number }

/** Board bounds on the sheet, assuming a near quarter-turn rotation. */
function footprintBox(i: BoardInstance, f: Footprint): Box {
  const quarter = Math.round(i.rotation / (Math.PI / 2));
  const [w, h] = quarter % 2 === 0 ? [f.width, f.height] : [f.height, f.width];
  return { x0: i.x - w / 2, y0: i.y - h / 2, x1: i.x + w / 2, y1: i.y + h / 2 };
}

/** Copies are cut side by side; boards may touch but not overlap. */
const OVERLAP_SLACK_MM = 1;
/** Pads near the sheet edge can belong to a board slightly larger than the sheet window. */
const SHEET_SLACK_MM = 2;

function overlaps(a: Box, b: Box) {
  const s = OVERLAP_SLACK_MM;
  return a.x0 + s < b.x1 && b.x0 + s < a.x1 && a.y0 + s < b.y1 && b.y0 + s < a.y1;
}

function onSheet(b: Box, f: Footprint) {
  const s = SHEET_SLACK_MM;
  return b.x0 >= -f.sheetX - s && b.x1 <= f.sheetX + s && b.y0 >= -f.sheetY - s && b.y1 <= f.sheetY + s;
}

/**
 * Match the layer with more openings first: it is the least ambiguous. A
 * double-sided stencil cuts the other face mirrored, so the second layer
 * prefers the mirrored orientations and the openings not yet explained.
 * Every accepted copy must fit on the sheet without overlapping another one,
 * which rejects small pad groups that happen to recur inside a larger board.
 */
function matchLayers(top: PadFeature[], bottom: PadFeature[], blobs: StencilBlob[], footprint: Footprint) {
  const firstIsTop = top.length >= bottom.length;
  const [first, second] = firstIsTop ? [top, bottom] : [bottom, top];
  const placed: Box[] = [];
  const keep = (list: BoardInstance[]) => list.filter(i => {
    const box = footprintBox(i, footprint);
    if (!onSheet(box, footprint) || placed.some(p => overlaps(p, box))) return false;
    placed.push(box);
    return true;
  });
  const a = keep(findBoardInstances(first, blobs));
  const claimed = new Set(a.flatMap(i => i.blobs));
  let b: BoardInstance[] = [];
  if (second.length) {
    const lead = a[0];
    if (lead) {
      const q = Math.round(lead.rotation / (Math.PI / 2));
      const consistent = [q, q + 2].map(quarter => ({ quarter: ((quarter % 4) + 4) % 4, mirrored: !lead.mirrored }));
      b = keep(findBoardInstances(second, blobs, { exclude: claimed, orientations: consistent, minInlierRatio: 0.8 }));
    }
    if (b.length === 0) b = keep(findBoardInstances(second, blobs, { exclude: claimed, minInlierRatio: 0.8 }));
  }
  return firstIsTop ? { top: a, bottom: b } : { top: b, bottom: a };
}
