import { expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import JSZip from 'jszip';
import { invoke } from '@tauri-apps/api/core';
import { readDroppedGerber } from '../dropped-file';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

it.each(['binary', 'fallback'] as const)('opens the real example ZIP from a %s desktop response', async transport => {
  const bytes = Uint8Array.from(readFileSync(new URL('../../../../docs/assets/examples/mason-pcb2-gerber.zip', import.meta.url)));
  const path = transport === 'binary' ? 'C:\\samples\\示例.ZIP' : '/samples/示例.ZIP';
  vi.mocked(invoke).mockResolvedValueOnce(transport === 'binary' ? bytes.buffer : Array.from(bytes));
  const file = await readDroppedGerber(path);
  expect(invoke).toHaveBeenCalledWith('read_dropped_file', { path });
  expect([file.name, file.type, file.size]).toEqual(['示例.ZIP', 'application/zip', bytes.length]);
  const zip = await JSZip.loadAsync(await file.arrayBuffer(), { checkCRC32: true });
  expect(Object.keys(zip.files).some(name => /\.gko$/i.test(name))).toBe(true);
});
