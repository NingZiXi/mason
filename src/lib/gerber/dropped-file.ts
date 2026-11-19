import { invoke } from '@tauri-apps/api/core';

export async function readDroppedGerber(path: string): Promise<File> {
  const name = path.split(/[/\\]/).pop() || path;
  const bytes = await invoke<ArrayBuffer | number[]>('read_dropped_file', { path });
  // Tauri's postMessage fallback can return an array instead of a binary response.
  // Passing that array directly to File would turn the ZIP into comma-separated text.
  const part = Array.isArray(bytes) ? new Uint8Array(bytes) : bytes;
  return new File([part], name, { type: /\.zip$/i.test(name) ? 'application/zip' : 'text/plain' });
}
