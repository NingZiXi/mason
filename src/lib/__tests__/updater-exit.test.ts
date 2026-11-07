import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import { check } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { useUpdaterStore } from '../../stores/updater';
import { useWorkSessionStore } from '../../stores/work-session';
import { useConfigStore } from '../../stores/config';

vi.mock('@tauri-apps/plugin-updater', () => ({ check: vi.fn() }));
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch: vi.fn() }));
let pinia: ReturnType<typeof createPinia>;
beforeEach(() => { pinia = createPinia(); setActivePinia(pinia); vi.clearAllMocks(); });
afterEach(() => disposePinia(pinia));

describe('update exit boundary without drafts', () => {
  it('asks about edits made during download and skips installation when cancelled', async () => {
    const session = useWorkSessionStore(); await session.initialize();
    const install = vi.fn();
    vi.mocked(check).mockResolvedValue({
      download: vi.fn(async () => { useConfigStore().config.postClearance = .3; }), install,
    } as unknown as Awaited<ReturnType<typeof check>>);
    const updater = useUpdaterStore(); await updater.checkForUpdates();
    const prompt = vi.fn(async () => false);
    await updater.installUpdate(() => session.confirmExit(prompt));
    expect(prompt).toHaveBeenCalledOnce();
    expect(install).not.toHaveBeenCalled();
    expect(relaunch).not.toHaveBeenCalled();
    expect(updater.status).toBe('available');
  });

  it('installs and restarts after the user explicitly confirms exit', async () => {
    const session = useWorkSessionStore(); await session.initialize();
    useConfigStore().config.postClearance = .3;
    const install = vi.fn(async () => {});
    vi.mocked(check).mockResolvedValue({ download: vi.fn(async () => {}), install } as unknown as Awaited<ReturnType<typeof check>>);
    const updater = useUpdaterStore(); await updater.checkForUpdates();
    await updater.installUpdate(() => session.confirmExit(async () => true));
    expect(install).toHaveBeenCalledOnce();
    expect(relaunch).toHaveBeenCalledOnce();
  });
});
