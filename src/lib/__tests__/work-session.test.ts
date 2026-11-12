import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import { nextTick } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { useConfigStore } from '../../stores/config';
import { useWorkSessionStore } from '../../stores/work-session';
import type { PadPolygon } from '../gerber/pads';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
let pinia: ReturnType<typeof createPinia>;
beforeEach(() => { pinia = createPinia(); setActivePinia(pinia); vi.clearAllMocks(); });
afterEach(() => disposePinia(pinia));

async function setup() {
  const session = useWorkSessionStore(), config = useConfigStore();
  await session.initialize();
  return { session, config };
}

function importBoard() {
  const variant = { width: 30, height: 20, center: { x: 15, y: 10 },
    outlinePoints: [[-15, -10], [15, -10], [15, 10], [-15, 10]] as Array<[number, number]>, outlineHoles: [] };
  useConfigStore().applyGerberImport({ filename: 'board.zip', isPanel: false, hasPads: false,
    mode: 'panel', variants: { panel: variant, single: variant } });
}

describe('session-only unexported work reminder', () => {
  it('exits fresh startup without prompting or reading/writing drafts', async () => {
    const { session } = await setup();
    const prompt = vi.fn();
    expect(await session.confirmExit(prompt)).toBe(true);
    expect(prompt).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('waits for the startup preset before establishing the clean baseline', async () => {
    const session = useWorkSessionStore(), config = useConfigStore();
    let finish!: () => void;
    const initialization = session.initialize(new Promise<void>(resolve => { finish = resolve; }));
    config.config.postClearance = .3;
    finish(); await initialization;
    expect(session.hasUnexportedChanges).toBe(false);
    config.config.postClearance = .35;
    expect(session.hasUnexportedChanges).toBe(true);
  });

  it('does not treat choosing a mode on the empty welcome screen as an edit', async () => {
    const { session, config } = await setup();
    config.setMode('stencil'); await nextTick();
    expect(session.hasUnexportedChanges).toBe(false);
  });

  it('prompts after an import and keeps work dirty when exit is cancelled', async () => {
    const { session } = await setup(); importBoard(); await nextTick();
    const prompt = vi.fn(async () => false);
    expect(await session.confirmExit(prompt)).toBe(false);
    expect(prompt).toHaveBeenCalledOnce();
    expect(session.hasUnexportedChanges).toBe(true);
  });

  it('asks again after cancellation and allows explicit exit', async () => {
    const { session, config } = await setup(); config.config.postClearance = .3;
    expect(await session.confirmExit(async () => false)).toBe(false);
    expect(await session.confirmExit(async () => true)).toBe(true);
  });

  it('only marks the successfully exported snapshot clean; new edits need another export', async () => {
    const { session, config } = await setup(); importBoard(); await nextTick();
    session.markExported(session.captureExport());
    expect(session.hasUnexportedChanges).toBe(false);
    config.config.postClearance = .3; await nextTick();
    expect(session.hasUnexportedChanges).toBe(true);
    session.markExported(session.captureExport());
    const prompt = vi.fn();
    expect(await session.confirmExit(prompt)).toBe(true);
    expect(prompt).not.toHaveBeenCalled();
  });

  it('does not clear edits made while files for an earlier snapshot are being exported', async () => {
    const { session, config } = await setup();
    config.config.postClearance = .3;
    const snapshot = session.captureExport();
    config.config.postClearance = .35;
    session.markExported(snapshot);
    expect(session.hasUnexportedChanges).toBe(true);
  });

  it('keeps failed or cancelled exports dirty until a success is acknowledged', async () => {
    const { session, config } = await setup(); config.config.postClearance = .3;
    session.captureExport();
    expect(session.hasUnexportedChanges).toBe(true);
  });

  it('recognizes undoing parameter changes back to the exported values', async () => {
    const { session, config } = await setup();
    config.config.postClearance = .3; await nextTick();
    session.markExported(session.captureExport());
    config.beginParameterInteraction();
    config.config.postClearance = .35; await nextTick();
    config.endParameterInteraction();
    expect(session.hasUnexportedChanges).toBe(true);
    await config.undo();
    expect(session.hasUnexportedChanges).toBe(false);
    await config.redo();
    expect(session.hasUnexportedChanges).toBe(true);
  });

  it('tracks in-place aperture decisions on either side and notch-array edits', async () => {
    const { session, config } = await setup();
    const pad: PadPolygon = { type: 'rect', polarity: 'D', cx: 0, cy: 0,
      parts: [{ polarity: 'D', points: [[0, 0], [1, 0], [1, 1]] }] };
    config.config.stencilPadsTop = [structuredClone(pad)];
    config.config.stencilPadsBottom = [structuredClone(pad)];
    await nextTick(); session.markExported(session.captureExport());
    config.setApertureOverride('top', 0, 'closed');
    expect(session.hasUnexportedChanges).toBe(true);
    session.markExported(session.captureExport());
    config.setApertureOverride('bottom', 0, 'open');
    expect(session.hasUnexportedChanges).toBe(true);
    session.markExported(session.captureExport());
    config.config.pryNotchSides.push('left');
    expect(session.hasUnexportedChanges).toBe(true);
  });

  it('recognizes the same exported notch edges after toggling an edge off and on', async () => {
    const { session, config } = await setup();
    config.config.pryNotchSides = ['down', 'left'];
    await nextTick(); session.markExported(session.captureExport());
    config.config.pryNotchSides = ['left'];
    expect(session.hasUnexportedChanges).toBe(true);
    config.config.pryNotchSides.push('down');
    expect(session.hasUnexportedChanges).toBe(false);
    const prompt = vi.fn();
    expect(await session.confirmExit(prompt)).toBe(true);
    expect(prompt).not.toHaveBeenCalled();
  });

  it('coalesces repeated close requests into one dialog', async () => {
    const { session, config } = await setup(); config.config.postClearance = .3;
    let finish!: (value: boolean) => void;
    const prompt = vi.fn(() => new Promise<boolean>(resolve => { finish = resolve; }));
    const first = session.confirmExit(prompt), second = session.confirmExit(prompt);
    await nextTick(); await nextTick();
    expect(prompt).toHaveBeenCalledOnce();
    finish(false);
    expect(await first).toBe(false);
    expect(await second).toBe(false);
  });

  it('blocks closing during export even if the user confirms a prompt', async () => {
    const { session, config } = await setup(); config.config.postClearance = .3;
    session.exporting = true;
    const prompt = vi.fn(async () => true);
    expect(await session.confirmExit(prompt)).toBe(false);
    expect(prompt).not.toHaveBeenCalled();
    session.exporting = false;
    expect(await session.confirmExit(prompt)).toBe(true);
  });

  it('does not traverse Gerber vertex coordinates for every parameter change', async () => {
    const { session, config } = await setup();
    const vertex = vi.fn(() => 0);
    const point: [number, number] = [0, 0];
    Object.defineProperty(point, '0', { get: vertex });
    config.config.pcbOutlinePoints = [point, [10, 0], [10, 10]];
    await nextTick(); session.markExported(session.captureExport()); vertex.mockClear();
    config.config.postClearance = .3;
    expect(session.hasUnexportedChanges).toBe(true);
    expect(vertex).not.toHaveBeenCalled();
  });

  it('reuses cached relief plans for scalar edits while detecting in-place vertex changes', async () => {
    const { session, config } = await setup();
    let coordinate = -5;
    const vertex = vi.fn(() => coordinate);
    const point: [number, number] = [-5, -5];
    Object.defineProperty(point, '0', { get: vertex, set: value => { coordinate = value; }, enumerable: true });
    config.config.componentReliefRegions.top = [{ id: 'pocket', shape: 'polygon', x: 0, y: 0, width: 10, height: 10,
      depth: 3, points: [point, [5, -5], [5, 5], [-5, 5]] }];
    await nextTick(); session.markExported(session.captureExport()); vertex.mockClear();

    // Read before history's post-flush snapshot: this specifically measures
    // the exit reminder rather than the independent history recorder.
    config.config.postClearance = .3;
    expect(session.hasUnexportedChanges).toBe(true);
    session.captureExport();
    config.config.postClearance = .35;
    session.captureExport();
    expect(vertex).not.toHaveBeenCalled();

    session.markExported(session.captureExport());
    config.config.componentReliefRegions.top[0].points![0][0] = -4;
    expect(session.hasUnexportedChanges).toBe(true);
    expect(vertex).toHaveBeenCalled();
    session.markExported(session.captureExport());
    expect(session.hasUnexportedChanges).toBe(false);
  });

  it('restores the exported relief-plan state after undo and marks redo as edited', async () => {
    const { session, config } = await setup();
    config.config.componentReliefRegions = { top: [{ id: 'top', shape: 'rect', x: 0, y: 0, width: 5, height: 5, depth: 3 }],
      bottom: [{ id: 'bottom', shape: 'rect', x: 0, y: 0, width: 4, height: 4, depth: 2 }] };
    await nextTick(); session.markExported(session.captureExport()); config.clearParameterHistory();
    config.config.componentReliefRegions.bottom[0].depth = 4;
    await nextTick();
    expect(session.hasUnexportedChanges).toBe(true);
    await config.undo();
    expect(session.hasUnexportedChanges).toBe(false);
    await config.redo();
    expect(session.hasUnexportedChanges).toBe(true);
  });
});
