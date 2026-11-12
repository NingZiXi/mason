import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPadTexture, createStencilTexture } from '../gerber-pad-texture';
import type { PadPart, PadPolygon } from '../gerber/pads';

type Point = [number, number];
type Alpha = (x: number, y: number) => number;
type Exposure = { mode: string; alpha: Alpha };
const rect = (x: number, y: number, w: number, h: number): Point[] =>
  [[x - w / 2, y - h / 2], [x + w / 2, y - h / 2], [x + w / 2, y + h / 2], [x - w / 2, y + h / 2]];
const part = (points: Point[], polarity: 'D' | 'C' = 'D', holes?: Point[][]): PadPart =>
  ({ points, polarity, ...(holes ? { holes } : {}) });
const pad = (parts: PadPart[], polarity: 'D' | 'C' = 'D'): PadPolygon =>
  ({ type: 'macro', cx: 0, cy: 0, polarity, parts });
const remoteClear = () => [part(rect(-90, -90, 1, 1), 'C'), part(rect(90, 90, 1, 1), 'C')];

function inside(ring: Point[], x: number, y: number): boolean {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) hit = !hit;
  }
  return hit;
}

/** Generic Canvas alpha/compositing mock. Each fill samples a pixel at 4x4
 * subpixels; the production function supplies every path, crop and draw call. */
function setup() {
  const stats = { copiedPixels: 0, resizedPixels: 0, copies: [] as Array<[number, number]> };
  class MemoryCanvas {
    private w = 300;
    private h = 150;
    private context: Context | null = null;
    exposures: Exposure[] = [];
    get width() { return this.w; }
    set width(value: number) { this.w = value; this.reset(); }
    get height() { return this.h; }
    set height(value: number) { this.h = value; this.reset(); }
    private reset() {
      stats.resizedPixels += this.w * this.h;
      this.exposures = []; this.context = null;
    }
    getContext() { return this.context ??= new Context(this); }
    snapshot(): Alpha {
      const width = this.w, height = this.h, exposures = this.exposures.slice();
      return (x, y) => {
        if (x < 0 || y < 0 || x >= width || y >= height) return 0;
        let value = 0;
        for (const exposure of exposures) {
          const alpha = exposure.alpha(x, y);
          value = exposure.mode === 'destination-out' ? value * (1 - alpha)
            : exposure.mode === 'destination-in' ? value * alpha : alpha + value * (1 - alpha);
        }
        return value;
      };
    }
  }
  class Context {
    fillStyle = '';
    globalCompositeOperation = 'source-over';
    private paths: Point[][] = [];
    constructor(private canvas: MemoryCanvas) {}
    beginPath() { this.paths = []; }
    moveTo(x: number, y: number) { this.paths.push([[x, y]]); }
    lineTo(x: number, y: number) { this.paths[this.paths.length - 1].push([x, y]); }
    closePath() {}
    fill() {
      const paths = this.paths.map(path => path.slice());
      this.canvas.exposures.push({ mode: this.globalCompositeOperation, alpha: (x, y) => {
        let covered = 0;
        for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) {
          let hit = false;
          for (const ring of paths) if (inside(ring, x + (sx + .5) / 4, y + (sy + .5) / 4)) hit = !hit;
          if (hit) covered++;
        }
        return covered / 16;
      } });
    }
    fillRect(x: number, y: number, w: number, h: number) {
      this.canvas.exposures.push({ mode: this.globalCompositeOperation,
        alpha: (px, py) => px >= x && py >= y && px < x + w && py < y + h ? 1 : 0 });
    }
    drawImage(source: MemoryCanvas, x: number, y: number) {
      stats.copiedPixels += source.width * source.height;
      stats.copies.push([source.width, source.height]);
      const sample = source.snapshot();
      this.canvas.exposures.push({ mode: this.globalCompositeOperation, alpha: (px, py) => sample(px - x, py - y) });
    }
  }
  vi.stubGlobal('document', { createElement: () => new MemoryCanvas() });
  const sample = (texture: NonNullable<ReturnType<typeof createPadTexture>>, x: number, y: number,
    width = 3, height = 3, centerX = 0, centerY = 0) => {
    const scale = Math.min(20, 2048 / Math.max(width, height));
    return (texture.image as unknown as MemoryCanvas).snapshot()(Math.floor((x - centerX + width / 2) * scale),
      Math.floor((height / 2 + centerY - y) * scale));
  };
  return { stats, sample };
}

afterEach(() => vi.unstubAllGlobals());

describe('Gerber pad texture patches', () => {
  it('keeps dense macro patch work local despite distant clear primitives', () => {
    const { stats } = setup();
    const pads = Array.from({ length: 1024 }, (_, i) => {
      const x = (i % 32 - 15.5) * 2.7, y = (Math.floor(i / 32) - 15.5) * 2.7;
      return pad([part(rect(x, y, .8, .8)), ...remoteClear(), part(rect(x, y, .2, 1.2), 'C')]);
    });
    const original = JSON.stringify(pads);
    const texture = createPadTexture(100, 100, pads)!;
    expect(stats.copies).toHaveLength(1024);
    expect(stats.copiedPixels).toBeLessThan(400_000);
    expect(stats.resizedPixels).toBeLessThan(5_100_000);
    expect(Math.max(...stats.copies.map(([w, h]) => w * h))).toBeLessThan(400);
    expect(JSON.stringify(pads)).toBe(original);
    texture.dispose();
  });

  it('preserves the order of dark, clear and refilling macro parts', () => {
    const { sample } = setup();
    const texture = createPadTexture(3, 3, [pad([part(rect(0, 0, 2, 2)), ...remoteClear(),
      part(rect(0, 0, .8, 2.4), 'C'), part(rect(0, 0, .2, .2))])])!;
    expect(sample(texture, 0, 0)).toBe(1);
    expect(sample(texture, .2, 0)).toBe(0);
    expect(sample(texture, .7, 0)).toBe(1);
    texture.dispose();
  });

  it('preserves macro holes and global clear exposure before a later refill', () => {
    const { sample } = setup();
    const texture = createPadTexture(3, 3, [pad([part(rect(0, 0, 2, 2))]),
      pad([part(rect(0, 0, 1.6, 1.6)), ...remoteClear(), part(rect(0, 0, .6, .6), 'C')], 'C'),
      pad([part(rect(.6, 0, .2, .2))])])!;
    expect(sample(texture, 0, 0)).toBe(1);
    expect(sample(texture, .4, 0)).toBe(0);
    expect(sample(texture, .6, 0)).toBe(1);
    expect(sample(texture, .9, 0)).toBe(1);
    texture.dispose();
  });

  it('retains inner rings of both dark and clear parts', () => {
    const { sample } = setup();
    const texture = createPadTexture(3, 3, [pad([part(rect(0, 0, 2, 2), 'D', [rect(0, 0, .4, .4)]),
      part(rect(0, 0, 10, 10), 'C', [rect(0, 0, 1.2, 1.2)])])])!;
    expect(sample(texture, 0, 0)).toBe(0);
    expect(sample(texture, .4, 0)).toBe(1);
    expect(sample(texture, .8, 0)).toBe(0);
    texture.dispose();
  });

  it('skips clear-only and degenerate macros without erasing earlier pads', () => {
    const { sample, stats } = setup();
    const texture = createPadTexture(3, 3, [pad([part(rect(0, 0, 2, 2))]), pad(remoteClear(), 'C'),
      pad([part([[0, 0], [1, 1]], 'D', [rect(0, 0, 3, 3)])])])!;
    expect(stats.copies).toHaveLength(1);
    expect(sample(texture, 0, 0)).toBe(1);
    texture.dispose();
  });

  it('preserves evenodd support outside a dark contour when the existing clip includes it', () => {
    const { sample } = setup();
    const texture = createPadTexture(3, 3, [pad([part(rect(0, 0, .4, .4), 'D', [rect(.9, 0, .5, .5)]),
      ...remoteClear()])])!;
    expect(sample(texture, 0, 0)).toBe(1);
    expect(sample(texture, .4, 0)).toBe(0);
    expect(sample(texture, .9, 0)).toBe(1);
    texture.dispose();
  });

  it('retains the original clip instead of exposing a previously clipped external hole', () => {
    const { sample } = setup();
    const texture = createPadTexture(3, 3, [pad([part(rect(0, 0, .4, .4), 'D', [rect(.9, 0, .5, .5)]),
      part(rect(.3, .3, .1, .1), 'C')])])!;
    expect(sample(texture, 0, 0)).toBe(1);
    expect(sample(texture, .9, 0)).toBe(0);
    texture.dispose();
  });

  it('keeps board clipping, cutouts and an offset origin', () => {
    const { sample } = setup();
    const texture = createPadTexture(3, 3, [pad([part(rect(.2, .1, 5, 5)), ...remoteClear()])], .2, .1,
      rect(.2, .1, 2, 2), [rect(.2, .1, .2, .2)])!;
    expect(sample(texture, .2, .1, 3, 3, .2, .1)).toBe(0);
    expect(sample(texture, .6, .4, 3, 3, .2, .1)).toBe(1);
    expect(sample(texture, 1.4, 0, 3, 3, .2, .1)).toBe(0);
    texture.dispose();
  });

  it('uses the same exposure mask when inverting apertures for steel', () => {
    const { sample } = setup();
    const texture = createStencilTexture(3, 3, [pad([part(rect(0, 0, 1, 1)), ...remoteClear(),
      part(rect(0, 0, .2, .2), 'C')])])!;
    expect(sample(texture, 0, 0)).toBe(1);
    expect(sample(texture, .3, 0)).toBe(0);
    expect(sample(texture, .8, 0)).toBe(1);
    texture.dispose();
  });
});
