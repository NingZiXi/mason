import { nextTick, onScopeDispose, watch, type Ref } from 'vue';
import type { AppMode } from '../stores/config';

/** Keep each mode's reading position without keeping its parameter form mounted. */
export function useSidebarModeScroll(mode: Readonly<Ref<AppMode>>, sidebar: Ref<HTMLElement | null>) {
  const positions: Record<AppMode, number> = { jig: 0, stencil: 0 };
  let sequence = 0;
  let restoring = false;

  watch(mode, async (nextMode, previousMode) => {
    // Capture before Vue replaces the form and the browser clamps scrollTop.
    // A mode interrupted before restoration never owned the displayed position.
    if (!restoring && sidebar.value) positions[previousMode] = sidebar.value.scrollTop;
    restoring = true;
    const current = ++sequence;
    await nextTick();
    if (current !== sequence || mode.value !== nextMode) return;
    sidebar.value?.scrollTo({ top: positions[nextMode], behavior: 'instant' });
    restoring = false;
  }, { flush: 'pre' });

  onScopeDispose(() => { sequence++; });
}
