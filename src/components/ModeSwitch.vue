<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import ModeIcon from './ModeIcon.vue';

type Mode = 'jig' | 'stencil';
type Bounds = { left: number; top: number; width: number; height: number };
const props = defineProps<{ mode: Mode }>();
const emit = defineEmits<{ change: [mode: Mode] }>();
const { t } = useI18n();
const root = ref<HTMLElement | null>(null);
const thumb = ref<HTMLElement | null>(null);
const visible = ref(false);
const icons = new Map<HTMLElement, Animation>();
let thumbAnimation: Animation | null = null;
let bounds: Bounds | undefined;
let resize: ResizeObserver | undefined;
let layoutFrame = 0;
let disposed = false;

function selectedBounds(): Bounds | undefined {
  const selected = root.value?.querySelector<HTMLButtonElement>('.mode-btn.active');
  if (!selected?.offsetWidth) return;
  return { left: selected.offsetLeft, top: selected.offsetTop,
    width: selected.offsetWidth, height: selected.offsetHeight };
}

function positionThumb(next: Bounds, animate = false, interrupted = false) {
  const element = thumb.value;
  if (!element) return;
  const current = getComputedStyle(element);
  const startLeft = parseFloat(current.left) || 0;
  const startWidth = parseFloat(current.width) || next.width;
  thumbAnimation?.cancel();
  thumbAnimation = null;
  Object.assign(element.style, { left: `${next.left}px`, top: `${next.top}px`,
    width: `${next.width}px`, height: `${next.height}px` });
  bounds = next;
  visible.value = true;
  if (!animate) return;

  const finish = { left: `${next.left}px`, width: `${next.width}px` };
  const frames: Keyframe[] = [];
  const duration = interrupted ? 200 : 380;
  if (interrupted) {
    frames.push({ left: `${startLeft}px`, width: `${startWidth}px` }, finish);
  } else {
    // Design reference: video-shotcraft's segmented-thumb-hero. The leading
    // edge travels first, then the trailing edge catches up before settling.
    // Animate bounds so the pill's semicircular ends remain circular.
    const buttons = [...(root.value?.querySelectorAll<HTMLElement>('.mode-btn') ?? [])];
    const minLeft = Math.min(...buttons.map(button => button.offsetLeft));
    const maxRight = Math.max(...buttons.map(button => button.offsetLeft + button.offsetWidth));
    const distance = next.left - startLeft;
    for (let index = 0; index <= 16; index++) {
      const time = index / 16;
      const travel = 1 - (1 - time) ** 3;
      const width = startWidth + (next.width - startWidth) * travel;
      const stretch = Math.min(Math.abs(distance), width) * .1 * Math.sin(Math.PI * time);
      const center = startLeft + startWidth / 2
        + (next.left + next.width / 2 - startLeft - startWidth / 2) * travel;
      const left = Math.max(minLeft, center - (width + stretch) / 2);
      const right = Math.min(maxRight, center + (width + stretch) / 2);
      frames.push({ left: `${left}px`, width: `${right - left}px`, offset: time * 260 / duration });
    }
    frames.push({ left: `${next.left + Math.sign(distance) * Math.min(1, Math.abs(distance) * .01)}px`,
      width: finish.width, offset: .81 }, { ...finish, offset: 1 });
  }
  const animation = element.animate(frames, { duration, fill: 'both',
    easing: interrupted ? 'cubic-bezier(.22, 1, .36, 1)' : 'linear' });
  thumbAnimation = animation;
  animation.onfinish = () => {
    if (thumbAnimation === animation) thumbAnimation = null;
    animation.cancel();
  };
}

function animateIcons(previous: Mode, interrupted: boolean) {
  root.value?.querySelectorAll<HTMLElement>('.mode-symbol').forEach(element => {
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
  const next = selectedBounds();
  if (!next) return;
  const interrupted = !!thumbAnimation || icons.size > 0;
  positionThumb(next, !!bounds, interrupted);
  animateIcons(previous, interrupted);
}, { flush: 'post' });

function scheduleLayout() {
  if (disposed || layoutFrame) return;
  layoutFrame = requestAnimationFrame(() => {
    layoutFrame = 0;
    const next = selectedBounds();
    if (next && (!bounds || Object.keys(next).some(key => next[key as keyof Bounds] !== bounds![key as keyof Bounds]))) {
      positionThumb(next, !!bounds, true);
    }
  });
}

onMounted(() => {
  const next = selectedBounds();
  if (next) positionThumb(next);
  resize = new ResizeObserver(scheduleLayout);
  if (root.value) {
    resize.observe(root.value);
    root.value.querySelectorAll('.mode-btn').forEach(button => resize!.observe(button));
  }
  void document.fonts?.ready.then(scheduleLayout);
});

onBeforeUnmount(() => {
  disposed = true;
  resize?.disconnect();
  cancelAnimationFrame(layoutFrame);
  thumbAnimation?.cancel();
  for (const animation of icons.values()) animation.cancel();
  icons.clear();
});
</script>

<template>
  <div ref="root" class="mode-switch" role="group" :aria-label="`${t('mode.jig')} / ${t('mode.stencil')}`">
    <span ref="thumb" class="mode-thumb mode-indicator" :class="{ 'is-visible': visible }" aria-hidden="true" />
    <button v-for="kind in (['jig', 'stencil'] as const)" :key="kind" type="button"
      class="mode-btn" :class="{ active: mode === kind }" :aria-pressed="mode === kind"
      @click="mode !== kind && emit('change', kind)">
      <!-- Reserve both modes' full content width so icon reflow never resizes the rail. -->
      <span class="mode-sizer" aria-hidden="true"><span />{{ t(`mode.${kind}`) }}</span>
      <span class="mode-content">
        <span class="mode-symbol" :data-mode="kind" aria-hidden="true">
          <ModeIcon :kind="kind" :active="mode === kind" :delay="260" />
        </span>
        <span class="mode-label">{{ t(`mode.${kind}`) }}</span>
      </span>
    </button>
  </div>
</template>

<style scoped>
.mode-switch {
  --corner-shape: round;
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
.mode-thumb {
  position: absolute;
  left: 0;
  top: 0;
  z-index: 0;
  border: 1px solid var(--surface-line);
  border-radius: var(--radius-full);
  corner-shape: round;
  background: var(--surface-selected);
  box-shadow: none;
  opacity: 0;
  pointer-events: none;
}
.mode-thumb.is-visible { opacity: 1; }
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
