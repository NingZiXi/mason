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
  fetchMetrics: (part: string, params: P) => Promise<PartMetrics>,
) {
  const metrics = shallowRef<Record<string, PartMetrics>>({});
  const loading = ref(false);
  let successfulHash: string | null = null;
  let revision = 0;
  let disposed = false;
  let pending: { hash: string; revision: number; promise: Promise<void> } | null = null;

  function invalidate() {
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

    const token = ++revision;
    metrics.value = {};
    successfulHash = null;
    loading.value = true;
    const current = () => !disposed && token === revision && isCurrent(request.hash);
    const promise = (async () => {
      try {
        const entries = await Promise.all(request.parts.map(async part =>
          [part, await fetchMetrics(part, request.params)] as const
        ));
        if (current()) {
          metrics.value = Object.fromEntries(entries);
          successfulHash = request.hash;
        }
      } catch (error) {
        // Failed requests stay uncached so reopening the card can retry.
        if (current()) console.warn("[metrics] failed:", error);
      } finally {
        if (token === revision) { loading.value = false; pending = null; }
      }
    })();
    pending = { hash: request.hash, revision: token, promise };
    await promise;
  }

  function dispose() { disposed = true; invalidate(); }
  return { metrics, loading, load, invalidate, dispose };
}
