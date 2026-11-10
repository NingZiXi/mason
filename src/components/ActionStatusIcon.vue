<script setup lang="ts">
withDefaults(defineProps<{
  state?: 'idle' | 'busy' | 'success';
  size?: number;
}>(), { state: 'idle', size: 14 });
</script>

<template>
  <span class="action-status-icon" :style="{ width: `${size}px`, height: `${size}px` }" aria-hidden="true">
    <Transition name="action-icon">
      <span :key="state" class="action-icon-state">
        <svg v-if="state === 'busy'" class="action-icon-spinner" viewBox="0 0 16 16" fill="none">
          <circle class="spinner-track" cx="8" cy="8" r="5" />
          <path d="M8 3a5 5 0 0 1 5 5" />
        </svg>
        <svg v-else-if="state === 'success'" class="action-icon-check" viewBox="0 0 16 16" fill="none">
          <path pathLength="1" d="M3.2 8.2 6.5 11.5 12.8 4.8" />
        </svg>
        <slot v-else />
      </span>
    </Transition>
  </span>
</template>

<style scoped>
.action-status-icon { display: inline-grid; flex-shrink: 0; vertical-align: middle; }
.action-icon-state { display: grid; place-items: center; grid-area: 1 / 1; width: 100%; height: 100%; }
.action-icon-state > svg { display: block; width: 100%; height: 100%; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
.action-icon-enter-active { transition: opacity 150ms var(--ease-out), transform 240ms var(--ease-settle); }
.action-icon-leave-active { transition: opacity 110ms ease, transform 150ms var(--ease-out); }
.action-icon-enter-from { opacity: 0; transform: translateY(2px) scale(.8); }
.action-icon-leave-to { opacity: 0; transform: translateY(-2px) scale(.8); }
.action-icon-spinner { animation: action-icon-spin 850ms linear infinite; }
.spinner-track { opacity: .16; }
.action-icon-check { animation: action-icon-settle 360ms var(--ease-settle) both; }
.action-icon-check path { stroke-dasharray: 1; stroke-dashoffset: 1; animation: action-icon-draw 280ms 35ms var(--ease-out) forwards; }
@keyframes action-icon-spin { to { transform: rotate(360deg); } }
@keyframes action-icon-draw { to { stroke-dashoffset: 0; } }
@keyframes action-icon-settle { from { transform: scale(.82); } to { transform: scale(1); } }
</style>
