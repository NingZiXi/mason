import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { clearMocks, mockIPC, mockWindows } from '@tauri-apps/api/mocks';
import { fitMainWindowToMonitor, planWindowFit } from '../window-layout';

afterEach(() => {
  if (typeof window !== 'undefined') clearMocks();
  vi.unstubAllGlobals();
});

describe('startup window fitting', () => {
  it('keeps a window that already fits at its current size and position', () => {
    const plan = planWindowFit({ x: 0, y: 0, width: 1920, height: 1040 },
      { x: 80, y: 60, width: 1280, height: 800 }, { width: 1280, height: 800 }, 1)!;
    expect(plan.resize).toBe(false);
    expect(plan.move).toBe(false);
    expect(plan.minimum).toEqual({ width: 960, height: 560 });
  });

  it.each([1.25, 1.5, 1.75, 2])('fits a default window at %s display scaling', scale => {
    const work = { x: 0, y: 0, width: 1366, height: 728 };
    const plan = planWindowFit(work, { x: 160, y: 80, width: 1280 * scale, height: 800 * scale },
      { width: 1280 * scale, height: 800 * scale }, scale)!;
    expect(plan.resize).toBe(true);
    expect(plan.position.x + plan.size.width).toBeLessThanOrEqual(work.width);
    expect(plan.position.y + plan.size.height).toBeLessThanOrEqual(work.height);
    expect(plan.minimum.width * scale).toBeLessThanOrEqual(plan.size.width);
    expect(plan.minimum.height * scale).toBeLessThanOrEqual(plan.size.height);
  });

  it('accounts for native frame extents and a taskbar above the work area', () => {
    const work = { x: -1920, y: 48, width: 1920, height: 1032 };
    const plan = planWindowFit(work, { x: -2000, y: 0, width: 2000, height: 1200 },
      { width: 1984, height: 1161 }, 1.5)!;
    expect(plan.position).toEqual({ x: -1920, y: 48 });
    expect(plan.position.x + plan.size.width + 16).toBeLessThanOrEqual(0);
    expect(plan.position.y + plan.size.height + 39).toBeLessThanOrEqual(1080);
  });

  it('does not enlarge a smaller window on a large monitor', () => {
    const plan = planWindowFit({ x: 0, y: 0, width: 3840, height: 2080 },
      { x: 100, y: 100, width: 1000, height: 600 }, { width: 1000, height: 600 }, 1)!;
    expect(plan.size).toEqual({ width: 1000, height: 600 });
    expect(plan.resize).toBe(false);
  });

  it('does not let a new minimum enlarge an existing small window on a high-DPI monitor', () => {
    const plan = planWindowFit({ x: 0, y: 0, width: 3840, height: 2080 },
      { x: 100, y: 100, width: 1000, height: 600 }, { width: 1000, height: 600 }, 2)!;
    expect(plan.resize).toBe(false);
    expect(plan.minimum).toEqual({ width: 500, height: 300 });
    expect(plan.position).toEqual({ x: 100, y: 100 });
  });

  it('ignores a transient unavailable work area', () => {
    expect(planWindowFit({ x: 0, y: 0, width: 0, height: 0 },
      { x: 0, y: 0, width: 1280, height: 800 }, { width: 1280, height: 800 }, 1)).toBeNull();
  });
});

describe('native startup fitting', () => {
  function desktop(maximizeWhileReading = false) {
    vi.stubGlobal('window', {});
    const capability = JSON.parse(readFileSync(new URL('../../../src-tauri/capabilities/default.json', import.meta.url), 'utf8'));
    const changes: string[] = [];
    let maximizedReads = 0;
    mockIPC(command => {
      switch (command) {
        case 'plugin:window|current_monitor': return {
          name: 'scaled screen', scaleFactor: 1.5,
          size: { width: 1366, height: 768 }, position: { x: 0, y: 0 },
          workArea: { position: { x: 0, y: 0 }, size: { width: 1366, height: 728 } },
        };
        case 'plugin:window|is_maximized': return maximizeWhileReading && ++maximizedReads > 1;
        case 'plugin:window|inner_size': case 'plugin:window|outer_size': return { width: 1920, height: 1200 };
        case 'plugin:window|outer_position': return { x: 100, y: 100 };
        default: {
          const permission = `core:window:allow-${command.split('|')[1].replace(/_/g, '-')}`;
          if (!capability.permissions.includes(permission)) throw new Error(`Missing ${permission}`);
          changes.push(command);
        }
      }
    });
    mockWindows('main');
    return { appWindow: getCurrentWindow(), changes };
  }

  it('can run all fitting commands through the real SDK with the main window permissions', async () => {
    const env = desktop();
    await fitMainWindowToMonitor(env.appWindow);
    expect(env.changes).toEqual(['plugin:window|set_min_size', 'plugin:window|set_size', 'plugin:window|set_position']);
  });

  it('leaves a window alone if the user maximizes it while its geometry is being read', async () => {
    const env = desktop(true);
    await fitMainWindowToMonitor(env.appWindow);
    expect(env.changes).toEqual([]);
  });
});
