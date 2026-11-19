<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import ModeIcon from './ModeIcon.vue';
import LiquidSegmentTrack from './LiquidSegmentTrack.vue';

type Mode = 'jig' | 'stencil';
const props = defineProps<{ mode: Mode }>();
const emit = defineEmits<{ change: [mode: Mode] }>();
const { t } = useI18n();
const iconGroup = ref<HTMLElement[]>([]);
const icons = new Map<HTMLElement, Animation>();

function animateIcons(previous: Mode, interrupted: boolean) {
  iconGroup.value.forEach(element => {
    const running = icons.get(element);
    const style = running ? getComputedStyle(element) : null;
    const wasActive = element.dataset.mode === previous;
    const selected = element.dataset.mode === props.mode;
    const start: Keyframe = { width: style?.width ?? (wasActive ? '20px' : '0px'),
      marginRight: style?.marginRight ?? (wasActive ? '7px' : '0px'),
      transform: style?.transform ?? (wasActive ? 'none' : 'scale(.45)'),
      opacity: style?.opacity ?? (wasActive ? 1 : 0) };
    running?.cancel();
    const finish: Keyframe = { width: selected ? '20px' : '0px',
      marginRight: selected ? '7px' : '0px', transform: selected ? 'none' : 'scale(.45)',
      opacity: selected ? 1 : 0 };
    const frames = selected && !interrupted
      ? [start, { ...finish, transform: 'scale(1.13)', offset: .58 },
          { ...finish, transform: 'scale(.98)', offset: .82 }, finish]
      : [start, finish];
    const animation = element.animate(frames, {
      duration: interrupted ? 200 : selected ? 340 : 160,
      delay: selected && !interrupted ? 230 : 0,
      easing: selected ? 'cubic-bezier(.22, .8, .3, 1)' : 'cubic-bezier(.4, 0, .7, .3)',
      fill: 'both',
    });
    icons.set(element, animation);
    animation.onfinish = () => {
      if (icons.get(element) === animation) icons.delete(element);
      animation.cancel();
    };
  });
}

watch(() => props.mode, (_, previous) => {
  animateIcons(previous, icons.size > 0);
}, { flush: 'post' });

onBeforeUnmount(() => {
  for (const animation of icons.values()) animation.cancel();
  icons.clear();
});
</script>

<template>
  <LiquidSegmentTrack class="mode-switch" :aria-label="`${t('mode.jig')} / ${t('mode.stencil')}`">
    <button v-for="kind in (['jig', 'stencil'] as const)" :key="kind" type="button"
      class="mode-btn" :class="{ active: mode === kind }" :aria-pressed="mode === kind"
      @click="mode !== kind && emit('change', kind)">
      <!-- Reserve both modes' full content width so icon reflow never resizes the rail. -->
      <span class="mode-sizer" aria-hidden="true"><span />{{ t(`mode.${kind}`) }}</span>
      <span class="mode-content">
        <span ref="iconGroup" class="mode-symbol" :data-mode="kind" aria-hidden="true">
          <ModeIcon :kind="kind" :active="mode === kind" :delay="260" />
        </span>
        <span class="mode-label">{{ t(`mode.${kind}`) }}</span>
      </span>
    </button>
  </LiquidSegmentTrack>
</template>

<style scoped>
.mode-switch {
  --corner-shape: round;
  --selection-background: var(--surface-selected);
  --selection-shadow: none;
  isolation: isolate;
  display: inline-grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  flex-shrink: 0;
  padding: 3px;
  border: 1px solid var(--surface-line);
  border-radius: var(--radius-full);
  background: var(--surface-well);
  box-shadow: none;
}
.mode-btn {
  --button-press-scale: .985;
  position: relative;
  z-index: 1;
  display: grid;
  place-items: center;
  padding: 6px 16px;
  border: 0;
  border-radius: var(--radius-full);
  background: transparent;
  color: var(--text-tertiary);
  font-size: 13px;
  font-weight: 600;
  line-height: 20px;
  white-space: nowrap;
  cursor: pointer;
}
.mode-sizer, .mode-content { grid-area: 1 / 1; display: flex; align-items: center; }
.mode-sizer { visibility: hidden; gap: 7px; }
.mode-sizer > span { width: 20px; height: 20px; }
.mode-symbol {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  min-width: 0;
  width: 0;
  height: 20px;
  margin-right: 0;
  opacity: 0;
  transform: scale(.45);
  color: var(--text-brand);
}
.mode-btn.active { color: var(--text-default); }
.mode-btn.active .mode-symbol { width: 20px; margin-right: 7px; opacity: 1; transform: none; }
@media (hover: hover) and (pointer: fine) {
  .mode-btn:not(.active):hover { color: var(--text-secondary); }
}
</style>
