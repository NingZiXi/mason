import { ref, shallowRef } from "vue";

export interface PartMetrics {
  volume_mm3: number;
  area_mm2: number;
}

interface MetricsSnapshot<P> {
  hash: string;
  params: P;
  parts: string[];
}

export function usePartMetrics<P>(
  snapshot: () => MetricsSnapshot<P> | null,
  isCurrent: (hash: string) => boolean,
  fetchMetrics: (part: string, params: P, signal: AbortSignal) => Promise<PartMetrics>,
  partKey?: (part: string, params: P) => string,
) {
  const metrics = shallowRef<Record<string, PartMetrics>>({});
  const loading = ref(false);
  let successfulHash: string | null = null;
  let revision = 0;
  let disposed = false;
  let controller: AbortController | null = null;
  const partCache = new Map<string, PartMetrics>();
  let pending: { hash: string; revision: number; promise: Promise<void> } | null = null;

  function invalidate() {
    controller?.abort();
    controller = null;
    revision++;
    pending = null;
    successfulHash = null;
    metrics.value = {};
    loading.value = false;
  }

  async function load() {
    if (disposed) return;
    const request = snapshot();
    if (!request) { invalidate(); return; }
    if (successfulHash === request.hash) return;
    if (pending?.hash === request.hash && pending.revision === revision) return pending.promise;

    controller?.abort();
    const requestController = new AbortController();
    controller = requestController;
    const token = ++revision;
    metrics.value = {};
    successfulHash = null;
    loading.value = true;
    const current = () => !disposed && token === revision && isCurrent(request.hash);
    const promise = (async () => {
      try {
        const entries: Array<readonly [string, PartMetrics]> = [];
        for (const part of request.parts) {
          if (!current() || requestController.signal.aborted) return;
          const key = `${part}:${partKey ? partKey(part, request.params) : request.hash}`;
          const result = partCache.get(key) ?? await fetchMetrics(part, request.params, requestController.signal);
          if (!current() || requestController.signal.aborted) return;
          partCache.delete(key);
          partCache.set(key, result);
          while (partCache.size > 12) partCache.delete(partCache.keys().next().value!);
          entries.push([part, result]);
        }
        if (current()) {
          metrics.value = Object.fromEntries(entries);
          successfulHash = request.hash;
        }
      } catch (error) {
        // Failed requests stay uncached so reopening the card can retry.
        if (current() && !requestController.signal.aborted) console.warn("[metrics] failed:", error);
      } finally {
        if (token === revision) { loading.value = false; pending = null; }
      }
    })();
    pending = { hash: request.hash, revision: token, promise };
    await promise;
  }

  function dispose() { disposed = true; invalidate(); partCache.clear(); }
  return { metrics, loading, load, invalidate, dispose };
}
