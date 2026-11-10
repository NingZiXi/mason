import { afterEach, describe, expect, it, vi } from 'vitest';
import { nextTick, reactive } from 'vue';
import type { Skin } from '../../stores/ui';
import { watchDesktopSkinIcon } from '../desktop-icon';
import { invoke } from '@tauri-apps/api/core';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async () => ({ windowsUpdated: 1, shortcutsUpdated: 0, shortcutsSkipped: 0 })),
  isTauri: () => true,
}));

const stops: Array<() => void> = [];
afterEach(() => {
  stops.splice(0).forEach(stop => stop());
  vi.clearAllMocks();
});

function state(skin: Skin = 'classic') {
  return reactive({ skin, skinCelebrationActive: false });
}

async function settle() {
  await nextTick();
  await Promise.resolve();
}

describe('skin-following desktop icons', () => {
  it('calls the registered native command with the persisted skin', async () => {
    stops.push(watchDesktopSkinIcon(state('sakura')));
    await settle();
    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledWith('set_skin_icon', { skin: 'sakura' });
  });
  it.each(['classic', 'sakura'] as const)('restores the saved %s icon on startup', async skin => {
    const writeIcon = vi.fn(async (_skin: Skin) => {});
    stops.push(watchDesktopSkinIcon(state(skin), { native: true, writeIcon }));
    await settle();
    expect(writeIcon).toHaveBeenCalledOnce();
    expect(writeIcon).toHaveBeenCalledWith(skin);
  });

  it('does not invoke the native shell in browser previews', async () => {
    const ui = state();
    const writeIcon = vi.fn(async (_skin: Skin) => {});
    stops.push(watchDesktopSkinIcon(ui, { native: false, writeIcon }));
    ui.skin = 'sakura';
    await settle();
    expect(writeIcon).not.toHaveBeenCalled();
  });

  it('updates after a settings switch and skips an unchanged destination', async () => {
    const ui = state();
    const writeIcon = vi.fn(async (_skin: Skin) => {});
    stops.push(watchDesktopSkinIcon(ui, { native: true, writeIcon }));
    await settle();
    ui.skin = 'sakura';
    await settle();
    ui.skinCelebrationActive = true;
    await settle();
    ui.skinCelebrationActive = false;
    await settle();
    expect(writeIcon.mock.calls.map(([skin]) => skin)).toEqual(['classic', 'sakura']);
  });

  it('waits for the celebration to finish instead of switching at snapshot capture', async () => {
    const ui = state();
    const writeIcon = vi.fn(async (_skin: Skin) => {});
    stops.push(watchDesktopSkinIcon(ui, { native: true, writeIcon }));
    await settle();
    ui.skinCelebrationActive = true;
    ui.skin = 'sakura';
    await settle();
    expect(writeIcon.mock.calls.map(([skin]) => skin)).toEqual(['classic']);
    ui.skinCelebrationActive = false;
    await settle();
    expect(writeIcon.mock.calls.map(([skin]) => skin)).toEqual(['classic', 'sakura']);
  });

  it('keeps the old icon when the celebration is aborted', async () => {
    const ui = state();
    const writeIcon = vi.fn(async (_skin: Skin) => {});
    stops.push(watchDesktopSkinIcon(ui, { native: true, writeIcon }));
    await settle();
    ui.skinCelebrationActive = true;
    ui.skin = 'sakura';
    await settle();
    ui.skin = 'classic';
    ui.skinCelebrationActive = false;
    await settle();
    expect(writeIcon).toHaveBeenCalledOnce();
    expect(writeIcon).toHaveBeenCalledWith('classic');
  });

  it('serializes slow shell writes and applies only the latest queued destination', async () => {
    const ui = state('sakura');
    const completions: Array<() => void> = [];
    const writeIcon = vi.fn((_skin: Skin) => new Promise<void>(resolve => completions.push(resolve)));
    stops.push(watchDesktopSkinIcon(ui, { native: true, writeIcon }));
    ui.skin = 'classic';
    await settle();
    ui.skin = 'sakura';
    await settle();
    ui.skin = 'classic';
    await settle();
    expect(writeIcon).toHaveBeenCalledOnce();
    expect(writeIcon).toHaveBeenCalledWith('sakura');
    completions.shift()!();
    await settle();
    expect(writeIcon.mock.calls.map(([skin]) => skin)).toEqual(['sakura', 'classic']);
    completions.shift()!();
    await settle();
  });

  it('reports a shell failure without looping and permits a later retry', async () => {
    const ui = state();
    const failure = new Error('shortcut is locked');
    const writeIcon = vi.fn(async (_skin: Skin) => {}).mockRejectedValueOnce(failure);
    const onError = vi.fn();
    stops.push(watchDesktopSkinIcon(ui, { native: true, writeIcon, onError }));
    await settle();
    expect(writeIcon).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(failure);
    ui.skinCelebrationActive = true;
    await settle();
    ui.skinCelebrationActive = false;
    await settle();
    expect(writeIcon.mock.calls.map(([skin]) => skin)).toEqual(['classic', 'classic']);
  });

  it('continues with the latest skin when an in-flight write fails', async () => {
    const ui = state();
    let rejectFirst!: (error: unknown) => void;
    const writeIcon = vi.fn(async (_skin: Skin) => {})
      .mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectFirst = reject; }));
    const onError = vi.fn();
    stops.push(watchDesktopSkinIcon(ui, { native: true, writeIcon, onError }));
    ui.skin = 'sakura';
    await settle();
    rejectFirst(new Error('failed'));
    await settle();
    expect(onError).toHaveBeenCalledOnce();
    expect(writeIcon.mock.calls.map(([skin]) => skin)).toEqual(['classic', 'sakura']);
  });

  it('reapplies the old skin if a failed write may have partially changed the native icon', async () => {
    const ui = state();
    let rejectPink!: (error: unknown) => void;
    const writeIcon = vi.fn(async (_skin: Skin) => {});
    stops.push(watchDesktopSkinIcon(ui, { native: true, writeIcon, onError: vi.fn() }));
    await settle();
    writeIcon.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectPink = reject; }));
    ui.skin = 'sakura';
    await settle();
    ui.skin = 'classic';
    await settle();
    rejectPink(new Error('partial native update'));
    await settle();
    expect(writeIcon.mock.calls.map(([skin]) => skin)).toEqual(['classic', 'sakura', 'classic']);
  });

  it('stops queued writes after the owning app is unmounted', async () => {
    const ui = state();
    let complete!: () => void;
    const writeIcon = vi.fn((_skin: Skin) => new Promise<void>(resolve => { complete = resolve; }));
    const stop = watchDesktopSkinIcon(ui, { native: true, writeIcon });
    stops.push(stop);
    ui.skin = 'sakura';
    await settle();
    stop();
    complete();
    await settle();
    ui.skin = 'classic';
    await settle();
    expect(writeIcon).toHaveBeenCalledOnce();
    expect(writeIcon).toHaveBeenCalledWith('classic');
  });
});
