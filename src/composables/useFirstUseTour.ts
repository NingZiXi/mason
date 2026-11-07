import { nextTick, onScopeDispose, ref, watch } from 'vue';

/** Wait for real content before offering a tour, and cancel a pending opening
 * when its view closes. Only an explicit dismissal marks it as seen. */
export function useFirstUseTour(options: {
  ready: () => boolean;
  seen: () => boolean;
  prepare: () => void;
  dismiss: () => void;
}) {
  const open = ref(false);
  let revision = 0;
  let preparing = false;

  function hide() {
    revision++;
    preparing = false;
    open.value = false;
  }

  async function start() {
    if (!options.ready() || open.value || preparing) return;
    const token = ++revision;
    preparing = true;
    try {
      options.prepare();
      // The editable toolbar may have just replaced the read-only notice.
      await nextTick();
      if (token === revision && options.ready()) open.value = true;
    } finally {
      if (token === revision) preparing = false;
    }
  }

  function close() {
    hide();
    options.dismiss();
  }

  watch(() => [options.ready(), options.seen()], ([ready, seen]) => {
    if (!ready) hide();
    else if (!seen) void start();
  }, { immediate: true, flush: 'post' });
  onScopeDispose(hide);

  return { open, start, close };
}
