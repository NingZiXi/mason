import { boxBlur, downscale, percentile, sampleBilinear, type GrayImage } from './image';
import type { Vec2 } from './homography';

/** Stencil corners in photo pixels, ordered TL, TR, BR, BL as seen in the photo. */
export type Quad = [Vec2, Vec2, Vec2, Vec2];

interface Line { theta: number; r: number; votes: number }

const DETECT_MAX_DIM = 800;
const THETA_BINS = 180;

/**
 * Find the four straight edges of a metal stencil lying on a contrasting
 * background. A gradient-oriented Hough transform proposes the dominant pair
 * of roughly parallel lines in each of two perpendicular directions; every
 * edge is then re-fitted on the full-resolution photo for sub-pixel corners.
 *
 * @param aspect expected stencil width/height (X/Y). Used to decide which
 *   photo edge corresponds to the stencil X axis for rectangular stencils.
 */
export function detectStencilQuad(img: GrayImage, aspect = 1): Quad | null {
  const { image: small, factor } = downscale(img, DETECT_MAX_DIM);
  const lines = houghLines(small);
  if (lines.length < 4) return null;
  const dominant = lines[0].theta;
  const near = (t: number, ref: number) => {
    const d = Math.abs(((t - ref) % Math.PI + Math.PI * 1.5) % Math.PI - Math.PI / 2);
    return d < (25 * Math.PI) / 180;
  };
  const famA = lines.filter(l => near(l.theta, dominant));
  const famB = lines.filter(l => near(l.theta, dominant + Math.PI / 2));
  const span = Math.min(small.width, small.height) * 0.2;
  const a = pickPair(famA, span);
  const b = pickPair(famB, span);
  if (!a || !b) return null;
  const corners: Vec2[] = [];
  for (const la of a) for (const lb of b) {
    const p = intersect(la, lb);
    if (!p) return null;
    corners.push([p[0] * factor, p[1] * factor]);
  }
  let quad = orderCorners(corners, aspect);
  const area = polygonArea(quad);
  if (area < 0.05 * img.width * img.height) return null;
  quad = refineQuad(img, quad);
  return quad;
}

function houghLines(img: GrayImage): Line[] {
  const g = boxBlur(boxBlur(img, 1), 1);
  const { width: w, height: h } = g;
  const mag = new Float32Array(w * h);
  const ang = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = g.data[i + 1] - g.data[i - 1];
      const gy = g.data[i + w] - g.data[i - w];
      mag[i] = Math.hypot(gx, gy);
      ang[i] = Math.atan2(gy, gx);
    }
  }
  const thr = percentile(mag, 0.95);
  const diag = Math.ceil(Math.hypot(w, h));
  const acc = new Float32Array(THETA_BINS * (2 * diag + 1));
  const cos = new Float32Array(THETA_BINS), sin = new Float32Array(THETA_BINS);
  for (let t = 0; t < THETA_BINS; t++) {
    cos[t] = Math.cos((t * Math.PI) / THETA_BINS);
    sin[t] = Math.sin((t * Math.PI) / THETA_BINS);
  }
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (mag[i] <= thr) continue;
      const theta = ((ang[i] % Math.PI) + Math.PI) % Math.PI;
      const tb = Math.round((theta / Math.PI) * THETA_BINS);
      for (let d = -1; d <= 1; d++) {
        const t = (tb + d + THETA_BINS) % THETA_BINS;
        const r = Math.round(x * cos[t] + y * sin[t]) + diag;
        acc[t * (2 * diag + 1) + r] += mag[i];
      }
    }
  }
  const lines: Line[] = [];
  const rows = 2 * diag + 1;
  for (let k = 0; k < 12; k++) {
    let best = 0, bi = -1;
    for (let i = 0; i < acc.length; i++) if (acc[i] > best) { best = acc[i]; bi = i; }
    if (bi < 0) break;
    const t = Math.floor(bi / rows), r = (bi % rows) - diag;
    lines.push(normalizeLine({ theta: (t * Math.PI) / THETA_BINS, r, votes: best }));
    // Suppress the peak's neighbourhood, including its wrapped twin (θ+π, -r).
    for (let dt = -8; dt <= 8; dt++) {
      const tt = t + dt;
      const wrapped = tt < 0 || tt >= THETA_BINS;
      const tw = (tt + THETA_BINS) % THETA_BINS;
      const rc = wrapped ? -r : r;
      for (let dr = -15; dr <= 15; dr++) {
        const rr = rc + dr + diag;
        if (rr >= 0 && rr < rows) acc[tw * rows + rr] = 0;
      }
    }
  }
  return lines;
}

/** Keep θ in (-π/4, 3π/4] so near-vertical lines do not split across the wrap. */
function normalizeLine(l: Line): Line {
  return l.theta > (Math.PI * 3) / 4 ? { theta: l.theta - Math.PI, r: -l.r, votes: l.votes } : l;
}

function pickPair(family: Line[], minSeparation: number): [Line, Line] | null {
  let best: [Line, Line] | null = null;
  let score = 0;
  for (let i = 0; i < family.length; i++) {
    for (let j = i + 1; j < family.length; j++) {
      if (Math.abs(family[i].r - family[j].r) < minSeparation) continue;
      const s = Math.min(family[i].votes, family[j].votes);
      if (s > score) { score = s; best = [family[i], family[j]]; }
    }
  }
  return best;
}

function intersect(a: Line, b: Line): Vec2 | null {
  const det = Math.cos(a.theta) * Math.sin(b.theta) - Math.sin(a.theta) * Math.cos(b.theta);
  if (Math.abs(det) < 1e-6) return null;
  return [
    (a.r * Math.sin(b.theta) - b.r * Math.sin(a.theta)) / det,
    (b.r * Math.cos(a.theta) - a.r * Math.cos(b.theta)) / det,
  ];
}

/**
 * Order corners clockwise on screen from the top-left one. For rectangular
 * stencils, start at the corner whose first edge best matches the X length.
 */
export function orderCorners(points: readonly Vec2[], aspect = 1): Quad {
  const cx = points.reduce((s, p) => s + p[0], 0) / points.length;
  const cy = points.reduce((s, p) => s + p[1], 0) / points.length;
  const sorted = [...points].sort((p, q) => Math.atan2(p[1] - cy, p[0] - cx) - Math.atan2(q[1] - cy, q[0] - cx));
  // atan2 order in image coordinates (y down) starts near the top-left corner.
  let quad = sorted as Quad;
  if (Math.abs(Math.log(aspect)) > 0.05) {
    const len = (i: number) => Math.hypot(quad[(i + 1) % 4][0] - quad[i][0], quad[(i + 1) % 4][1] - quad[i][1]);
    const measured = (len(0) + len(2)) / (len(1) + len(3));
    const fits = Math.abs(Math.log(measured / aspect));
    const swapped = Math.abs(Math.log(1 / measured / aspect));
    if (swapped < fits) quad = [quad[3], quad[0], quad[1], quad[2]];
  }
  return quad;
}

export function polygonArea(points: readonly Vec2[]): number {
  let s = 0;
  for (let i = 0; i < points.length; i++) {
    const [x0, y0] = points[i];
    const [x1, y1] = points[(i + 1) % points.length];
    s += x0 * y1 - x1 * y0;
  }
  return Math.abs(s) / 2;
}

/** Re-fit each edge to the strongest step along its normal, then re-intersect. */
export function refineQuad(img: GrayImage, quad: Quad): Quad {
  const size = Math.hypot(quad[2][0] - quad[0][0], quad[2][1] - quad[0][1]);
  const search = Math.max(6, Math.round(size * 0.015));
  const edges: Line[] = [];
  for (let e = 0; e < 4; e++) {
    const a = quad[e], b = quad[(e + 1) % 4];
    const fit = refineEdge(img, a, b, search);
    if (!fit) return quad;
    edges.push(fit);
  }
  const out: Vec2[] = [];
  for (let i = 0; i < 4; i++) {
    const p = intersect(edges[(i + 3) % 4], edges[i]);
    if (!p) return quad;
    out.push(p);
  }
  // A refinement that moves a corner far from the coarse estimate is not trusted.
  const moved = out.some((p, i) => Math.hypot(p[0] - quad[i][0], p[1] - quad[i][1]) > search * 1.5);
  return moved ? quad : (out as Quad);
}

function refineEdge(img: GrayImage, a: Vec2, b: Vec2, search: number): Line | null {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  if (len < 10) return null;
  const tx = dx / len, ty = dy / len;
  const nx = -ty, ny = tx;
  const samples: Vec2[] = [];
  const count = 48;
  for (let k = 0; k < count; k++) {
    // Stay away from rounded or damaged corners.
    const t = 0.1 + (0.8 * k) / (count - 1);
    const px = a[0] + dx * t, py = a[1] + dy * t;
    let best = 0, bestS = 0;
    const profile: number[] = [];
    for (let s = -search - 2; s <= search + 2; s++) {
      let v = 0;
      for (let o = -2; o <= 2; o++) v += sampleBilinear(img, px + nx * s + tx * o, py + ny * s + ty * o);
      profile.push(v / 5);
    }
    for (let s = -search; s <= search; s++) {
      const i = s + search + 2;
      const d = Math.abs(profile[i + 2] + profile[i + 1] - profile[i - 1] - profile[i - 2]);
      if (d > best) { best = d; bestS = s; }
    }
    samples.push([px + nx * bestS, py + ny * bestS]);
  }
  let line = fitLine(samples);
  if (!line) return null;
  // One robust pass: drop points far from the first fit (scratches, glare).
  const res = samples.map(p => Math.abs(p[0] * Math.cos(line!.theta) + p[1] * Math.sin(line!.theta) - line!.r));
  const cutoff = Math.max(1.5, percentile(res, 0.6) * 2.5);
  const kept = samples.filter((_, i) => res[i] <= cutoff);
  if (kept.length >= 8) line = fitLine(kept) ?? line;
  return line;
}

/** Total least squares line in normal form. */
function fitLine(points: readonly Vec2[]): Line | null {
  if (points.length < 2) return null;
  let mx = 0, my = 0;
  for (const [x, y] of points) { mx += x; my += y; }
  mx /= points.length; my /= points.length;
  let sxx = 0, syy = 0, sxy = 0;
  for (const [x, y] of points) {
    sxx += (x - mx) ** 2; syy += (y - my) ** 2; sxy += (x - mx) * (y - my);
  }
  // Direction of the smallest eigenvector is the normal.
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy) + Math.PI / 2;
  return { theta, r: mx * Math.cos(theta) + my * Math.sin(theta), votes: points.length };
}
