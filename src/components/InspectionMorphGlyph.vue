<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';

const props = defineProps<{ cube: boolean }>();
const progress = ref(props.cube ? 1 : 0);
let goal = progress.value, velocity = 0, last = 0, frame = 0;

// Exact damped spring step: a reversal inherits the current position and speed.
function advance(now: number) {
  // Opening inspection can occupy the UI thread. Never skip an entire pose
  // change just because a frame arrived late.
  const dt = Math.min(now - last, 48) / 1000;
  last = now;
  const rate = 16, offset = progress.value - goal;
  const slope = velocity + rate * offset, decay = Math.exp(-rate * dt);
  progress.value = goal + (offset + slope * dt) * decay;
  velocity = (velocity - rate * slope * dt) * decay;
}
function tick(now: number) {
  advance(Math.max(now, last));
  if (Math.abs(progress.value - goal) < .001 && Math.abs(velocity) < .025) {
    progress.value = goal;
    velocity = frame = 0;
  } else frame = requestAnimationFrame(tick);
}
watch(() => props.cube, cube => {
  // Retarget the last drawn pose, even if view setup delayed this event.
  last = performance.now();
  goal = cube ? 1 : 0;
  if (!frame) frame = requestAnimationFrame(tick);
});
onBeforeUnmount(() => cancelAnimationFrame(frame));

// Project the very same board in both views. Its three visible corners are
// also the origins of the side edges, including at every intermediate angle.
const pose = computed(() => {
  const t = progress.value, theta = t * Math.PI / 4;
  const xScale = 1 + (Math.SQRT1_2 - 1) * t;
  const yScale = 1 + (Math.SQRT2 * 3.6 / 13 - 1) * t;
  const a = Math.cos(theta) * xScale, b = Math.sin(theta) * yScale;
  const c = -Math.sin(theta) * xScale, d = Math.cos(theta) * yScale;
  const midY = 9 - 3.8 * t, depth = 7.2 * t * t * (3 - 2 * t);
  const corner = (u: number, v: number, down = 0) => `${9 + a*u + c*v} ${midY + b*u + d*v + down}`;
  const h = 6.5;
  return {
    matrix: `matrix(${a} ${b} ${c} ${d} 9 ${midY})`, radius: 1.8 - 1.45 * t,
    sides: `M${corner(-h,h)}v${depth}L${corner(h,h,depth)}L${corner(h,-h,depth)}v${-depth}M${corner(h,h)}v${depth}`,
    sideOpacity: Math.min(1, depth / 2.5), padsOpacity: (1 - t) ** 2,
    topTint: .1 * t,
  };
});
</script>

<template>
  <g class="inspection-glyph">
    <path :d="pose.sides" :opacity="pose.sideOpacity" />
    <g :transform="pose.matrix">
      <rect x="-6.5" y="-6.5" width="13" height="13" :rx="pose.radius" fill="currentColor"
        :fill-opacity="pose.topTint" vector-effect="non-scaling-stroke" />
      <path d="M-3.6-3.6h2.7v2.7h-2.7zM.9-3.6h2.7v2.7H.9zM-3.6.9h2.7v2.7h-2.7zM.9.9h2.7v2.7H.9z"
        fill="currentColor" stroke="none" :opacity="pose.padsOpacity" />
    </g>
  </g>
</template>
