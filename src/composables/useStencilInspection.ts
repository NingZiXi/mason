import { computed, ref, shallowRef, watch, onScopeDispose, type Ref } from 'vue';
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
  const ready = computed(() => active.value && !!data.value && !!request.value
    && resolvedKey.value === request.value.key && !loading.value && !error.value);
  const cache = new Map<string, StencilInspection>();
  let revision = 0;
  let controller: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function publish(key: string, result: StencilInspection) {
    cache.delete(key); cache.set(key, result);
    while (cache.size > 4) cache.delete(cache.keys().next().value!);
    data.value = result; resolvedKey.value = key;
  }

  async function load() {
    // A manual retry replaces a debounced refresh instead of starting it twice.
    clearTimeout(timer); timer = undefined;
    if (!active.value || !request.value) return;
    const snapshot = request.value;
    const token = ++revision;
    controller?.abort();
    controller = new AbortController();
    const signal = controller.signal;
    error.value = ''; loading.value = true;
    try {
      const result = await fetch(snapshot, signal);
      if (token !== revision || signal.aborted || !active.value || snapshot.key !== request.value?.key) return;
      publish(snapshot.key, result);
    } catch (e) {
      if (token === revision && !signal.aborted && active.value && snapshot.key === request.value?.key
        && !isGenerationCancelled(e)) error.value = String(e);
    } finally {
      if (token === revision) loading.value = false;
    }
  }

  function invalidate() {
    revision++; controller?.abort(); controller = null;
    clearTimeout(timer); data.value = null; resolvedKey.value = ''; error.value = ''; loading.value = false;
  }
  watch([active, () => request.value?.part, () => request.value?.key], ([visible, part, key], [wasVisible, lastPart]) => {
    invalidate();
    if (!visible || key === undefined) return;
    const cached = cache.get(key);
    if (cached) { publish(key, cached); return; }
    // Navigation is deliberate. Only repeated edits to the same side need a debounce.
    if (!wasVisible || part !== lastPart) { void load(); return; }
    loading.value = true;
    timer = setTimeout(() => void load(), 180);
  }, { immediate: true });
  onScopeDispose(() => { invalidate(); cache.clear(); });
  return { data, resolvedKey, loading, error, ready, retry: load };
}
