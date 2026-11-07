import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import { nextTick } from 'vue';
import { useConfigStore } from '../../stores/config';
import { usePresetsStore } from '../../stores/presets';
import { DEFAULT_PRESET_ID, PRESETS_STORAGE_KEY, presetName } from '../config-presets';
import { presetCopyName, switchPresetWithEdits, type PresetSwitchChoice } from '../preset-workflow';

let pinia: ReturnType<typeof createPinia>;
let disk: Map<string, string>;
let storage: { getItem: (key: string) => string | null; setItem: (key: string, value: string) => void };
beforeEach(() => {
  pinia = createPinia(); setActivePinia(pinia);
  disk = new Map();
  storage = { getItem: key => disk.get(key) ?? null, setItem: (key, value) => { disk.set(key, value); } };
  vi.stubGlobal('localStorage', storage);
});
afterEach(() => { disposePinia(pinia); vi.unstubAllGlobals(); });

async function setup() {
  const store = usePresetsStore(), config = useConfigStore();
  await store.initialize();
  config.config.padShrink = 5; store.saveAs('Printer A'); const source = store.selectedId;
  config.config.padShrink = 10; store.saveAs('Printer B'); const target = store.selectedId;
  await store.select(source);
  return { store, config, source, target };
}

function ui(choice: PresetSwitchChoice, name: string | null = 'Printer C') {
  return { choose: vi.fn(async () => choice), requestName: vi.fn(async () => name) };
}

describe('preset switching workflow', () => {
  it('switches clean presets directly without asking or creating a copy', async () => {
    const { store, config, target } = await setup(); const dialogs = ui('cancel');
    expect(await switchPresetWithEdits(store, target, dialogs)).toBe('switched');
    expect(dialogs.choose).not.toHaveBeenCalled();
    expect(dialogs.requestName).not.toHaveBeenCalled();
    expect(config.config.padShrink).toBe(10);
    expect(store.presets).toHaveLength(2);
  });

  it('saves edits into the source preset before switching to the target', async () => {
    const { store, config, source, target } = await setup();
    config.config.padShrink = 15;
    expect(await switchPresetWithEdits(store, target, ui('save'))).toBe('saved-and-switched');
    expect(store.presets.find(p => p.id === source)?.settings.padShrink).toBe(15);
    expect(store.selectedId).toBe(target);
    expect(config.config.padShrink).toBe(10);
    await store.select(source);
    expect(config.config.padShrink).toBe(15);
  });

  it('saves a separate copy before switching, leaving the original preset unchanged', async () => {
    const { store, config, source, target } = await setup();
    config.config.padShrink = 15;
    expect(await switchPresetWithEdits(store, target, ui('saveAs'))).toBe('saved-and-switched');
    const copy = store.presets.find(p => p.name === 'Printer C')!;
    expect(copy.settings.padShrink).toBe(15);
    expect(store.presets.find(p => p.id === source)?.settings.padShrink).toBe(5);
    expect(store.selectedId).toBe(target);
    expect(config.config.padShrink).toBe(10);
    await store.select(copy.id);
    expect(config.config.padShrink).toBe(15);
  });

  it('can save edits from Default while switching without overwriting Default', async () => {
    const { store, config, target } = await setup();
    await store.select(DEFAULT_PRESET_ID);
    config.config.padShrink = 20;
    await switchPresetWithEdits(store, target, ui('saveAs'));
    expect(store.presets.find(p => p.name === 'Printer C')?.settings.padShrink).toBe(20);
    await store.select(DEFAULT_PRESET_ID);
    expect(config.config.padShrink).toBe(0);
  });

  it('discards only the current unsaved edits when explicitly requested', async () => {
    const { store, config, source, target } = await setup();
    config.config.padShrink = 15; const dialogs = ui('discard');
    expect(await switchPresetWithEdits(store, target, dialogs)).toBe('switched');
    expect(dialogs.requestName).not.toHaveBeenCalled();
    expect(store.presets.find(p => p.id === source)?.settings.padShrink).toBe(5);
    expect(config.config.padShrink).toBe(10);
  });

  it.each(['choice', 'name'] as const)('keeps edits and selection when the %s dialog is cancelled', async which => {
    const { store, config, source, target } = await setup();
    config.config.padShrink = 15; const before = disk.get(PRESETS_STORAGE_KEY);
    const dialogs = ui(which === 'choice' ? 'cancel' : 'saveAs', null);
    expect(await switchPresetWithEdits(store, target, dialogs)).toBe('cancelled');
    expect(store.selectedId).toBe(source);
    expect(config.config.padShrink).toBe(15);
    expect(disk.get(PRESETS_STORAGE_KEY)).toBe(before);
  });

  it('does not switch after dismissing the naming prompt with Escape or X', async () => {
    const { store, config, source, target } = await setup(); config.config.padShrink = 15;
    const dialogs = ui('saveAs'); dialogs.requestName.mockRejectedValue('cancel');
    await expect(switchPresetWithEdits(store, target, dialogs)).rejects.toBe('cancel');
    expect(store.selectedId).toBe(source);
    expect(config.config.padShrink).toBe(15);
  });

  it.each(['save', 'saveAs'] as const)('stops switching when %s fails to write to disk', async choice => {
    const { store, config, source, target } = await setup(); config.config.padShrink = 15;
    const before = disk.get(PRESETS_STORAGE_KEY);
    vi.spyOn(storage, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    await expect(switchPresetWithEdits(store, target, ui(choice))).rejects.toThrow('presets.storageFailed');
    expect(store.selectedId).toBe(source);
    expect(config.config.padShrink).toBe(15);
    expect(store.presets).toHaveLength(2);
    expect(disk.get(PRESETS_STORAGE_KEY)).toBe(before);
  });

  it('does not prompt or write anything when reselecting the current preset', async () => {
    const { store, config, source } = await setup(); config.config.padShrink = 15;
    const dialogs = ui('discard');
    expect(await switchPresetWithEdits(store, source, dialogs)).toBe('cancelled');
    expect(dialogs.choose).not.toHaveBeenCalled();
    expect(config.config.padShrink).toBe(15);
  });

  it('waits for dependent dimension watchers before saving the current settings', async () => {
    const { store, config, source, target } = await setup();
    config.config.screwSpec = 'M5';
    await switchPresetWithEdits(store, target, ui('save'));
    const original = store.presets.find(p => p.id === source)!;
    expect(original.settings.screwSpec).toBe('M5');
    expect(original.settings.periScrewD).toBe(5.3);
    expect(original.settings.nutAcrossFlats).toBe(8);
  });
});

describe('copying a preset', () => {
  it('copies an unchanged custom preset and selects the copy without applying other settings', async () => {
    const { store, config, source } = await setup();
    expect(store.dirty).toBe(false);
    const before = JSON.parse(JSON.stringify(config.config));
    const name = presetCopyName(store.selected?.name, store.presets, '副本');
    expect(name).toBe('Printer A · 副本');
    store.saveAs(name);
    expect(store.selectedId).not.toBe(source);
    expect(store.selected?.name).toBe(name);
    expect(store.presets.find(p => p.id === source)?.settings).toEqual(store.selected?.settings);
    expect(config.config).toEqual(before);
  });

  it('suggests unique names for repeated copies and fits long original names', async () => {
    const { store } = await setup();
    store.saveAs('Printer A · 副本'); store.saveAs('Printer A · 副本 2');
    expect(presetCopyName('Printer A', store.presets, '副本')).toBe('Printer A · 副本 3');
    const longName = presetCopyName('😀'.repeat(20), store.presets, 'copy');
    expect(longName.length).toBeLessThanOrEqual(40);
    expect(presetName(longName, store.presets)).toBe(longName);
    expect(longName).not.toMatch(/[\uD800-\uDBFF] ·/);
    expect(presetCopyName(undefined, store.presets, '副本')).toBe('');
    await nextTick();
  });
});
