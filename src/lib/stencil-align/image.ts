/** Single-channel float image, row-major, values roughly 0..255. */
export interface GrayImage {
  width: number;
  height: number;
  data: Float32Array;
}

export function createGray(width: number, height: number): GrayImage {
  return { width, height, data: new Float32Array(width * height) };
}

/** Luma from RGBA bytes (canvas ImageData layout). */
export function rgbaToGray(rgba: ArrayLike<number>, width: number, height: number): GrayImage {
  const out = createGray(width, height);
  for (let i = 0, j = 0; i < out.data.length; i++, j += 4) {
    out.data[i] = 0.299 * rgba[j] + 0.587 * rgba[j + 1] + 0.114 * rgba[j + 2];
  }
  return out;
}

/** Area-average downscale so the longer side is at most maxDim. */
export function downscale(img: GrayImage, maxDim: number): { image: GrayImage; factor: number } {
  const factor = Math.max(1, Math.ceil(Math.max(img.width, img.height) / maxDim));
  if (factor === 1) return { image: img, factor };
  const w = Math.floor(img.width / factor);
  const h = Math.floor(img.height / factor);
  const out = createGray(w, h);
  const norm = 1 / (factor * factor);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let dy = 0; dy < factor; dy++) {
        const row = (y * factor + dy) * img.width + x * factor;
        for (let dx = 0; dx < factor; dx++) sum += img.data[row + dx];
      }
      out.data[y * w + x] = sum * norm;
    }
  }
  return { image: out, factor };
}

/** Box mean with a (2r+1)² window; edges use the available pixels only. */
export function boxBlur(img: GrayImage, radius: number): GrayImage {
  const r = Math.max(0, Math.round(radius));
  if (r === 0) return { ...img, data: img.data.slice() };
  const { width: w, height: h } = img;
  const sat = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += img.data[y * w + x];
      sat[(y + 1) * (w + 1) + x + 1] = sat[y * (w + 1) + x + 1] + row;
    }
  }
  const out = createGray(w, h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
      const s = sat[y1 * (w + 1) + x1] - sat[y0 * (w + 1) + x1] - sat[y1 * (w + 1) + x0] + sat[y0 * (w + 1) + x0];
      out.data[y * w + x] = s / ((y1 - y0) * (x1 - x0));
    }
  }
  return out;
}

/** Bilinear sample with edge clamping. */
export function sampleBilinear(img: GrayImage, x: number, y: number): number {
  const { width: w, height: h, data } = img;
  const cx = Math.min(Math.max(x, 0), w - 1);
  const cy = Math.min(Math.max(y, 0), h - 1);
  const x0 = Math.floor(cx), y0 = Math.floor(cy);
  const x1 = Math.min(x0 + 1, w - 1), y1 = Math.min(y0 + 1, h - 1);
  const fx = cx - x0, fy = cy - y0;
  const a = data[y0 * w + x0], b = data[y0 * w + x1];
  const c = data[y1 * w + x0], d = data[y1 * w + x1];
  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
}

/** Approximate percentile of a large array via a 1024-bin histogram. */
export function percentile(values: ArrayLike<number>, q: number): number {
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!(max > min)) return Number.isFinite(min) ? min : 0;
  const bins = 1024;
  const hist = new Uint32Array(bins);
  const scale = (bins - 1) / (max - min);
  for (let i = 0; i < values.length; i++) hist[Math.round((values[i] - min) * scale)]++;
  const target = q * values.length;
  let acc = 0;
  for (let b = 0; b < bins; b++) {
    acc += hist[b];
    if (acc >= target) return min + b / scale;
  }
  return max;
}
