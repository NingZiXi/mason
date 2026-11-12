import type { PadPart, PadPolygon } from './gerber/pads';

type Ring = readonly (readonly [number, number])[];

/** Consistent winding makes overlapping exposures add instead of XOR. Keep
 * holes opposite to their exterior, independent of the imported ring order. */
function ringPath(ring: Ring, outer: boolean): string {
  if (ring.length < 3) return '';
  let twiceArea = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    twiceArea += a[0] * b[1] - b[0] * a[1];
  }
  const points = (twiceArea < 0) === outer ? [...ring].reverse() : ring;
  return `M${points.map(([x, y]) => `${x},${y}`).join('L')}Z`;
}

const partPath = (part: PadPart) => ringPath(part.points, true)
  + (part.holes ?? []).map(hole => ringPath(hole, false)).join('');

interface Exposure { polarity: 'D' | 'C'; path: string; maskIndex?: number }

/** Batch consecutive exposures without moving a clear operation past a later
 * dark refill. Macro primitives paint into their own initially empty mask. */
export function reliefPadGuide(pads: readonly PadPolygon[]) {
  const exposures: Exposure[] = [];
  const masked: Array<{ sourceIndex: number; exposures: Exposure[] }> = [];
  const append = (target: Exposure[], exposure: Exposure) => {
    const previous = target[target.length - 1];
    if (previous?.polarity === exposure.polarity && previous.maskIndex === undefined && exposure.maskIndex === undefined) {
      previous.path += exposure.path;
    } else target.push(exposure);
  };
  pads.forEach((pad, sourceIndex) => {
    let padDark = '';
    const primitives: Exposure[] = [];
    for (const part of pad.parts) {
      if (part.points.length < 3) continue;
      const path = partPath(part);
      if (part.polarity === 'D') padDark += path;
      // Clearing an empty aperture changes nothing, including its bounds.
      if (!primitives.length && part.polarity === 'C') continue;
      append(primitives, { polarity: part.polarity, path });
    }
    if (!padDark) return;
    const hasClear = primitives.some(part => part.polarity === 'C');
    if (hasClear) masked.push({ sourceIndex, exposures: primitives });
    append(exposures, { polarity: pad.polarity, path: padDark, ...(hasClear ? { maskIndex: sourceIndex } : {}) });
  });
  return { exposures, masked };
}
