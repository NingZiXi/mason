import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, ref, watch } from 'vue';
import { readFileSync } from 'node:fs';
import { createSourceFile, isArrowFunction, isCallExpression, isExpressionStatement, isFunctionDeclaration,
  isIdentifier, ScriptKind, ScriptTarget, transpileModule } from 'typescript';
import { GenerationTasks, isGenerationCancelled } from '../generation-tasks';

// Exercise the actual debounce, render pipeline and transition watchers while
// holding engine replies open. No WebGL or desktop interaction is needed.
const source = readFileSync(new URL('../../components/ModelPreview.vue', import.meta.url), 'utf8');
const script = source.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)![1];
const syntax = createSourceFile('ModelPreview.ts', script, ScriptTarget.Latest, true, ScriptKind.TS);
const names = new Set(['renderCurrent', 'scheduleRender', 'ensurePart', 'cancelPreviewTasks', 'canCacheResult']);
const functions = syntax.statements.filter(node => isFunctionDeclaration(node) && names.has(node.name?.text ?? ''));
const transition = (name: string) => syntax.statements.find(statement => isExpressionStatement(statement)
  && isCallExpression(statement.expression) && isIdentifier(statement.expression.expression)
  && statement.expression.expression.text === 'watch'
  && isIdentifier(statement.expression.arguments[0]) && statement.expression.arguments[0].text === name
  && isArrowFunction(statement.expression.arguments[1]));
const activeWatcher = transition('activePart'), inspectionWatcher = transition('inspectionOpen');
if (functions.length !== names.size || !activeWatcher || !inspectionWatcher) throw new Error('A preview scheduler path is missing');
const javascript = transpileModule([
  ...functions.map(node => node.getText(syntax)), activeWatcher.getText(syntax), inspectionWatcher.getText(syntax),
].join('\n'), { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText;

interface Request {
  args: Record<string, unknown>;
  resolve: (value: ArrayBuffer) => void;
  reject: (error: Error) => void;
}
const stops: Array<() => void> = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => { stops.splice(0).forEach(stop => stop()); vi.useRealTimers(); });

function setup() {
  const requests: Request[] = [];
  const invoke = vi.fn((command: string, args?: Record<string, unknown>) => command === 'cancel_generation'
    ? Promise.resolve()
    : new Promise<ArrayBuffer>((resolve, reject) => requests.push({ args: args!, resolve, reject })));
  const tasks = new GenerationTasks(invoke as <T>(command: string, args?: Record<string, unknown>) => Promise<T>);
  const activePart = ref('insert'), inspectionOpen = ref(false);
  const localStops: Array<() => void> = [];
  const create = new Function('generationTasks', 'isGenerationCancelled', 'activePart', 'inspectionOpen', 'watch', 'window', `
    let disposed = false, renderSeq = 0, cacheGeneration = 0, renderTimer = null, preloadTimer = null, metricsTimer = null;
    let revision = 1;
    const scene = { value: {} }, store = { pythonDetected: true, gerberImporting: false }, hasData = { value: true };
    const loading = { value: false }, errorMsg = { value: null }, inspectionLoaded = { value: false };
    const pendingParts = new Map(), stlCache = { value: {} }, currentMesh = { value: null }, currentAssembly = { value: null };
    const printMetrics = { invalidate() {} }, PART_TO_RUST = { insert: 'insert', base: 'base', cover: 'top_cover' };
    let currentMeshPart = null;
    const paramsHash = () => String(revision), buildScadParams = () => ({ revision });
    const partHash = (part, params = buildScadParams()) => part + ':' + params.revision;
    const cachePart = (part, bytes, paramsHash) => { stlCache.value[part] = { bytes, paramsHash }; };
    const getOrParseGeometry = (_part, bytes) => bytes;
    const applyStlToMesh = geometry => { currentMesh.value = { geometry }; currentMeshPart = activePart.value; };
    const applyAssembly = () => { currentAssembly.value = {}; };
    const t = key => key, disposeMesh = () => {}, schedulePreload = () => {}, scheduleMetrics = () => {};
    const cancelCameraMotion = () => {}, resetRefresh = () => {}, setMeasureMode = () => {};
    const onCanvasPointerLeave = () => {}, onResize = () => {};
    ${javascript}
    return { render: renderCurrent, schedule: scheduleRender,
      edit: value => { revision = value; ++renderSeq; cancelPreviewTasks(['preview']); scheduleRender(); },
      inspect: () => ({ loading: loading.value, error: errorMsg.value, part: currentMeshPart, timer: renderTimer,
        geometry: currentMesh.value?.geometry, pending: pendingParts.size }) };
  `);
  const harness = create(tasks, isGenerationCancelled, activePart, inspectionOpen,
    (...args: Parameters<typeof watch>) => { const stop = watch(...args); localStops.push(stop); return stop; },
    { setTimeout, clearTimeout }) as {
    render: (force?: boolean) => Promise<boolean>;
    schedule: () => void;
    edit: (revision: number) => void;
    inspect: () => { loading: boolean; error: string | null; part: string | null; timer: unknown; geometry?: ArrayBuffer; pending: number };
  };
  stops.push(() => localStops.forEach(stop => stop()));
  return { ...harness, requests, invoke, activePart, inspectionOpen,
    flush: () => vi.advanceTimersByTimeAsync(0),
    cancellations: () => invoke.mock.calls.filter(([command]) => command === 'cancel_generation') };
}

describe('immediate preview render consumes queued debounce', () => {
  it('keeps a part switch running instead of restarting it at the old parameter deadline', async () => {
    const state = setup();
    state.schedule();
    state.activePart.value = 'base';
    await nextTick();
    expect(state.requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(350);
    expect(state.requests).toHaveLength(1);
    expect(state.cancellations()).toHaveLength(0);
    const geometry = new ArrayBuffer(10);
    state.requests[0].resolve(geometry);
    await state.flush();
    expect(state.inspect()).toMatchObject({ loading: false, part: 'base', geometry, pending: 0, timer: null });
  });

  it('consumes a parameter debounce queued before the return-to-3D watcher runs', async () => {
    const state = setup();
    state.inspectionOpen.value = true;
    await nextTick();
    state.inspectionOpen.value = false;
    state.edit(2);
    await nextTick();
    expect(state.requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(350);
    expect(state.requests).toHaveLength(1);
    expect(state.cancellations()).toHaveLength(0);
    state.requests[0].resolve(new ArrayBuffer(10));
    await state.flush();
    expect(state.inspect()).toMatchObject({ loading: false, part: 'insert', pending: 0, timer: null });
  });

  it('still schedules a later parameter change and rejects the older reply', async () => {
    const state = setup();
    state.schedule();
    state.activePart.value = 'base';
    await nextTick();
    state.edit(2);
    await vi.advanceTimersByTimeAsync(299);
    expect(state.requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(state.requests).toHaveLength(2);
    const fresh = new ArrayBuffer(20);
    state.requests[1].resolve(fresh);
    await state.flush();
    state.requests[0].resolve(new ArrayBuffer(10));
    await state.flush();
    expect(state.inspect()).toMatchObject({ loading: false, part: 'base', geometry: fresh, pending: 0, timer: null });
  });

  it('consumes a queued debounce on retry and reports only the current request outcome', async () => {
    const state = setup();
    const first = state.render();
    state.requests[0].reject(new Error('CAD failed'));
    expect(await first).toBe(false);
    expect(state.inspect()).toMatchObject({ loading: false, error: 'preview.renderFailed' });
    state.schedule();
    const retry = state.render();
    expect(state.inspect()).toMatchObject({ loading: true, error: null });
    await vi.advanceTimersByTimeAsync(350);
    expect(state.requests).toHaveLength(2);
    expect(state.cancellations()).toHaveLength(0);
    state.requests[1].resolve(new ArrayBuffer(20));
    expect(await retry).toBe(true);
    expect(state.inspect()).toMatchObject({ loading: false, error: null, part: 'insert', pending: 0, timer: null });
  });
});
