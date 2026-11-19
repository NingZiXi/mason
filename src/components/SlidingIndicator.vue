<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, shallowRef } from 'vue';

// The parent is a positioned, single-choice group. Measuring layout offsets
// keeps a pressed button's temporary scale out of the indicator's geometry.
const element = ref<HTMLElement | null>(null);
const bounds = shallowRef({ x: 0, y: 0, width: 0, height: 0 });
const visible = ref(false);
const sliding = ref(false);
let previous: HTMLButtonElement | null = null;
let host: HTMLElement | null = null;
let resize: ResizeObserver | undefined;
let mutations: MutationObserver | undefined;
let measureFrame = 0;
let disposed = false;

function measure() {
  measureFrame = 0;
  const selected = host?.querySelector<HTMLButtonElement>(':scope > button[aria-pressed="true"]');
  if (!selected || !selected.offsetWidth || !selected.offsetHeight) {
    previous = null;
    sliding.value = false;
    visible.value = false;
    return;
  }
  const { offsetLeft: x, offsetTop: y, offsetWidth: width, offsetHeight: height } = selected;
  const old = bounds.value;
  if (previous === selected && x === old.x && y === old.y && width === old.width && height === old.height) return;
  // Animate a new choice, but track resizing/translated labels without trailing the button.
  sliding.value = previous !== null && previous !== selected;
  previous = selected;
  bounds.value = { x, y, width, height };
  visible.value = true;
}

function scheduleMeasure() {
  if (!disposed && !measureFrame) measureFrame = requestAnimationFrame(measure);
}

function observeButtons() {
  if (!host || !resize) return;
  resize.disconnect();
  resize.observe(host);
  host.querySelectorAll<HTMLButtonElement>(':scope > button').forEach(button => resize!.observe(button));
}

onMounted(() => {
  host = element.value?.parentElement ?? null;
  if (!host) return;
  resize = new ResizeObserver(scheduleMeasure);
  observeButtons();
  // Observe only selection and content, never our own animated style. This
  // also covers translated labels and groups replaced when the mode changes.
  mutations = new MutationObserver(records => {
    if (records.some(record => record.type === 'childList')) observeButtons();
    scheduleMeasure();
  });
  mutations.observe(host, { subtree: true, childList: true, characterData: true,
    attributes: true, attributeFilter: ['aria-pressed'] });
  measure();
  void document.fonts?.ready.then(scheduleMeasure);
});

onBeforeUnmount(() => {
  disposed = true;
  resize?.disconnect();
  mutations?.disconnect();
  cancelAnimationFrame(measureFrame);
});
</script>

<template>
  <span ref="element" class="sliding-indicator" :class="{ 'is-visible': visible, 'is-sliding': sliding }"
    aria-hidden="true" :style="{ width: `${bounds.width}px`, height: `${bounds.height}px`,
      transform: `translate(${bounds.x}px, ${bounds.y}px)` }" />
</template>

<style scoped>
.sliding-indicator {
  position: absolute;
  left: 0;
  top: 0;
  z-index: 0;
  border: 1px solid var(--selection-border, var(--surface-line));
  border-radius: var(--selection-radius, var(--radius-full));
  corner-shape: var(--corner-shape);
  background: var(--selection-background, var(--surface-raised));
  box-shadow: var(--selection-shadow, var(--shadow-control));
  opacity: 0;
  pointer-events: none;
}
.sliding-indicator.is-sliding {
  transition: transform var(--motion-selection) var(--ease-selection),
    width var(--motion-selection) var(--ease-selection),
    height var(--motion-selection) var(--ease-selection),
    opacity var(--motion-fast) var(--ease-out),
    background-color var(--motion-fast) var(--ease-out),
    border-color var(--motion-fast) var(--ease-out);
}
.sliding-indicator.is-visible { opacity: 1; }
</style>
