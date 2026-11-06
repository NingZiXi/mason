<script setup lang="ts">
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import MotionCollapse from "./MotionCollapse.vue";

defineProps<{ id: string; label: string; text: string }>();
const open = ref(false);
const { t } = useI18n();
</script>

<template>
  <div class="inline-help">
    <div class="help-heading">
      <div class="help-label"><slot /></div>
      <button type="button" class="help-button" :class="{ active: open }"
        :aria-label="t(open ? 'help.hide' : 'help.show', { label })"
        :aria-expanded="open" :aria-controls="id" @click="open = !open">
        <svg viewBox="0 0 20 20" width="16" height="16" fill="none" aria-hidden="true">
          <circle cx="10" cy="10" r="7.25" stroke="currentColor" stroke-width="1.3" />
          <path d="M7.9 7.6a2.1 2.1 0 1 1 3.5 1.55C10.45 9.8 10 10.05 10 11.1" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
          <circle cx="10" cy="13.5" r=".8" fill="currentColor" />
        </svg>
      </button>
    </div>
    <MotionCollapse :id="id" :open="open"><p class="help-description">{{ text }}</p></MotionCollapse>
  </div>
</template>

<style scoped>
.help-heading { display: flex; align-items: center; gap: 6px; min-width: 0; }
.help-label { min-width: 0; }
.help-button { display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; width: 24px; height: 24px; padding: 0; border: none; border-radius: 50%; background: transparent; color: var(--text-tertiary); cursor: pointer; transition: var(--control-transition); }
.help-button:active { scale: .94; transition-duration: var(--motion-press); }
.help-button:hover, .help-button.active { background: var(--status-success-surface-l1); color: var(--text-brand); }
.help-button:focus-visible { outline: 2px solid var(--bg-brand); outline-offset: 2px; }
.help-description { margin: 6px 0 8px; padding: 9px 11px; background: var(--surface-well); border-radius: var(--radius-control); corner-shape: var(--corner-shape); color: var(--text-secondary); font-size: 11px; font-weight: 400; line-height: 1.7; overflow-wrap: anywhere; }
</style>
