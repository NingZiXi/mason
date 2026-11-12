import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { computed, nextTick, reactive } from 'vue';
import { DEFAULT, useConfigStore } from '../../stores/config';
import { ejectHoleLimits, ejectHoleSize, resolveEjectHoleSize } from '../eject-hole';
import { pickPresetSettings, readPresetSettings } from '../config-presets';
import { buildScadParams, modelParamsHash, scadPartHash } from '../model-params';

beforeEach(() => setActivePinia(createPinia()));

describe('eject-hole diameter preferences', () => {
  it('migrates legacy numeric on/off settings without interpreting them as diameters', () => {
    for (const ejectSlotWidth of [0, 1, 22, 40]) {
      const restored = readPresetSettings({ ejectSlotWidth }, DEFAULT);
      expect(restored.ejectSlotWidth).toBe(ejectSlotWidth);
      expect(restored.ejectHoleDiameter).toBe(0);
    }
    expect(ejectHoleSize(DEFAULT).diameter).toBeCloseTo(17.64);
  });

  it('retains the manual preference through saved presets even when the hole is off', async () => {
    const store = useConfigStore();
    store.config.ejectSlotWidth = 0;
    store.config.ejectHoleDiameter = 15.5;
    const saved = JSON.parse(JSON.stringify(pickPresetSettings(store.config)));
    await store.applyUserSettings(readPresetSettings(saved, DEFAULT));
    expect(store.config.ejectSlotWidth).toBe(0);
    expect(store.config.ejectHoleDiameter).toBe(15.5);
    store.config.ejectSlotWidth = DEFAULT.ejectSlotWidth;
    expect(ejectHoleSize(store.config).diameter).toBe(15.5);
    store.reset();
    expect(store.config.ejectHoleDiameter).toBe(0);
  });

  it.each([-1, .1, 3.9, 40.5, NaN, Infinity, true, '12'])('rejects an invalid saved diameter %s', value => {
    expect(() => readPresetSettings({ ejectHoleDiameter: value }, DEFAULT)).toThrow('presets.invalidData');
  });

  it.each([0, 4, 4.5, 12, 40])('accepts automatic sizing or a valid manual diameter %s', value => {
    expect(readPresetSettings({ ejectHoleDiameter: value }, DEFAULT).ejectHoleDiameter).toBe(value);
  });

  it('keeps a whole slider gesture in one undo step and remembers size when switched off and on', async () => {
    const store = useConfigStore();
    await nextTick();
    store.clearParameterHistory();
    store.beginParameterInteraction();
    store.config.ejectHoleDiameter = 8;
    await nextTick();
    store.config.ejectHoleDiameter = 12;
    await nextTick();
    store.config.ejectHoleDiameter = 16;
    await nextTick();
    store.endParameterInteraction();
    expect(store.config.ejectHoleDiameter).toBe(16);
    await store.undo();
    expect(store.config.ejectHoleDiameter).toBe(0);
    await store.redo();
    expect(store.config.ejectHoleDiameter).toBe(16);
    store.beginParameterInteraction();
    store.config.ejectSlotWidth = 0;
    await nextTick();
    store.endParameterInteraction();
    expect(store.config.ejectHoleDiameter).toBe(16);
    await store.undo();
    expect(store.config.ejectSlotWidth).toBe(22);
    expect(store.config.ejectHoleDiameter).toBe(16);
    await store.redo();
    expect(store.config.ejectSlotWidth).toBe(0);
    expect(store.config.ejectHoleDiameter).toBe(16);
  });

  it('transports the preference and invalidates only enabled tray geometry', () => {
    const store = useConfigStore();
    const original = buildScadParams(store.config), originalHash = modelParamsHash(store.config);
    store.config.ejectHoleDiameter = 12;
    const changed = buildScadParams(store.config);
    expect(changed.eject_hole_diameter).toBe(12);
    expect(modelParamsHash(store.config)).not.toBe(originalHash);
    expect(scadPartHash(changed, 'insert')).not.toBe(scadPartHash(original, 'insert'));
    for (const part of ['base', 'cover', 'stencil_top', 'stencil_bottom']) {
      expect(scadPartHash(changed, part)).toBe(scadPartHash(original, part));
    }
    store.config.ejectSlotWidth = 0;
    const disabled = buildScadParams(store.config), disabledHash = modelParamsHash(store.config);
    store.config.ejectHoleDiameter = 30;
    expect(modelParamsHash(store.config)).toBe(disabledHash);
    expect(scadPartHash(buildScadParams(store.config), 'insert')).toBe(scadPartHash(disabled, 'insert'));
    store.config.appMode = 'stencil';
    const stencilHash = modelParamsHash(store.config);
    store.config.ejectHoleDiameter = 20;
    expect(modelParamsHash(store.config)).toBe(stencilHash);
  });
});

describe('eject-hole sizing bounds', () => {
  it('handles detailed outlines without spreading their vertices into a function call', () => {
    const pcbOutlinePoints = Array.from({ length: 150_000 }, (_, index): [number, number] => {
      const angle = index / 150_000 * Math.PI * 2;
      return [20 * Math.cos(angle), 15 * Math.sin(angle)];
    });
    const size = ejectHoleSize({ ...DEFAULT, pcbOutlinePoints, ejectHoleDiameter: 30 });
    expect(size.diameter).toBeCloseTo(26.4);
    expect(size.max).toBe(26);
  });

  it('reuses board limits throughout diameter changes and recalculates them when the board changes', () => {
    const config = reactive({ ...DEFAULT, pcbOutlinePoints: [] as Array<[number, number]> });
    let scans = 0;
    const limits = computed(() => { ++scans; return ejectHoleLimits(config); });
    const size = computed(() => resolveEjectHoleSize(limits.value, config.ejectHoleDiameter));
    expect(size.value.diameter).toBeCloseTo(17.64);
    config.ejectHoleDiameter = 8;
    expect(size.value.diameter).toBe(8);
    config.ejectHoleDiameter = 12;
    expect(size.value.diameter).toBe(12);
    expect(scans).toBe(1);
    config.pcbSizeY = 10;
    expect(size.value.diameter).toBeCloseTo(6.4);
    expect(scans).toBe(2);
  });

  it('uses imported outline bounds rather than the stale board dimension fields', () => {
    const size = ejectHoleSize({ ...DEFAULT, pcbSizeX: 200, pcbSizeY: 100,
      pcbOutlinePoints: [[100, 100], [130, 100], [130, 120], [100, 120]], ejectHoleDiameter: 25 });
    expect(size.diameter).toBeCloseTo(16.4);
    expect(size.max).toBe(16);
    expect(size.clamped).toBe(true);
    expect(size.custom).toBe(true);
  });

  it('preserves legacy omission on small boards while allowing a manually sized hole', () => {
    const board = { ...DEFAULT, pcbSizeX: 20, pcbSizeY: 18 };
    const auto = ejectHoleSize(board);
    expect(auto.diameter).toBe(0);
    expect(auto.available).toBe(true);
    const manual = ejectHoleSize({ ...board, ejectHoleDiameter: 8 });
    expect(manual.diameter).toBe(8);
    expect(manual.max).toBe(14);
  });

  it('limits the hole for a smaller board without overwriting the saved preference', () => {
    const config = { ...DEFAULT, pcbSizeX: 15, pcbSizeY: 12, ejectHoleDiameter: 30 };
    expect(ejectHoleSize(config).diameter).toBeCloseTo(8.4);
    expect(config.ejectHoleDiameter).toBe(30);
    expect(ejectHoleSize({ ...config, pcbSizeX: 80, pcbSizeY: 80 }).diameter).toBe(30);
  });

  it('disables the slider when even the minimum hole cannot fit', () => {
    const size = ejectHoleSize({ ...DEFAULT, pcbSizeX: 6, pcbSizeY: 6, ejectHoleDiameter: 4 });
    expect(size.available).toBe(false);
    expect(size.diameter).toBe(0);
    expect(size.min).toBe(4);
    expect(size.max).toBe(4);
    expect(size.clamped).toBe(true);
  });

  it('allows the minimum manual hole when a narrow board has only one selectable size', () => {
    const config = { ...DEFAULT, pcbSizeX: 8, pcbSizeY: 8, pcbPocketClearance: 0 };
    const auto = ejectHoleSize(config);
    expect(auto.available).toBe(true);
    expect(auto.max).toBe(auto.min);
    expect(auto.diameter).toBe(0);
    expect(ejectHoleSize({ ...config, ejectHoleDiameter: auto.min }).diameter).toBe(4);
  });

  it('keeps the old adaptive minimum/cap and supports larger manual holes', () => {
    expect(ejectHoleSize({ ...DEFAULT, pcbSizeX: 26, pcbSizeY: 26 }).autoDiameter).toBe(12);
    expect(ejectHoleSize({ ...DEFAULT, pcbSizeX: 150, pcbSizeY: 120 }).autoDiameter).toBe(30);
    const manual = ejectHoleSize({ ...DEFAULT, pcbSizeX: 150, pcbSizeY: 120, ejectHoleDiameter: 40 });
    expect(manual.diameter).toBe(40);
    expect(manual.max).toBe(40);
  });
});
