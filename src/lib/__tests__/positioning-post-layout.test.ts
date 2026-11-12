import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { nextTick } from 'vue';
import { DEFAULT, positioningPostLayoutFor, useConfigStore } from '../../stores/config';
import { positioningPostLayout, type PositioningPostDimensions } from '../positioning-post-layout';

beforeEach(() => setActivePinia(createPinia()));

describe('positioning-post layout', () => {
  // Coordinates independently checked against Python corner_screw_positions().
  it.each([
    [{ pcbSizeX: 40, pcbSizeY: 30, stencilSizeX: 70, stencilSizeY: 60, stencilLip: 8,
      platterCornerRadius: 3, jigSize: 110 }, 44.5],
    [{}, 57],
    [{ pcbSizeX: 40, pcbSizeY: 30, stencilSizeX: 70, stencilSizeY: 60, stencilLip: 8,
      platterCornerRadius: 3, jigSize: 110, cornerScrewD: 8, postClearance: .8, outerCornerRadius: 1 }, 47],
    [{ pcbSizeX: 40, pcbSizeY: 30, stencilSizeX: 70, stencilSizeY: 60, stencilLip: 8,
      platterCornerRadius: 0, jigSize: 110 }, 44.5],
  ] as const)('matches model coordinates for %j', (changes, offset) => {
    expect(positioningPostLayoutFor({ ...DEFAULT, ...changes }).positions).toEqual([
      [offset, offset], [offset, -offset], [-offset, offset], [-offset, -offset],
    ]);
  });

  it('moves posts outward for actual hole clearance when there is room', () => {
    const layout = positioningPostLayoutFor({ ...DEFAULT, stencilLip: 5.5, cornerScrewD: 2,
      postClearance: 1.5, outerCornerRadius: 0, jigSize: 110 });
    expect(layout.positions[0]).toEqual([49.5, 49.5]);
    expect(layout.fits).toBe(true);
  });

  it('uses the same fit boundary for minimum size, outer clamp and warnings', () => {
    const dims: PositioningPostDimensions = { jigSize: 100, windowHalf: 35.5, platterHalf: 35,
      postDiameter: 9, postClearance: 3, outerCornerRadius: 5, platterCornerRadius: 4.5 };
    const before = { ...dims };
    const undersized = positioningPostLayout(dims);
    expect(undersized.minimumJigSize).toBe(107);
    expect(undersized.fits).toBe(false);
    // The engine clamps the same impossible manual size to the outer edge.
    expect(undersized.positions[0]).toEqual([39.5, 39.5]);
    const fitted = positioningPostLayout({ ...dims, jigSize: undersized.minimumJigSize });
    expect(fitted.fits).toBe(true);
    expect(fitted.positions[0]).toEqual([43, 43]);
    expect(positioningPostLayout({ ...dims, jigSize: 106.999 }).fits).toBe(false);
    expect(dims).toEqual(before);
  });

  it('checks the platter diagonal in addition to the window and outer edge', () => {
    const dims: PositioningPostDimensions = { jigSize: 100, windowHalf: 25, platterHalf: 40,
      postDiameter: 10, postClearance: .225, outerCornerRadius: 0, platterCornerRadius: 0 };
    expect(positioningPostLayout(dims).positions[0][0]).toBeCloseTo(40 + 5 / Math.sqrt(2));
    expect(positioningPostLayout(dims).minimumJigSize).toBeCloseTo(2 * (46 + 5 / Math.sqrt(2)));
  });

  it('recommends enough jig space when post dimensions and outer corners increase', async () => {
    const store = useConfigStore();
    Object.assign(store.config, { cornerScrewD: 20, postClearance: 2, outerCornerRadius: 20,
      platterCornerRadius: 0 });
    await nextTick();
    expect(store.config.jigSize).toBe(165);
    expect(positioningPostLayoutFor(store.config).fits).toBe(true);
    expect(store.warnings.some(w => w.key === 'config.warnings.cornerScrewOutside')).toBe(false);
  });

  it('warns for real fit conflicts missed by the former fixed 3.5 mm radius', async () => {
    const store = useConfigStore();
    store.config.postClearance = 3;
    await nextTick();
    store.config.jigSize = 100;
    expect(store.warnings.some(w => w.key === 'config.warnings.cornerScrewOutside')).toBe(true);
  });

  it('does not warn when an outward shift still leaves room inside the jig', async () => {
    const store = useConfigStore();
    Object.assign(store.config, { stencilLip: 5.5, cornerScrewD: 2, postClearance: 1.5,
      outerCornerRadius: 0 });
    await nextTick();
    store.config.jigSize = 110;
    expect(store.warnings.some(w => w.key === 'config.warnings.cornerScrewOutside')).toBe(false);
  });
});
