import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import { nextTick } from 'vue';
import { effectivePlatterMargin, useConfigStore } from '../../stores/config';
import type { PanelVariant } from '../gerber/panel';

let pinia: ReturnType<typeof createPinia>;
beforeEach(() => { pinia = createPinia(); setActivePinia(pinia); });
afterEach(() => disposePinia(pinia));

function variant(size: number, centerX = 0): PanelVariant {
  const half = size / 2;
  return { width: size, height: size, center: { x: centerX, y: 0 },
    outlinePoints: [[-half, -half], [half, -half], [half, half], [-half, half]],
    outlineHoles: [], topPads: [], bottomPads: [] };
}

function importBoard(store: ReturnType<typeof useConfigStore>, size: number) {
  const board = variant(size);
  store.applyGerberImport({ filename: `board-${size}.zip`, isPanel: false, hasPads: false,
    mode: 'panel', variants: { panel: board, single: board } });
}

async function prepareHistory(action: 'undo' | 'redo', panel: boolean) {
  const store = useConfigStore();
  if (panel) {
    const first = variant(40, -170), second = variant(300, 30);
    store.applyGerberImport({ filename: 'mixed-panel.zip', isPanel: true, hasPads: false,
      mode: 'board', boardIndex: 0,
      variants: { panel: variant(400), single: first, boards: [first, second] } });
  } else importBoard(store, 40);
  await nextTick();
  store.config.stencilSizeX = 150;
  await nextTick();
  if (action === 'redo') await store.undo();
  return store;
}

describe('board selection during parameter history replay', () => {
  it.each(['undo', 'redo'] as const)('settles a completed import during %s without keeping old derived dimensions', async action => {
    const store = await prepareHistory(action, false);
    const historyAction = store[action]();
    // History applies its snapshot before this continuation, but its nextTick
    // has not yet released the linkage guard. A pending import can finish here.
    await nextTick();
    importBoard(store, 300);
    await historyAction;
    await nextTick();

    expect(store.config.pcbSizeX).toBe(300);
    expect(store.config.pcbSizeY).toBe(300);
    expect(store.config.stencilSizeX).toBe(320);
    expect(store.config.stencilSizeY).toBe(320);
    expect(store.config.stencilLip).toBe(5.9);
    expect(store.config.platterMargin).toBeCloseTo(3.9);
    expect(store.config.platterMargin).toBe(effectivePlatterMargin(store.config));
    expect(store.config.jigSize).toBe(350);
    expect(store.canUndo).toBe(false);
    expect(store.canRedo).toBe(false);
  });

  it.each(['undo', 'redo'] as const)('settles a different child board selected during %s without restoring the previous scope', async action => {
    const store = await prepareHistory(action, true);
    const historyAction = store[action]();
    await nextTick();
    store.setPanelBoard(1);
    await historyAction;
    await nextTick();

    expect(store.config.panelBoardIndex).toBe(1);
    expect(store.config.pcbSizeX).toBe(300);
    expect(store.config.pcbSizeY).toBe(300);
    expect(store.config.stencilSizeX).toBe(320);
    expect(store.config.stencilSizeY).toBe(320);
    expect(store.config.stencilLip).toBe(5.9);
    expect(store.config.platterMargin).toBeCloseTo(3.9);
    expect(store.config.platterMargin).toBe(effectivePlatterMargin(store.config));
    expect(store.config.jigSize).toBe(350);
    expect(store.canUndo).toBe(false);
    expect(store.canRedo).toBe(false);
  });
});
