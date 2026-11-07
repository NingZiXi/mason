import { describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { defaultExportName, validExportName } from '../export-name';
import { useConfigStore } from '../../stores/config';

describe('export folder names', () => {
  it('uses the imported archive name, preserving Chinese names and internal dots', () => {
    expect(defaultExportName('C:\\boards\\控制板.v2.zip')).toBe('控制板.v2');
    expect(defaultExportName('/boards/PCB.zip')).toBe('PCB');
    expect(defaultExportName(null)).toBe('Mason');
  });

  it('rejects path traversal, device names and names that cannot be created across platforms', () => {
    for (const name of ['', '.', '..', '../outside', 'a/b', 'a\\b', 'a:b', 'CON', 'nul.txt', 'COM1', 'LPT²', 'CON .txt', 'name.', ' name', 'a\n', '板'.repeat(70)]) {
      expect(validExportName(name), name).toBe(false);
    }
    expect(validExportName('控制板 v2.1')).toBe(true);
    expect(validExportName(defaultExportName('板'.repeat(100) + '.zip'))).toBe(true);
    expect(validExportName(defaultExportName('CON.zip'))).toBe(true);
  });

  it('keeps the archive name across panel selections and clears it for another import', () => {
    setActivePinia(createPinia());
    const store = useConfigStore();
    const variant = { width: 20, height: 10, center: { x: 0, y: 0 },
      outlinePoints: [[0, 0], [20, 0], [20, 10], [0, 10]] as Array<[number, number]>, outlineHoles: [] };
    const payload = { filename: 'Gerber/BoardOutline.GKO', sourceFilename: '控制板.zip', isPanel: true,
      hasPads: false, mode: 'panel' as const, variants: { panel: variant, single: variant } };
    store.applyGerberImport(payload);
    store.setPanelBoard(0);
    expect(store.gerberSourceFilename).toBe('控制板.zip');
    store.applyGerberImport({ ...payload, sourceFilename: undefined });
    expect(store.gerberSourceFilename).toBeNull();
    store.applyGerberImport(payload);
    store.clearPanelScope();
    expect(store.gerberSourceFilename).toBeNull();
  });
});
