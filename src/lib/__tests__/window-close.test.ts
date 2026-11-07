import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { clearMocks, mockIPC, mockWindows } from '@tauri-apps/api/mocks';
import { createWindowCloseHandler } from '../window-close';

afterEach(() => {
  if (typeof window !== 'undefined') clearMocks();
  vi.unstubAllGlobals();
});

describe('desktop close confirmation', () => {
  it('can execute the real SDK destroy command with the main window capability', async () => {
    const capability = JSON.parse(readFileSync(new URL('../../../src-tauri/capabilities/default.json', import.meta.url), 'utf8'));
    expect(capability.windows).toContain('main');
    const commands: string[] = [];
    vi.stubGlobal('window', {});
    mockIPC((command) => {
      commands.push(command);
      if (command === 'plugin:window|destroy' && !capability.permissions.includes('core:window:allow-destroy')) {
        throw new Error('window.destroy not allowed');
      }
    });
    mockWindows('main');
    const nativeWindow = getCurrentWindow();
    const confirm = vi.fn(async () => true), failed = vi.fn();
    const event = { preventDefault: vi.fn() };
    await createWindowCloseHandler(confirm, () => nativeWindow.destroy(), failed)(event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(confirm).toHaveBeenCalledOnce();
    expect(commands).toEqual(['plugin:window|destroy']);
    expect(failed).not.toHaveBeenCalled();
  });

  it('keeps the window open when confirmation is cancelled and permits retry', async () => {
    const confirm = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const destroy = vi.fn(async () => {}), failed = vi.fn();
    const handler = createWindowCloseHandler(confirm, destroy, failed);
    await handler({ preventDefault: vi.fn() });
    expect(destroy).not.toHaveBeenCalled();
    await handler({ preventDefault: vi.fn() });
    expect(destroy).toHaveBeenCalledOnce();
    expect(failed).not.toHaveBeenCalled();
  });

  it('prevents repeated close requests while the confirmation is pending', async () => {
    let resolve!: (answer: boolean) => void;
    const confirm = vi.fn(() => new Promise<boolean>(done => { resolve = done; }));
    const destroy = vi.fn(async () => {});
    const handler = createWindowCloseHandler(confirm, destroy, vi.fn());
    const first = handler({ preventDefault: vi.fn() });
    const second = { preventDefault: vi.fn() };
    await handler(second);
    expect(second.preventDefault).toHaveBeenCalledOnce();
    expect(confirm).toHaveBeenCalledOnce();
    resolve(true); await first;
    expect(destroy).toHaveBeenCalledOnce();
  });

  it('reports a native close failure and lets the user retry', async () => {
    const error = new Error('native close failed');
    const destroy = vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce(undefined);
    const failed = vi.fn(), confirm = vi.fn(async () => true);
    const handler = createWindowCloseHandler(confirm, destroy, failed);
    await handler({ preventDefault: vi.fn() });
    expect(failed).toHaveBeenCalledWith(error);
    await handler({ preventDefault: vi.fn() });
    expect(destroy).toHaveBeenCalledTimes(2);
    expect(confirm).toHaveBeenCalledTimes(2);
  });
});
