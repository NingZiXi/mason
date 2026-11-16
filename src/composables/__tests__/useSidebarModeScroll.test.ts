import { afterEach, describe, expect, it, vi } from 'vitest';
import { effectScope, nextTick, ref, shallowRef, watch } from 'vue';
import { useSidebarModeScroll } from '../useSidebarModeScroll';
import type { AppMode } from '../../stores/config';

const scopes: ReturnType<typeof effectScope>[] = [];
afterEach(() => scopes.splice(0).forEach(scope => scope.stop()));

function setup() {
  const mode = ref<AppMode>('jig');
  const node = { scrollTop: 620, scrollTo: vi.fn(({ top }: ScrollToOptions) => { node.scrollTop = top ?? 0; }) };
  const sidebar = shallowRef(node as unknown as HTMLElement);
  const scope = effectScope();
  scopes.push(scope);
  scope.run(() => useSidebarModeScroll(mode, sidebar));
  return { mode, node, sidebar, scope };
}

async function settle() { await nextTick(); await nextTick(); }

describe('mode-specific parameter reading position', () => {
  it('saves before content shrinkage and restores each mode after the DOM update', async () => {
    const state = setup();
    state.scope.run(() => watch(state.mode, () => {
      // Simulate the browser clamping scrollTop when the shorter form replaces it.
      state.node.scrollTop = Math.min(state.node.scrollTop, state.mode.value === 'stencil' ? 180 : 1000);
    }, { flush: 'post' }));
    state.mode.value = 'stencil';
    await settle();
    expect(state.node.scrollTop).toBe(0);
    state.node.scrollTop = 145;
    state.mode.value = 'jig';
    await settle();
    expect(state.node.scrollTop).toBe(620);
    state.mode.value = 'stencil';
    await settle();
    expect(state.node.scrollTop).toBe(145);
  });

  it('does not assign an interrupted transition the previous mode’s position', async () => {
    const state = setup();
    let reverse = true;
    state.scope.run(() => watch(state.mode, mode => {
      if (mode === 'stencil' && reverse) {
        reverse = false;
        state.node.scrollTop = 180;
        state.mode.value = 'jig';
      }
    }, { flush: 'post' }));
    state.mode.value = 'stencil';
    await settle();
    expect(state.node.scrollTop).toBe(620);
    expect(state.node.scrollTo.mock.calls.map(([options]) => options.top)).toEqual([620]);
    state.mode.value = 'stencil';
    await settle();
    expect(state.node.scrollTop).toBe(0);
  });

  it('leaves the sidebar alone when mode changes cancel out within the same update', async () => {
    const state = setup();
    state.mode.value = 'stencil';
    state.mode.value = 'jig';
    await settle();
    expect(state.node.scrollTop).toBe(620);
    expect(state.node.scrollTo).not.toHaveBeenCalled();
  });

  it('does not restore a stale position after the sidebar scope is disposed', async () => {
    const state = setup();
    state.scope.run(() => watch(state.mode, () => state.scope.stop(), { flush: 'post' }));
    state.mode.value = 'stencil';
    await settle();
    expect(state.node.scrollTo).not.toHaveBeenCalled();
  });
});
