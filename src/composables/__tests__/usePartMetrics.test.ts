import { describe, expect, it, vi } from "vitest";
import { usePartMetrics, type PartMetrics } from "../usePartMetrics";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const metric = (volume: number): PartMetrics => ({ volume_mm3: volume, area_mm2: volume * 2 });

function setup() {
  let hash = "a";
  let ready = true;
  const requests: ReturnType<typeof deferred<PartMetrics>>[] = [];
  const fetch = vi.fn(() => {
    const request = deferred<PartMetrics>();
    requests.push(request);
    return request.promise;
  });
  const state = usePartMetrics(
    () => ready ? { hash, params: { hash }, parts: ["base"] } : null,
    captured => ready && captured === hash,
    fetch,
  );
  return { state, requests, fetch, change: (value: string) => { hash = value; }, unavailable: () => { ready = false; } };
}

describe("print metrics request lifecycle", () => {
  it("deduplicates pending requests and reuses successful results", async () => {
    const { state, fetch, requests } = setup();
    const first = state.load();
    const duplicate = state.load();
    expect(fetch).toHaveBeenCalledTimes(1);
    requests[0].resolve(metric(100));
    await Promise.all([first, duplicate]);
    await state.load();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(state.metrics.value.base.volume_mm3).toBe(100);
    expect(state.loading.value).toBe(false);
  });

  it("clears old data on invalidation and ignores out-of-order results", async () => {
    const { state, requests, change } = setup();
    const first = state.load();
    change("b");
    state.invalidate();
    expect(state.metrics.value).toEqual({});
    const second = state.load();
    requests[1].resolve(metric(200));
    await second;
    requests[0].resolve(metric(100));
    await first;
    expect(state.metrics.value.base.volume_mm3).toBe(200);
    expect(state.loading.value).toBe(false);
  });

  it("does not let an old request clear a newer loading indicator", async () => {
    const { state, requests, change } = setup();
    const first = state.load();
    change("b");
    const second = state.load();
    requests[0].resolve(metric(100));
    await first;
    expect(state.loading.value).toBe(true);
    expect(state.metrics.value).toEqual({});
    requests[1].resolve(metric(200));
    await second;
    expect(state.loading.value).toBe(false);
  });

  it("allows retry after a failure following an earlier successful calculation", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { state, requests, fetch, change } = setup();
      const first = state.load();
      requests[0].resolve(metric(100));
      await first;
      change("b");
      state.invalidate();
      expect(state.metrics.value).toEqual({});
      const failed = state.load();
      requests[1].reject(new Error("CAD unavailable"));
      await failed;
      expect(state.loading.value).toBe(false);
      const retry = state.load();
      expect(fetch).toHaveBeenCalledTimes(3);
      requests[2].resolve(metric(200));
      await retry;
      expect(state.metrics.value.base.volume_mm3).toBe(200);
    } finally { warn.mockRestore(); }
  });

  it("rejects a stale result even before the change watcher invalidates it", async () => {
    const { state, requests, change } = setup();
    const first = state.load();
    change("b");
    requests[0].resolve(metric(100));
    await first;
    expect(state.metrics.value).toEqual({});
  });

  it("ignores late results after unmount and never starts another request", async () => {
    const { state, requests, fetch } = setup();
    const first = state.load();
    state.dispose();
    requests[0].resolve(metric(100));
    await first;
    await state.load();
    expect(state.metrics.value).toEqual({});
    expect(state.loading.value).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not invoke CAD when the Python engine or board data is unavailable", async () => {
    const { state, unavailable, fetch } = setup();
    unavailable();
    await state.load();
    expect(fetch).not.toHaveBeenCalled();
    expect(state.metrics.value).toEqual({});
  });
});
