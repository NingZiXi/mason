import * as THREE from "three";
import type { PadPolygon } from "./gerber/pads";
type Ring = readonly (readonly [number, number])[];

/** A raster aperture mask preserves Gerber dark/clear polarity and overlapping
 * macros without triangulating thousands of overlapping holes in the UI thread. */
export function createPadTexture(width: number, height: number, pads: readonly PadPolygon[], centerX = 0, centerY = 0, outline?: Ring, holes: readonly Ring[] = []) {
  if (!pads.length || typeof document === "undefined") return null;
  const scale = Math.min(20, 2048 / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.ceil(width * scale));
  canvas.height = Math.max(1, Math.ceil(height * scale));
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "white";
  const patch = document.createElement("canvas");
  for (const pad of pads) {
    const points = pad.parts.flatMap(part => part.points);
    if (points.length < 3) continue;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    points.forEach(([x, y]) => { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); });
    const left = Math.max(0, Math.floor((minX - centerX + width / 2) * scale) - 1);
    const top = Math.max(0, Math.floor((height / 2 + centerY - maxY) * scale) - 1);
    const right = Math.min(canvas.width, Math.ceil((maxX - centerX + width / 2) * scale) + 1);
    const bottom = Math.min(canvas.height, Math.ceil((height / 2 + centerY - minY) * scale) + 1);
    if (right <= left || bottom <= top) continue;
    patch.width = right - left;
    patch.height = bottom - top;
    const p = patch.getContext("2d")!;
    p.fillStyle = "white";
    for (const part of pad.parts) {
      if (part.points.length < 3) continue;
      p.globalCompositeOperation = part.polarity === "C" ? "destination-out" : "source-over";
      p.beginPath();
      for (const ring of [part.points, ...(part.holes ?? [])]) {
        ring.forEach(([x, y], i) => {
          const px = (x - centerX + width / 2) * scale - left;
          const py = (height / 2 + centerY - y) * scale - top;
          if (i === 0) p.moveTo(px, py); else p.lineTo(px, py);
        });
        p.closePath();
      }
      p.fill("evenodd");
    }
    ctx.globalCompositeOperation = pad.polarity === "C" ? "destination-out" : "source-over";
    ctx.drawImage(patch, left, top);
  }
  if (outline) {
    ctx.globalCompositeOperation = "destination-in";
    ctx.beginPath();
    for (const ring of [outline, ...holes]) {
      ring.forEach(([x, y], i) => {
        const px = (x - centerX + width / 2) * scale;
        const py = (height / 2 + centerY - y) * scale;
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      });
      ctx.closePath();
    }
    ctx.fill("evenodd");
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.anisotropy = 4;
  return texture;
}

/** Invert the same exposure mask for steel: pads become apertures. */
export function createStencilTexture(width: number, height: number, pads: readonly PadPolygon[]) {
  const padsTexture = createPadTexture(width, height, pads);
  if (!padsTexture) return null;
  const source = padsTexture.image as HTMLCanvasElement;
  const canvas = document.createElement("canvas");
  canvas.width = source.width;
  canvas.height = source.height;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.globalCompositeOperation = "destination-out";
  ctx.drawImage(source, 0, 0);
  padsTexture.dispose();
  const texture = new THREE.CanvasTexture(canvas);
  texture.anisotropy = 4;
  return texture;
}
