<script setup lang="ts">
import { onBeforeUnmount, watch } from "vue";

const props = defineProps<{ open: boolean; height?: number }>();
const emit = defineEmits<{ shown: [panel: Element] }>();
let animation: Animation | undefined;
let resizeObserver: ResizeObserver | undefined;
let updateHeightMode: (() => void) | undefined;
let target: HTMLElement | undefined;
let interrupted = false;

function stopObserving() {
  updateHeightMode = undefined;
  resizeObserver?.disconnect();
  resizeObserver = undefined;
}

function restoreHeight(node: HTMLElement) {
  node.style.height = props.height === undefined ? "" : `${props.height}px`;
  node.style.opacity = "";
}

// Save the visible intermediate size before a reversal so rapid clicks do not
// jump back to the beginning. No timers or permanent animation frames.
function cancel(el: Element) {
  const node = el as HTMLElement;
  stopObserving();
  if (!animation) return;
  const height = node.getBoundingClientRect().height;
  const opacity = getComputedStyle(node).opacity;
  animation.cancel();
  animation = undefined;
  interrupted = true;
  node.style.height = `${height}px`;
  node.style.opacity = opacity;
}

// Capture the current frame before v-show hides the element during leave cancellation.
// At leave-cancelled time its bounding box can already be zero.
watch(() => props.open, () => {
  if (target && animation) cancel(target);
}, { flush: 'sync' });

// A drag switches the card to an explicit height; release the animated style
// after Vue applies that height so the handle tracks the pointer immediately.
watch(() => props.height, () => updateHeightMode?.(), { flush: 'post' });

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
  const reversing = interrupted;
  interrupted = false;
  target = node;
  const from = node.getBoundingClientRect().height;
  const opacity = getComputedStyle(node).opacity;
  // Measure natural content, not the clipped/animated parent.
  const content = node.firstElementChild as HTMLElement;
  const fullHeight = props.height ?? (opening || reversing ? content.scrollHeight : from);
  let to = opening ? fullHeight : 0;
  const distance = Math.abs(to - from);
  if (distance < 1 && Math.abs(Number(opacity) - Number(opening)) < .02) {
    restoreHeight(node);
    done();
    return;
  }
  // A second click only animates the remaining travel, even for nested groups.
  const fullDuration = opening ? 280 : 210;
  const fraction = Math.min(1, distance / Math.max(1, fullHeight, from));
  const duration = reversing ? Math.max(65, fullDuration * Math.sqrt(fraction)) : fullDuration;
  const keyframes = (height: number) => [
    { height: `${from}px`, opacity },
    { height: `${height}px`, opacity: opening ? 1 : 0 },
  ];
  animation = node.animate(keyframes(to), { duration, easing: "cubic-bezier(.22,1,.36,1)", fill: "both" });
  const current = animation;
  const finish = () => {
    if (animation !== current) return;
    stopObserving();
    restoreHeight(node);
    animation = undefined;
    current.cancel();
    done();
  };
  current.onfinish = finish;
  if (opening) {
    const followContent = () => {
      if (animation !== current) return;
      const nextHeight = content.scrollHeight;
      if (nextHeight === to) return;
      const effect = current.effect as KeyframeEffect;
      const progress = effect.getComputedTiming().progress ?? 0;
      const frames: Keyframe[] = keyframes(nextHeight);
      if (progress > 0 && progress < 1) {
        // Changing just the endpoint also changes the frame already on screen.
        // Anchor it at the eased progress; keep the original finish time.
        frames.splice(1, 0, { offset: progress, height: `${node.getBoundingClientRect().height}px`, opacity: getComputedStyle(node).opacity });
      }
      effect.setKeyframes(frames);
      to = nextHeight;
    };
    const observeContent = () => {
      resizeObserver = new ResizeObserver(followContent);
      resizeObserver.observe(content);
    };
    updateHeightMode = () => {
      if (props.height !== undefined) finish();
      else { observeContent(); followContent(); }
    };
    if (props.height === undefined) observeContent();
  }
}

onBeforeUnmount(() => {
  stopObserving();
  animation?.cancel();
  animation = undefined;
  if (target) { target.style.height = ""; target.style.opacity = ""; }
});
</script>

<template>
  <Transition :css="false" @before-enter="beforeEnter" @enter="(el, done) => move(el, done, true)"
    @after-enter="(el) => emit('shown', el)" @leave="(el, done) => move(el, done, false)" @enter-cancelled="cancel" @leave-cancelled="cancel">
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
