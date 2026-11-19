<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import InspectionMorphGlyph from './InspectionMorphGlyph.vue';

const props = defineProps<{ kind: 'assembly' | 'inspection'; active: boolean }>();
const emit = defineEmits<{ activate: [] }>();
const { t } = useI18n();
const contact = ref<HTMLElement | null>(null);
const upper = ref<SVGElement | null>(null), lower = ref<SVGElement | null>(null);
const running = new Map<Element, Animation>();

function play(el: Element | null, frames: Keyframe[], duration: number) {
  if (!el) return;
  const previous = running.get(el);
  if (previous) {
    // Continue from the visible pose if the user reverses or clicks again.
    const style = getComputedStyle(el);
    if ('transform' in frames[0]) frames[0].transform = style.transform;
    if ('opacity' in frames[0]) frames[0].opacity = style.opacity;
    previous.cancel();
  }
  const animation = el.animate(frames, { duration, easing: 'linear' });
  running.set(el, animation);
  animation.onfinish = () => { if (running.get(el) === animation) running.delete(el); };
}
const ease = 'cubic-bezier(.24,.78,.32,1)';
const y = (px: number) => `translateY(${px}px)`;
function seat(layer: Element | null, lift: number, duration: number) {
  play(layer, [
    { transform: 'none', easing: ease },
    { transform: y(lift), offset: .25, easing: 'cubic-bezier(.58,.05,.8,.55)' },
    { transform: y(-lift * .32), offset: .61, easing: ease },
    { transform: y(lift * .12), offset: .8, easing: ease },
    { transform: 'none' },
  ], duration);
}
function activate() {
  emit('activate');
  play(contact.value, [
    { transform: 'scale(.84,.9)', opacity: .08, easing: ease },
    { transform: 'scale(.98,1)', opacity: .16, offset: .30, easing: ease },
    { transform: 'scale(1)', opacity: 0 },
  ], 290);
  if (props.kind === 'assembly') {
    // The bottom plate stays planted. The top and middle settle onto it in sequence.
    seat(upper.value, -3.1, 400);
    seat(lower.value, -1.7, 320);
  }
}
onBeforeUnmount(() => { for (const a of running.values()) a.cancel(); running.clear(); });
</script>

<template>
  <button type="button" class="assembly-mode-btn" :class="{ active }" :aria-pressed="active" @click="activate">
    <span ref="contact" class="contact" aria-hidden="true" />
    <svg viewBox="0 0 18 18" width="16" height="16" fill="none" stroke="currentColor"
      stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <template v-if="kind === 'assembly'">
        <path d="M2.5 11.9L9 15.5l6.5-3.6" />
        <path ref="lower" d="M2.5 9L9 12.6 15.5 9" />
        <path ref="upper" d="M9 2.5l6.5 3.6L9 9.7 2.5 6.1 9 2.5Z" />
      </template>
      <InspectionMorphGlyph v-else :cube="active" />
    </svg>
    <span v-if="kind === 'assembly'">{{ t('preview.assembly') }}</span>
    <span v-else class="inspection-label">
      <span :class="{ spacer: active }" :aria-hidden="active">{{ t('inspection.title') }}</span>
      <span :class="{ spacer: !active }" :aria-hidden="!active">{{ t('inspection.back3d') }}</span>
    </span>
  </button>
</template>

<style scoped>
.assembly-mode-btn { position: relative; }
.assembly-mode-btn svg { flex-shrink: 0; overflow: visible; }
.contact { position: absolute; inset: 0; border-radius: inherit; background: currentColor; opacity: 0; pointer-events: none; }
.inspection-label { display: inline-grid; place-items: center; }
.inspection-label > span { grid-area: 1 / 1; }
.inspection-label .spacer { visibility: hidden; }
</style>
