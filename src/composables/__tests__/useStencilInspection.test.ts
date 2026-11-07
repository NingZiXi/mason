import { afterEach, describe, expect, it, vi } from 'vitest';
import { computed, effectScope, nextTick, ref, shallowRef } from 'vue';
import { useStencilInspection, type InspectionRequest } from '../useStencilInspection';
import type { StencilInspection } from '../../lib/stencil-inspection';

const result = (n: number): StencilInspection => ({ side: 'top', mirrored: true, outline: [], original: [], openings: [], filtered: [], pads: [],
  summary: { sourcePads: n, filteredPads: 0, openings: n, invalidPads: 0 } });
const snapshot = (key: string): InspectionRequest<{}> => ({ key, part: 'stencil_top', params: {} });
const scopes: ReturnType<typeof effectScope>[] = [];
afterEach(() => { scopes.splice(0).forEach(scope => scope.stop()); vi.useRealTimers(); });
function setup(fetch: (request: InspectionRequest<{}>, signal: AbortSignal) => Promise<StencilInspection>) {
  const active = ref(false), request = shallowRef<InspectionRequest<{}> | null>(snapshot('one'));
  const scope = effectScope(); scopes.push(scope);
  const state = scope.run(() => useStencilInspection(active, request, fetch))!;
  return { active, request, ...state };
}

describe('inspection request lifetime', () => {
  it('is lazy and reuses an unchanged result after reopening', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async () => result(1));
    const state = setup(fetch);
    await vi.advanceTimersByTimeAsync(200);
    expect(fetch).not.toHaveBeenCalled();
    state.active.value = true;
    await vi.advanceTimersByTimeAsync(200);
    expect(state.data.value?.summary.openings).toBe(1);
    state.active.value = false;
    state.active.value = true;
    await vi.advanceTimersByTimeAsync(200);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('invalidates stale results before rendering and ignores superseded replies', async () => {
    vi.useFakeTimers();
    let resolveOld!: (value: StencilInspection) => void;
    let oldSignal: AbortSignal | undefined;
    const state = setup((request, signal) => {
      if (request.key === 'one') { oldSignal = signal; return new Promise(resolve => { resolveOld = resolve; }); }
      return Promise.resolve(result(2));
    });
    state.active.value = true;
    await vi.advanceTimersByTimeAsync(200);
    state.request.value = snapshot('two');
    await nextTick();
    expect(oldSignal?.aborted).toBe(true);
    expect(state.data.value).toBeNull();
    await vi.advanceTimersByTimeAsync(200);
    resolveOld(result(1));
    await Promise.resolve();
    expect(state.data.value?.summary.openings).toBe(2);
    state.request.value = snapshot('three');
    await nextTick();
    expect(state.data.value).toBeNull();
  });
  it('reports errors, allows retry, and cancels queued work on close', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const fetch = vi.fn(async (_request: InspectionRequest<{}>, s: AbortSignal): Promise<StencilInspection> => { signal = s; throw new Error('engine failed'); });
    const state = setup(fetch);
    state.active.value = true;
    await vi.advanceTimersByTimeAsync(200);
    expect(state.error.value).toContain('engine failed');
    fetch.mockImplementationOnce(async () => result(4));
    await state.retry();
    expect(state.error.value).toBe('');
    expect(state.data.value?.summary.openings).toBe(4);
    state.request.value = snapshot('new');
    await vi.advanceTimersByTimeAsync(200);
    state.active.value = false;
    await nextTick();
    expect(signal?.aborted).toBe(true);
    expect(state.loading.value).toBe(false);
  });

  it('serializes a synchronous batch once and sends only the final request', async () => {
    vi.useFakeTimers();
    const scope = effectScope(); scopes.push(scope);
    const revision = ref(0), active = ref(true);
    const serialize = vi.fn((n: number) => snapshot(`batch-${n}`));
    const request = computed(() => serialize(revision.value));
    const fetch = vi.fn(async (_request: InspectionRequest<{}>, _signal: AbortSignal) => result(revision.value));
    const state = scope.run(() => useStencilInspection(active, request, fetch))!;
    await vi.advanceTimersByTimeAsync(200);
    serialize.mockClear(); fetch.mockClear();
    for (let i = 1; i <= 500; i++) revision.value = i;
    await nextTick();
    expect(serialize).toHaveBeenCalledTimes(1);
    expect(state.data.value).toBeNull();
    await vi.advanceTimersByTimeAsync(200);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[0]?.key).toBe('batch-500');
    expect(state.data.value?.summary.openings).toBe(500);
  });
});
