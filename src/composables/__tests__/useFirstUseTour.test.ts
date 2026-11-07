import { afterEach, describe, expect, it, vi } from 'vitest';
import { effectScope, nextTick, ref } from 'vue';
import { useFirstUseTour } from '../useFirstUseTour';

const scopes: ReturnType<typeof effectScope>[] = [];
afterEach(() => scopes.splice(0).forEach(scope => scope.stop()));

function setup(initialReady = false, initialSeen = false) {
  const ready = ref(initialReady), seen = ref(initialSeen);
  const prepare = vi.fn(), dismiss = vi.fn(() => { seen.value = true; });
  const scope = effectScope(); scopes.push(scope);
  const tour = scope.run(() => useFirstUseTour({
    ready: () => ready.value, seen: () => seen.value, prepare, dismiss,
  }))!;
  return { ...tour, ready, seen, prepare, dismiss, scope };
}

describe('first-use tour lifetime', () => {
  it('waits for content, prepares the editable view and opens after its DOM update', async () => {
    const tour = setup();
    await nextTick();
    expect(tour.prepare).not.toHaveBeenCalled();
    expect(tour.open.value).toBe(false);
    tour.ready.value = true;
    await nextTick();
    await nextTick();
    expect(tour.prepare).toHaveBeenCalledOnce();
    expect(tour.open.value).toBe(true);
    expect(tour.dismiss).not.toHaveBeenCalled();
  });

  it('remembers completion or skipping and still allows an explicit replay', async () => {
    const tour = setup(true);
    await nextTick();
    expect(tour.open.value).toBe(true);
    tour.close();
    expect(tour.seen.value).toBe(true);
    tour.ready.value = false;
    await nextTick();
    tour.ready.value = true;
    await nextTick();
    await nextTick();
    expect(tour.open.value).toBe(false);
    await tour.start();
    expect(tour.open.value).toBe(true);
  });

  it('does not automatically show an already-seen tour', async () => {
    const tour = setup(true, true);
    await nextTick();
    expect(tour.open.value).toBe(false);
    expect(tour.prepare).not.toHaveBeenCalled();
  });

  it('cancels a pending opening when leaving the view without consuming the first visit', async () => {
    const tour = setup(true);
    tour.ready.value = false;
    await nextTick();
    expect(tour.open.value).toBe(false);
    expect(tour.seen.value).toBe(false);
    tour.ready.value = true;
    await nextTick();
    await nextTick();
    expect(tour.open.value).toBe(true);
  });

  it('hides while data is unavailable and offers the unfinished tour when ready again', async () => {
    const tour = setup(true);
    await nextTick();
    tour.ready.value = false;
    await nextTick();
    expect(tour.open.value).toBe(false);
    expect(tour.dismiss).not.toHaveBeenCalled();
    tour.ready.value = true;
    await nextTick();
    await nextTick();
    expect(tour.open.value).toBe(true);
  });

  it('ignores repeated replay clicks and does not prepare before content is ready', async () => {
    const tour = setup(false, true);
    await tour.start();
    expect(tour.prepare).not.toHaveBeenCalled();
    tour.ready.value = true;
    await Promise.all([tour.start(), tour.start()]);
    expect(tour.prepare).toHaveBeenCalledOnce();
    expect(tour.open.value).toBe(true);
  });

  it('does not reopen after its view is disposed during preparation', async () => {
    const tour = setup(true);
    tour.scope.stop();
    await nextTick();
    expect(tour.open.value).toBe(false);
    expect(tour.dismiss).not.toHaveBeenCalled();
  });
});
