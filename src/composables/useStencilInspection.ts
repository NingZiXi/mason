import { ref, shallowRef, watch, onScopeDispose, type Ref } from 'vue';
import type { StencilInspection } from '../lib/stencil-inspection';
import { isGenerationCancelled } from '../lib/generation-tasks';

export interface InspectionRequest<P> { key: string; part: string; params: P }

/** Only request the engine while visible. Coalesce synchronous batch edits
 * before serializing geometry or invalidating the previous engine request. */
export function useStencilInspection<P>(
  active: Ref<boolean>, request: Ref<InspectionRequest<P> | null>,
  fetch: (request: InspectionRequest<P>, signal: AbortSignal) => Promise<StencilInspection>,
) {
  const data = shallowRef<StencilInspection | null>(null);
  const resolvedKey = ref('');
  const loading = ref(false);
  const error = ref('');
  const cache = new Map<string, StencilInspection>();
  let revision = 0;
  let controller: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function load() {
    if (!active.value || !request.value) return;
    const snapshot = request.value;
    const token = ++revision;
    controller?.abort();
    controller = new AbortController();
    const signal = controller.signal;
    error.value = ''; loading.value = true;
    try {
      const result = cache.get(snapshot.key) ?? await fetch(snapshot, signal);
      if (token !== revision || signal.aborted || !active.value || snapshot.key !== request.value?.key) return;
      cache.delete(snapshot.key); cache.set(snapshot.key, result);
      while (cache.size > 4) cache.delete(cache.keys().next().value!);
      data.value = result;
      resolvedKey.value = snapshot.key;
    } catch (e) {
      if (token === revision && !signal.aborted && !isGenerationCancelled(e)) error.value = String(e);
    } finally {
      if (token === revision) loading.value = false;
    }
  }

  function invalidate() {
    revision++; controller?.abort(); controller = null;
    clearTimeout(timer); data.value = null; resolvedKey.value = ''; error.value = ''; loading.value = false;
  }
  watch([active, () => request.value?.key], () => {
    invalidate();
    if (active.value && request.value) {
      loading.value = true;
      timer = setTimeout(() => void load(), 180);
    }
  }, { immediate: true });
  onScopeDispose(() => { invalidate(); cache.clear(); });
  return { data, resolvedKey, loading, error, retry: load };
}
