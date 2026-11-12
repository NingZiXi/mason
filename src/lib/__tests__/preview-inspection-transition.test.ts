import { afterEach, describe, expect, it, vi } from 'vitest';
import { nextTick, ref, watch } from 'vue';
import { readFileSync } from 'node:fs';
import { createSourceFile, isArrowFunction, isCallExpression, isExpressionStatement, isFunctionDeclaration,
  isIdentifier, ScriptKind, ScriptTarget, transpileModule } from 'typescript';
import { GenerationTasks, isGenerationCancelled } from '../generation-tasks';

// Exercise the actual post-flush 2D watcher and its task ownership wrapper.
const source = readFileSync(new URL('../../components/ModelPreview.vue', import.meta.url), 'utf8');
const script = source.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)![1];
const syntax = createSourceFile('ModelPreview.ts', script, ScriptTarget.Latest, true, ScriptKind.TS);
const transition = syntax.statements.find(statement => isExpressionStatement(statement)
  && isCallExpression(statement.expression) && isIdentifier(statement.expression.expression)
  && statement.expression.expression.text === 'watch'
  && isIdentifier(statement.expression.arguments[0]) && statement.expression.arguments[0].text === 'inspectionOpen'
  && isArrowFunction(statement.expression.arguments[1]));
const cancellation = syntax.statements.find(statement => isFunctionDeclaration(statement)
  && statement.name?.text === 'cancelPreviewTasks');
if (!transition || !isExpressionStatement(transition) || !cancellation) throw new Error('The 2D transition handler is missing');
const javascript = transpileModule(`${cancellation.getText(syntax)}\nconst stop = ${transition.expression.getText(syntax)};`,
  { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText;

const stops: Array<() => void> = [];
afterEach(() => { stops.splice(0).forEach(stop => stop()); });

function setup() {
  const pending = new Map<string, (value: unknown) => void>();
  const invoke = vi.fn((command: string, args?: Record<string, unknown>) => {
    if (command === 'cancel_generation') return Promise.resolve();
    return new Promise(resolve => pending.set(String(args?.requestId ?? 'export'), resolve));
  });
  const typedInvoke = invoke as <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
  const generationTasks = new GenerationTasks(typedInvoke);
  const inspectionTasks = new GenerationTasks(typedInvoke);
  const inspectionOpen = ref(false);
  const clearTimeout = vi.fn();
  const cancelCameraMotion = vi.fn(), onCanvasPointerLeave = vi.fn();
  const onResize = vi.fn(), renderCurrent = vi.fn(async () => true), scheduleMetrics = vi.fn();
  const printMetrics = { invalidate: vi.fn() };
  const create = new Function('watch', 'inspectionOpen', 'generationTasks', 'printMetrics', 'window',
    'cancelCameraMotion', 'onCanvasPointerLeave', 'onResize', 'renderCurrent', 'scheduleMetrics', `
    const inspectionLoaded = { value: false }, loading = { value: true };
    let renderSeq = 4, renderTimer = 1, preloadTimer = 2, metricsTimer = 3;
    const pendingParts = new Map([['old-preview', { kind: 'preview' }], ['old-preload', { kind: 'preload' }]]);
    ${javascript}
    return { stop, inspect: () => ({ loaded: inspectionLoaded.value, loading: loading.value,
      sequence: renderSeq, timers: [renderTimer, preloadTimer, metricsTimer], pending: pendingParts.size }) };
  `);
  const harness = create(watch, inspectionOpen, generationTasks, printMetrics, { clearTimeout },
    cancelCameraMotion, onCanvasPointerLeave, onResize, renderCurrent, scheduleMetrics) as {
    stop: () => void;
    inspect: () => { loaded: boolean; loading: boolean; sequence: number; timers: Array<number | null>; pending: number };
  };
  stops.push(harness.stop);
  return { ...harness, inspectionOpen, generationTasks, inspectionTasks, pending, invoke, typedInvoke,
    clearTimeout, cancelCameraMotion, onCanvasPointerLeave, onResize, renderCurrent, scheduleMetrics, printMetrics };
}

describe('3D to 2D worker handoff', () => {
  it('interrupts foreground generation, preloading and metrics owned by the 3D viewport', async () => {
    const state = setup();
    const jobs = [state.generationTasks.run('generate_stl', {}, 'preview'),
      state.generationTasks.run('generate_stl', {}, 'preload'),
      state.generationTasks.run('part_metrics', {}, 'metrics')].map(job => job.catch(error => error));
    const ids = state.invoke.mock.calls.map(([, args]) => args!.requestId);
    state.inspectionOpen.value = true;
    await nextTick();
    expect(state.invoke).toHaveBeenLastCalledWith('cancel_generation', { requestIds: ids, interrupt: true });
    expect(state.inspect()).toEqual({ loaded: true, loading: false, sequence: 5,
      timers: [null, null, null], pending: 0 });
    expect(state.clearTimeout.mock.calls).toEqual([[1], [2], [3]]);
    expect(state.printMetrics.invalidate).toHaveBeenCalledOnce();
    expect(state.cancelCameraMotion).toHaveBeenCalledOnce();
    expect(state.onCanvasPointerLeave).toHaveBeenCalledOnce();
    expect(state.renderCurrent).not.toHaveBeenCalled();
    state.pending.forEach(resolve => resolve({}));
    expect((await Promise.all(jobs)).every(isGenerationCancelled)).toBe(true);
  });

  it('leaves independently owned 2D inspection and export requests running', async () => {
    const state = setup();
    const old = state.generationTasks.run('generate_stl', {}, 'preview').catch(error => error);
    const inspection = state.inspectionTasks.run('inspect_stencil', {}, 'preview');
    const exported = state.typedInvoke('export_stl', { part: 'base' });
    const oldId = state.invoke.mock.calls[0][1]!.requestId;
    state.inspectionOpen.value = true;
    await nextTick();
    expect(state.invoke).toHaveBeenLastCalledWith('cancel_generation', { requestIds: [oldId], interrupt: true });
    state.pending.forEach(resolve => resolve('complete'));
    expect(isGenerationCancelled(await old)).toBe(true);
    expect(await inspection).toBe('complete');
    expect(await exported).toBe('complete');
  });

  it('renders the current parameters and resumes metrics when returning to 3D', async () => {
    const state = setup();
    state.inspectionOpen.value = true;
    await nextTick();
    state.invoke.mockClear();
    state.inspectionOpen.value = false;
    await nextTick();
    expect(state.onResize).toHaveBeenCalledOnce();
    expect(state.renderCurrent).toHaveBeenCalledOnce();
    expect(state.scheduleMetrics).toHaveBeenCalledOnce();
    expect(state.invoke).not.toHaveBeenCalled();
    expect(state.inspect().sequence).toBe(6);
  });
});
