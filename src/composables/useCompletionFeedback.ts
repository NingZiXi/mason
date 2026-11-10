import { onScopeDispose, ref } from 'vue';

/** A short acknowledgement after real success, without delaying the next action. */
export function useCompletionFeedback() {
  const completed = ref(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  function reset() {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    completed.value = false;
  }

  function complete() {
    if (disposed) return;
    reset();
    completed.value = true;
    timer = setTimeout(reset, 1800);
  }

  onScopeDispose(() => {
    disposed = true;
    reset();
  });

  return { completed, complete, reset };
}
