import type { PadPolygon } from '../gerber/pads';
import type { Vec2 } from './homography';

/** Paste opening summary in board millimetres (Gerber top view, y up). */
export interface PadFeature {
  x: number;
  y: number;
  area: number;
  width: number;
  height: number;
}

/** Photographed opening in centred stencil millimetres (photo view, y up). */
export interface StencilBlob {
  x: number;
  y: number;
  area: number;
  width: number;
  height: number;
}

/**
 * Where one copy of a paste layer sits on the photographed stencil face:
 * stencil = scale · R(rotation) · M · board + (x, y), with M = mirror-X when mirrored.
 */
export interface BoardInstance {
  mirrored: boolean;
  /** Counter-clockwise radians. */
  rotation: number;
  /** Measured photo scale; ≠ 1 means the entered stencil size is off by 1/scale. */
  scale: number;
  x: number;
  y: number;
  inliers: number;
  total: number;
  /** Residual of matched centroids (mm). */
  rms: number;
  /** Indices of the blobs explained by this instance. */
  blobs: number[];
}

function ringArea(points: ReadonlyArray<readonly [number, number]>): { area: number; cx: number; cy: number } {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i < points.length; i++) {
    const [x0, y0] = points[i];
    const [x1, y1] = points[(i + 1) % points.length];
    const c = x0 * y1 - x1 * y0;
    a += c; cx += (x0 + x1) * c; cy += (y0 + y1) * c;
  }
  if (Math.abs(a) < 1e-12) return { area: 0, cx: points[0]?.[0] ?? 0, cy: points[0]?.[1] ?? 0 };
  return { area: Math.abs(a / 2), cx: cx / (3 * a), cy: cy / (3 * a) };
}

/** Exposed (dark-polarity) paste openings as centroid, area and bounds. */
export function padFeatures(pads: readonly PadPolygon[]): PadFeature[] {
  const out: PadFeature[] = [];
  for (const pad of pads) {
    if (pad.polarity !== 'D') continue;
    let area = 0, sx = 0, sy = 0;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const part of pad.parts) {
      if (part.polarity !== 'D' || part.points.length < 3) continue;
      const r = ringArea(part.points);
      area += r.area; sx += r.cx * r.area; sy += r.cy * r.area;
      for (const [x, y] of part.points) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    if (area <= 1e-6) continue;
    out.push({ x: sx / area, y: sy / area, area, width: maxX - minX, height: maxY - minY });
  }
  return out;
}

interface Orientation { quarter: number; mirrored: boolean }

const ORIENTATIONS: Orientation[] = [false, true].flatMap(mirrored =>
  [0, 1, 2, 3].map(quarter => ({ quarter, mirrored })));

function orient(f: PadFeature, o: Orientation): PadFeature {
  let x = o.mirrored ? -f.x : f.x;
  let y = f.y;
  for (let q = 0; q < o.quarter; q++) [x, y] = [-y, x];
  const swap = o.quarter % 2 === 1;
  return { x, y, area: f.area, width: swap ? f.height : f.width, height: swap ? f.width : f.height };
}

/** Uniform bucket grid over the blobs for radius queries. */
class BlobGrid {
  private readonly start: Int32Array;
  private readonly items: Int32Array;
  private readonly minX: number;
  private readonly minY: number;
  private readonly cols: number;
  private readonly rows: number;
  constructor(readonly blobs: readonly StencilBlob[], private readonly cell = 1) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const b of blobs) {
      minX = Math.min(minX, b.x); maxX = Math.max(maxX, b.x);
      minY = Math.min(minY, b.y); maxY = Math.max(maxY, b.y);
    }
    if (!blobs.length) { minX = minY = maxX = maxY = 0; }
    this.minX = minX; this.minY = minY;
    this.cols = Math.floor((maxX - minX) / cell) + 1;
    this.rows = Math.floor((maxY - minY) / cell) + 1;
    const counts = new Int32Array(this.cols * this.rows + 1);
    const cellOf = blobs.map(b => this.cellIndex(b.x, b.y));
    for (const c of cellOf) counts[c + 1]++;
    for (let i = 1; i < counts.length; i++) counts[i] += counts[i - 1];
    this.start = counts.slice();
    this.items = new Int32Array(blobs.length);
    const fill = counts.slice();
    cellOf.forEach((c, i) => { this.items[fill[c]++] = i; });
  }
  private cellIndex(x: number, y: number) {
    return Math.floor((y - this.minY) / this.cell) * this.cols + Math.floor((x - this.minX) / this.cell);
  }
  /** Nearest compatible blob within tol of (x, y), or -1. */
  nearest(x: number, y: number, tol: number, accept: (b: StencilBlob) => boolean): number {
    const i0 = Math.max(0, Math.floor((x - tol - this.minX) / this.cell));
    const i1 = Math.min(this.cols - 1, Math.floor((x + tol - this.minX) / this.cell));
    const j0 = Math.max(0, Math.floor((y - tol - this.minY) / this.cell));
    const j1 = Math.min(this.rows - 1, Math.floor((y + tol - this.minY) / this.cell));
    let best = -1, bestD = tol * tol;
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const c = j * this.cols + i;
        for (let k = this.start[c]; k < this.start[c + 1]; k++) {
          const idx = this.items[k];
          const b = this.blobs[idx];
          const d = (b.x - x) ** 2 + (b.y - y) ** 2;
          if (d <= bestD && accept(b)) { bestD = d; best = idx; }
        }
      }
    }
    return best;
  }
}

/** Openings are cut, etched and photographed slightly differently; stay tolerant. */
function compatible(f: PadFeature, b: StencilBlob, loose = false): boolean {
  const ratio = b.area / f.area;
  const [lo, hi] = loose ? [0.25, 4] : [0.35, 2.8];
  if (ratio < lo || ratio > hi) return false;
  const tol = loose ? 0.6 : 0.4;
  return Math.abs(b.width - f.width) <= tol + 0.35 * f.width
    && Math.abs(b.height - f.height) <= tol + 0.35 * f.height;
}

interface Similarity { a: number; b: number; tx: number; ty: number }

/** Least-squares q ≈ [[a,-b],[b,a]]·p + t (rotation and uniform scale). */
function fitSimilarity(p: Vec2[], q: Vec2[], allowScale: boolean): Similarity {
  const n = p.length;
  let px = 0, py = 0, qx = 0, qy = 0;
  for (let i = 0; i < n; i++) { px += p[i][0]; py += p[i][1]; qx += q[i][0]; qy += q[i][1]; }
  px /= n; py /= n; qx /= n; qy /= n;
  let sa = 0, sb = 0, sp = 0;
  for (let i = 0; i < n; i++) {
    const ax = p[i][0] - px, ay = p[i][1] - py;
    const bx = q[i][0] - qx, by = q[i][1] - qy;
    sa += ax * bx + ay * by;
    sb += ax * by - ay * bx;
    sp += ax * ax + ay * ay;
  }
  let a = 1, b = 0;
  if (n >= 2 && sp > 1e-9) {
    a = sa / sp; b = sb / sp;
    if (!allowScale) {
      const m = Math.hypot(a, b) || 1;
      a /= m; b /= m;
    }
  }
  return { a, b, tx: qx - (a * px - b * py), ty: qy - (b * px + a * py) };
}

function apply(s: Similarity, x: number, y: number): Vec2 {
  return [s.a * x - s.b * y + s.tx, s.b * x + s.a * y + s.ty];
}

interface Assignment { inliers: number; pairs: Array<[number, number]>; rms: number }

/** Greedy one-to-one assignment of oriented pads to blobs under a transform. */
function assign(feats: PadFeature[], grid: BlobGrid, s: Similarity, tol: number, loose: boolean, used?: Set<number>): Assignment {
  const taken = new Set<number>();
  const pairs: Array<[number, number]> = [];
  let sq = 0;
  for (let k = 0; k < feats.length; k++) {
    const f = feats[k];
    const [x, y] = apply(s, f.x, f.y);
    const j = grid.nearest(x, y, tol, b => compatible(f, b, loose));
    if (j < 0 || taken.has(j) || used?.has(j)) continue;
    taken.add(j);
    pairs.push([k, j]);
    sq += (grid.blobs[j].x - x) ** 2 + (grid.blobs[j].y - y) ** 2;
  }
  return { inliers: pairs.length, pairs, rms: pairs.length ? Math.sqrt(sq / pairs.length) : Infinity };
}

/**
 * Cheap pre-check for a translation hypothesis: probe a fixed sample of pads
 * and give up once the required hit count can no longer be reached.
 */
function vote(feats: PadFeature[], order: number[], grid: BlobGrid, tx: number, ty: number, tol: number, need: number, exclude?: ReadonlySet<number>): number {
  let hits = 0;
  for (let n = 0; n < order.length; n++) {
    const f = feats[order[n]];
    const j = grid.nearest(f.x + tx, f.y + ty, tol, b => compatible(f, b, true));
    if (j >= 0 && !exclude?.has(j)) hits++;
    if (hits + (order.length - n - 1) < need) return hits;
  }
  return hits;
}

export interface MatchOptions {
  /** Coarse acceptance radius for the first translation vote (mm). */
  coarseTolerance?: number;
  /** Final acceptance radius after refinement (mm). */
  tolerance?: number;
  /** Minimum share of pads that must be found for an instance. */
  minInlierRatio?: number;
  /** Cap on reported copies of this layer. */
  maxInstances?: number;
  /** Blobs already explained by another layer. */
  exclude?: ReadonlySet<number>;
  /** Restrict to these orientations (e.g. consistent with the other side). */
  orientations?: ReadonlyArray<{ quarter: number; mirrored: boolean }>;
}

const MAX_ANCHORS = 24;
/** Distinct translations refined per orientation. */
const MAX_HYPOTHESES = 12;

/** Find every copy of a paste layer on the stencil, best first. */
export function findBoardInstances(pads: readonly PadFeature[], blobs: readonly StencilBlob[], opts: MatchOptions = {}): BoardInstance[] {
  if (pads.length === 0 || blobs.length === 0) return [];
  const coarse = opts.coarseTolerance ?? 0.6;
  const tol = opts.tolerance ?? 0.4;
  const minRatio = opts.minInlierRatio ?? 0.6;
  const minInliers = Math.min(pads.length, 3);
  const grid = new BlobGrid(blobs);
  const exclude = opts.exclude;
  const candidates: BoardInstance[] = [];

  for (const o of opts.orientations ?? ORIENTATIONS) {
    const feats = pads.map(f => orient(f, o));
    const byArea = feats.map((_, i) => i).sort((i, j) => feats[j].area - feats[i].area);
    const anchors = new Set<number>(byArea.slice(0, MAX_ANCHORS / 2));
    for (let k = 0; anchors.size < Math.min(MAX_ANCHORS, feats.length); k++) {
      anchors.add(byArea[Math.floor((k * byArea.length) / (MAX_ANCHORS / 2)) % byArea.length]);
      if (k > MAX_ANCHORS * 4) break;
    }
    // Every pad is probed, but in a spread-out order so misses show up early.
    const order = feats.map((_, i) => i).sort((i, j) => hash(i) - hash(j));
    const need = Math.max(minInliers, Math.ceil(minRatio * 0.7 * feats.length));
    const seen = new Set<number>();
    const hypotheses: Array<{ score: number; tx: number; ty: number }> = [];
    for (const ai of anchors) {
      const f = feats[ai];
      for (let bj = 0; bj < blobs.length; bj++) {
        if (exclude?.has(bj) || !compatible(f, blobs[bj], true)) continue;
        const tx = blobs[bj].x - f.x, ty = blobs[bj].y - f.y;
        const key = Math.round(tx / 0.3) * 100003 + Math.round(ty / 0.3);
        if (seen.has(key)) continue;
        seen.add(key);
        const inliers = vote(feats, order, grid, tx, ty, coarse, need, exclude);
        if (inliers >= need) hypotheses.push({ score: inliers, tx, ty });
      }
    }
    hypotheses.sort((a, b) => b.score - a.score);
    // Anchors on one copy vote slightly different translations; keep only the
    // strongest of each cluster so weaker copies still reach refinement.
    const distinct: typeof hypotheses = [];
    for (const h of hypotheses) {
      if (distinct.some(d => Math.hypot(d.tx - h.tx, d.ty - h.ty) < 1.5)) continue;
      distinct.push(h);
      if (distinct.length >= MAX_HYPOTHESES) break;
    }
    for (const h of distinct) {
      const refined = refine(feats, grid, { a: 1, b: 0, tx: h.tx, ty: h.ty }, coarse, tol, exclude as Set<number> | undefined);
      if (!refined) continue;
      const { s, result } = refined;
      if (result.inliers < minInliers || result.inliers < minRatio * feats.length) continue;
      const scale = Math.hypot(s.a, s.b);
      candidates.push({
        mirrored: o.mirrored,
        rotation: normalizeAngle(o.quarter * Math.PI / 2 + Math.atan2(s.b, s.a)),
        scale, x: s.tx, y: s.ty,
        inliers: result.inliers, total: feats.length, rms: result.rms,
        blobs: result.pairs.map(([, j]) => j),
      });
    }
  }

  // Strongest explanations first; later copies may not reuse their openings.
  candidates.sort((a, b) => b.inliers - a.inliers || a.rms - b.rms);
  const claimed = new Set<number>();
  const accepted: BoardInstance[] = [];
  for (const c of candidates) {
    if (c.blobs.some(j => claimed.has(j))) continue;
    accepted.push(c);
    c.blobs.forEach(j => claimed.add(j));
    if (accepted.length >= (opts.maxInstances ?? 8)) break;
  }
  return accepted;
}

function refine(feats: PadFeature[], grid: BlobGrid, start: Similarity, coarse: number, tol: number, used?: Set<number>) {
  let s = start;
  let result = assign(feats, grid, s, coarse, true, used);
  for (let iter = 0; iter < 6; iter++) {
    if (result.pairs.length < 2) return null;
    const p = result.pairs.map(([k]) => [feats[k].x, feats[k].y] as Vec2);
    const q = result.pairs.map(([, j]) => [grid.blobs[j].x, grid.blobs[j].y] as Vec2);
    // Scale is only observable over a reasonable spread of openings.
    s = fitSimilarity(p, q, result.pairs.length >= 6);
    const radius = iter < 2 ? coarse : tol;
    result = assign(feats, grid, s, radius, iter < 2, used);
  }
  return { s, result };
}

/** Deterministic scramble for probe order. */
function hash(i: number) {
  return Math.imul(i + 1, 2654435761) >>> 0;
}

export function normalizeAngle(a: number): number {
  let r = a % (2 * Math.PI);
  if (r <= -Math.PI) r += 2 * Math.PI;
  if (r > Math.PI) r -= 2 * Math.PI;
  return r;
}
