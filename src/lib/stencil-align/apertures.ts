import { applyHomography, solveHomography, type Vec2 } from './homography';
import { boxBlur, createGray, percentile, sampleBilinear, type GrayImage } from './image';
import type { Quad } from './quad';

/** A photographed opening, in rectified stencil millimetres (origin top-left, y down). */
export interface ApertureBlob {
  x: number;
  y: number;
  area: number;
  width: number;
  height: number;
}

/**
 * Resample the photo into a fronto-parallel stencil image.
 * Pixel (i, j) covers stencil millimetres [i/ppm, (i+1)/ppm) from the TL corner.
 */
export function rectifyStencil(img: GrayImage, quad: Quad, sizeX: number, sizeY: number, ppm: number): GrayImage {
  const w = Math.max(1, Math.round(sizeX * ppm));
  const h = Math.max(1, Math.round(sizeY * ppm));
  const H = solveHomography([[0, 0], [w, 0], [w, h], [0, h]], quad);
  const out = createGray(w, h);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const [x, y] = applyHomography(H, [i + 0.5, j + 0.5]);
      out.data[j * w + i] = sampleBilinear(img, x, y);
    }
  }
  return out;
}

export interface ApertureOptions {
  ppm: number;
  /** Largest expected opening side (mm); sets the background window. */
  maxFeature: number;
  /** Ignore this band along the sheet edge (mm). */
  border?: number;
  /** Detection threshold in local noise units. */
  sigma?: number;
}

/** Neighbourhood for the local noise estimate (mm). */
const LOCAL_NOISE_MM = 4;

/** Masked box mean: average of img where weight is set, NaN where none is. */
function maskedMean(img: GrayImage, weight: Float32Array, radius: number): Float32Array {
  const { width: w, height: h } = img;
  const num = createGray(w, h);
  for (let i = 0; i < num.data.length; i++) num.data[i] = img.data[i] * weight[i];
  const a = boxBlur(num, radius).data;
  const b = boxBlur({ width: w, height: h, data: weight }, radius).data;
  const out = new Float32Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = b[i] > 0.02 ? a[i] / b[i] : NaN;
  return out;
}

/**
 * Openings show whatever lies under the sheet, so against a reflective sheet
 * they can be darker in one place and brighter in another. Estimate the sheet
 * with a masked mean that excludes candidate openings, then keep residuals
 * that are large relative to the local sheet texture, in either direction.
 */
export function detectApertures(rect: GrayImage, opts: ApertureOptions): ApertureBlob[] {
  const { ppm } = opts;
  const { width: w, height: h } = rect;
  const radius = Math.round(Math.min(8, Math.max(1.5, opts.maxFeature * 1.25)) * ppm);
  const k = opts.sigma ?? 4;

  // Pass 1: plain background, global noise, provisional opening mask.
  const bg0 = boxBlur(rect, radius).data;
  const abs0 = new Float32Array(w * h);
  for (let i = 0; i < abs0.length; i++) abs0[i] = Math.abs(rect.data[i] - bg0[i]);
  const global = Math.max(1, percentile(abs0, 0.5) * 1.4826);
  const sheet = new Float32Array(w * h);
  for (let i = 0; i < sheet.length; i++) sheet[i] = abs0[i] < 2.5 * global ? 1 : 0;

  // Pass 2: background from sheet pixels only, then local texture level.
  const bgMasked = maskedMean(rect, sheet, radius);
  const resp = new Float32Array(w * h);
  const absResp = createGray(w, h);
  for (let i = 0; i < resp.length; i++) {
    const bg = Number.isNaN(bgMasked[i]) ? bg0[i] : bgMasked[i];
    resp[i] = rect.data[i] - bg;
    absResp.data[i] = Math.abs(resp[i]);
  }
  const noise = maskedMean(absResp, sheet, Math.round(LOCAL_NOISE_MM * ppm));
  const floor = Math.max(1, global * 0.4);

  const border = Math.round((opts.border ?? 1.5) * ppm);
  const bright = new Uint8Array(w * h);
  const dark = new Uint8Array(w * h);
  for (let y = border; y < h - border; y++) {
    for (let x = border; x < w - border; x++) {
      const i = y * w + x;
      const n = Number.isNaN(noise[i]) ? global : noise[i];
      const t = k * 1.25 * Math.max(n, floor); // mean |x| ≈ 0.8σ
      if (resp[i] > t) bright[i] = 1;
      else if (resp[i] < -t) dark[i] = 1;
    }
  }
  return [...labelBlobs(bright, w, h), ...labelBlobs(dark, w, h)].map(b => ({
    x: b.sx / b.n / ppm + 0.5 / ppm,
    y: b.sy / b.n / ppm + 0.5 / ppm,
    area: b.n / (ppm * ppm),
    width: (b.maxX - b.minX + 1) / ppm,
    height: (b.maxY - b.minY + 1) / ppm,
  }));
}

interface Component { n: number; sx: number; sy: number; minX: number; maxX: number; minY: number; maxY: number }

/** 4-connected component statistics using a two-pass union-find labelling. */
export function labelBlobs(mask: Uint8Array, w: number, h: number): Component[] {
  const labels = new Int32Array(w * h);
  const parent: number[] = [0];
  const find = (a: number) => {
    while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; }
    return a;
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!mask[i]) continue;
      const up = y > 0 ? labels[i - w] : 0;
      const left = x > 0 ? labels[i - 1] : 0;
      if (!up && !left) {
        parent.push(parent.length);
        labels[i] = parent.length - 1;
      } else if (up && left) {
        const ru = find(up), rl = find(left);
        labels[i] = Math.min(ru, rl);
        if (ru !== rl) parent[Math.max(ru, rl)] = Math.min(ru, rl);
      } else {
        labels[i] = up || left;
      }
    }
  }
  const stats = new Map<number, Component>();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const l = labels[y * w + x];
      if (!l) continue;
      const r = find(l);
      let c = stats.get(r);
      if (!c) { c = { n: 0, sx: 0, sy: 0, minX: x, maxX: x, minY: y, maxY: y }; stats.set(r, c); }
      c.n++; c.sx += x; c.sy += y;
      if (x < c.minX) c.minX = x;
      if (x > c.maxX) c.maxX = x;
      if (y < c.minY) c.minY = y;
      if (y > c.maxY) c.maxY = y;
    }
  }
  return [...stats.values()];
}

/** Map a rectified stencil point (mm, top-left origin, y down) back into the photo. */
export function stencilToPhoto(quad: Quad, sizeX: number, sizeY: number, p: Vec2): Vec2 {
  return photoMapper(quad, sizeX, sizeY)(p);
}

/** Reusable mapping from rectified stencil millimetres into photo pixels. */
export function photoMapper(quad: Quad, sizeX: number, sizeY: number): (p: Vec2) => Vec2 {
  const H = solveHomography([[0, 0], [sizeX, 0], [sizeX, sizeY], [0, sizeY]], quad);
  return p => applyHomography(H, p);
}
