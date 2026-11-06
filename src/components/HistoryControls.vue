<script setup lang="ts">
import { onMounted, onBeforeUnmount } from "vue";
import { useI18n } from "vue-i18n";
import { useConfigStore } from "../stores/config";
import { parameterHistoryShortcut } from "../lib/history-shortcuts";

const store = useConfigStore();
const { t } = useI18n();
function onKeydown(event: KeyboardEvent) {
  const action = parameterHistoryShortcut(event);
  if (!action || (action === "undo" ? !store.canUndo : !store.canRedo)) return;
  // Modal dialogs and the onboarding tour own their keyboard interactions.
  if (Array.from(document.querySelectorAll(".el-overlay-dialog, .el-message-box__wrapper, .el-tour__content"))
    .some((element) => element.getClientRects().length > 0)) return;
  event.preventDefault();
  void store[action]();
}
onMounted(() => window.addEventListener("keydown", onKeydown));
onBeforeUnmount(() => window.removeEventListener("keydown", onKeydown));
</script>

<template>
  <div class="history-controls" role="group" :aria-label="t('history.label')">
    <button type="button" :disabled="!store.canUndo" :title="t('history.undoHint')" :aria-label="t('history.undo')"
      aria-keyshortcuts="Control+Z Meta+Z" @click="store.undo()">
      <svg viewBox="0 0 20 20" width="17" height="17" fill="none" aria-hidden="true">
        <path d="m7 4-4 4 4 4M3.5 8H12a4.5 4.5 0 0 1 0 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </button>
    <button type="button" :disabled="!store.canRedo" :title="t('history.redoHint')" :aria-label="t('history.redo')"
      aria-keyshortcuts="Control+Y Control+Shift+Z Meta+Shift+Z" @click="store.redo()">
      <svg viewBox="0 0 20 20" width="17" height="17" fill="none" aria-hidden="true">
        <path d="m13 4 4 4-4 4M16.5 8H8a4.5 4.5 0 0 0 0 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </button>
  </div>
</template>

<style scoped>
.history-controls { display: inline-flex; flex-shrink: 0; gap: 2px; padding: 3px; border: 1px solid var(--border-neutral-l2); border-radius: var(--radius-control); background: var(--surface-well); }
.history-controls button { display: grid; place-items: center; width: 28px; height: 26px; padding: 0; border: none; border-radius: 7px; background: transparent; color: var(--text-secondary); cursor: pointer; transition: var(--control-transition); }
.history-controls button:hover:not(:disabled) { background: var(--bg-base-default); color: var(--text-default); }
.history-controls button:active:not(:disabled) { transform: scale(.94); }
.history-controls button:disabled { opacity: .3; cursor: default; }
.history-controls button:focus-visible { outline: 2px solid var(--bg-brand); outline-offset: 1px; }
</style>
