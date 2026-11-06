<script setup lang="ts">
import { onBeforeUnmount } from "vue";

const props = defineProps<{ open: boolean; height?: number }>();
let animation: Animation | undefined;
let target: HTMLElement | undefined;
let interrupted = false;

function restoreHeight(node: HTMLElement) {
  node.style.height = props.height === undefined ? "" : `${props.height}px`;
  node.style.opacity = "";
}

// Save the visible intermediate size before a reversal so rapid clicks do not
// jump back to the beginning. No timers or permanent animation frames.
function cancel(el: Element) {
  const node = el as HTMLElement;
  if (!animation) return;
  const height = node.getBoundingClientRect().height;
  const opacity = getComputedStyle(node).opacity;
  animation.cancel();
  animation = undefined;
  interrupted = true;
  node.style.height = `${height}px`;
  node.style.opacity = opacity;
}

function beforeEnter(el: Element) {
  const node = el as HTMLElement;
  if (!interrupted) {
    node.style.height = "0px";
    node.style.opacity = "0";
  }
}

function move(el: Element, done: () => void, opening: boolean) {
  const node = el as HTMLElement;
  cancel(node);
  interrupted = false;
  target = node;
  const from = node.getBoundingClientRect().height;
  const opacity = getComputedStyle(node).opacity;
  // Measure natural content, not the clipped/animated parent.
  const content = node.firstElementChild as HTMLElement;
  const to = opening ? props.height ?? content.scrollHeight : 0;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    restoreHeight(node);
    done();
    return;
  }
  animation = node.animate([
    { height: `${from}px`, opacity },
    { height: `${to}px`, opacity: opening ? 1 : 0 },
  ], { duration: opening ? 280 : 210, easing: "cubic-bezier(.22,1,.36,1)", fill: "both" });
  const current = animation;
  current.onfinish = () => {
    if (animation !== current) return;
    restoreHeight(node);
    animation = undefined;
    current.cancel();
    done();
  };
}

onBeforeUnmount(() => {
  animation?.cancel();
  animation = undefined;
  if (target) { target.style.height = ""; target.style.opacity = ""; }
});
</script>

<template>
  <Transition :css="false" @before-enter="beforeEnter" @enter="(el, done) => move(el, done, true)"
    @leave="(el, done) => move(el, done, false)" @enter-cancelled="cancel" @leave-cancelled="cancel">
    <div v-show="open" class="motion-collapse" :class="{ 'has-fixed-height': height !== undefined }" :inert="!open" :aria-hidden="!open"
      :style="height === undefined ? undefined : { height: height + 'px' }">
      <div class="motion-collapse-content"><slot /></div>
    </div>
  </Transition>
</template>

<style scoped>
.motion-collapse { overflow: hidden; min-height: 0; flex-shrink: 0; }
.motion-collapse-content { display: flow-root; }
.has-fixed-height > .motion-collapse-content { height: 100%; display: flex; flex-direction: column; }
</style>
