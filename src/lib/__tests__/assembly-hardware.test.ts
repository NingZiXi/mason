import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { computed, nextTick } from 'vue';
import { DEFAULT, SCREW_SPECS, useConfigStore } from '../../stores/config';
import { assemblyHardware, CLAMP_SHEET_ESTIMATE } from '../assembly-hardware';

beforeEach(() => setActivePinia(createPinia()));

describe('clamp assembly hardware', () => {
  it('recommends M3 × 8 for default plates and counts only actual perimeter holes', () => {
    const store = useConfigStore();
    const count = store.screwPositions.length;
    expect(count).toBeGreaterThan(0);
    expect(assemblyHardware(store.config, count)).toMatchObject({
      state: 'ready', screwLength: 8, screwCount: count, nutCount: count, customFit: false,
    });
  });

  it('updates counts for spacing, geometry changes and disabled perimeter screws', async () => {
    const store = useConfigStore();
    const list = computed(() => assemblyHardware(store.config, store.screwPositions.length));
    const original = list.value.screwCount;
    store.config.screwSpacing = 20;
    expect(list.value.screwCount).toBeGreaterThan(original);
    store.config.stencilSizeX = 180; await nextTick();
    expect(list.value.screwCount).toBe(store.screwPositions.length);
    expect(list.value.nutCount).toBe(list.value.screwCount);
    store.config.screwSpacing = 0;
    expect(list.value).toMatchObject({ state: 'off', screwCount: 0, nutCount: 0, screwLength: null });
  });

  it('uses only clamp thicknesses, excluding the tray, PCB and printed-stencil thickness', () => {
    const before = assemblyHardware(DEFAULT, 12);
    const changed = { ...DEFAULT, insertHeight: 20, pcbThickness: 4, stencilThickness: 1.5 };
    expect(assemblyHardware(changed, 12)).toEqual(before);
    expect(assemblyHardware({ ...DEFAULT, baseHeight: 6 }, 12).screwLength).toBe(10);
    expect(assemblyHardware({ ...DEFAULT, topCoverHeight: 6 }, 12).screwLength).toBe(10);
  });

  it('does not round up into the tray or suggest an incompletely engaged shorter screw', () => {
    const list = assemblyHardware({ ...DEFAULT, topCoverHeight: 4.5 }, 12);
    expect(list.state).toBe('customLength');
    expect(list.screwLength).toBeNull();
    expect(list.lengthRange![0]).toBeCloseTo(8.5);
    expect(list.lengthRange![1]).toBeCloseTo(8.7);
  });

  it.each(Object.keys(SCREW_SPECS) as Array<keyof typeof SCREW_SPECS>)(
    'uses the selected %s spec and fits the full nut without crossing the bottom', async spec => {
      const store = useConfigStore();
      store.config.screwSpec = spec; await nextTick();
      store.config.baseHeight = 6;
      const list = assemblyHardware(store.config, 12);
      expect(list.state).toBe('ready');
      expect(list.screwLength).toBe(10);
      expect(list.customFit).toBe(false);
      const top = store.config.baseHeight + store.config.topCoverHeight + CLAMP_SHEET_ESTIMATE;
      const tip = top - list.screwLength!;
      const nutTop = store.config.nutHeight + .2;
      expect(tip).toBeGreaterThanOrEqual(-1e-7);
      expect(nutTop - tip).toBeGreaterThanOrEqual(store.config.nutHeight - 1e-7);
    },
  );

  it('does not claim machine screws will hold when nut pockets are disabled', () => {
    expect(assemblyHardware({ ...DEFAULT, useHexNut: false }, 12)).toMatchObject({
      state: 'selfTap', screwCount: 12, nutCount: 0, screwLength: null, lengthRange: null,
    });
  });

  it.each([2.3, 2.6])('flags a nut pocket that cuts through a %s mm base', baseHeight => {
    expect(assemblyHardware({ ...DEFAULT, baseHeight }, 12).state).toBe('pocketThrough');
  });

  it.each([2.8, 3])('does not recommend M3 screws through a %s mm hole', periScrewD => {
    expect(assemblyHardware({ ...DEFAULT, periScrewD }, 12).state).toBe('holeTooSmall');
  });

  it('keeps custom nut dimensions and hole sizes visible instead of replacing them with nominal values', () => {
    const custom = { ...DEFAULT, nutAcrossFlats: 6, nutHeight: 2, periScrewD: 3.4 };
    expect(assemblyHardware(custom, 12)).toMatchObject({ state: 'ready', customFit: true, screwLength: 8 });
    // Pocket assembly clearance is not the purchased nut's width or height.
    const widerPocket = { ...DEFAULT, nutPocketClearance: .6 };
    expect(assemblyHardware(widerPocket, 12).customFit).toBe(false);
  });

  it.each([NaN, 0, -1, Infinity])('does not produce a length for invalid thickness %s', baseHeight => {
    expect(assemblyHardware({ ...DEFAULT, baseHeight }, 12)).toMatchObject({ state: 'invalid', screwLength: null });
  });
});
