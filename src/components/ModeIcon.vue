<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue';

const props = withDefaults(defineProps<{
  kind: 'jig' | 'stencil'; active: boolean; delay?: number; animated?: boolean;
}>(), { delay: 0, animated: true });
const icon = ref<SVGSVGElement | null>(null);
const animations = new Set<Animation>();
type Pose = { transform: string; opacity: string };

function interrupt() {
  const poses = new Map<Element, Pose>();
  // Sample before cancelling so a quick reversal continues from the visible
  // pose instead of snapping an unfinished icon back to its first frame.
  for (const animation of animations) {
    const target = (animation.effect as KeyframeEffect | null)?.target;
    if (target) {
      const style = getComputedStyle(target);
      poses.set(target, { transform: style.transform, opacity: style.opacity });
    }
  }
  for (const animation of animations) animation.cancel();
  animations.clear();
  return poses;
}

function play(target: Element, frames: Keyframe[], duration: number, delay = 0) {
  const staged = frames.length > 2;
  // Keep expansion/settling peaks at their authored times. Applying one
  // strong ease-out to the entire sequence would compress the lift into a jerk.
  const timeline = staged
    ? frames.map(frame => ({ ...frame, easing: 'cubic-bezier(.3, 0, .25, 1)' }))
    : frames;
  const animation = target.animate(timeline, {
    duration, delay, easing: staged ? 'linear' : 'cubic-bezier(.22, 1, .36, 1)', fill: 'both',
  });
  animations.add(animation);
  animation.onfinish = () => { animations.delete(animation); animation.cancel(); };
}

watch(() => props.active, active => {
  const poses = interrupt();
  const root = icon.value;
  if (!root || !props.animated) return;

  if (!active || poses.size) {
    // Reversals settle directly from their visible pose. Replaying the cold
    // expansion would introduce another anticipation movement on every click.
    const targets = new Set([...poses.keys(), ...root.querySelectorAll('.aperture')]);
    for (const target of targets) {
      const aperture = target.classList.contains('aperture');
      const pose = poses.get(target) ?? {
        transform: 'none', opacity: aperture && active ? '.64' : '1',
      };
      play(target, [
        { transform: pose.transform, opacity: pose.opacity },
        { transform: 'none', opacity: aperture && !active ? .64 : 1 },
      ], active ? 200 : 180);
    }
    return;
  }

  const shell = root.querySelector('.motion-shell')!;
  const delay = props.delay;
  if (props.kind === 'jig') {
    play(shell, [
      { transform: 'none' },
      { transform: 'translateY(-.7px)', offset: .32 },
      { transform: 'none' },
    ], 500, delay);
    const top = root.querySelector('.layer-top')!;
    const middle = root.querySelector('.layer-middle')!;
    play(top, [
      { transform: 'none' },
      { transform: 'translateY(-3px)', offset: .32 },
      { transform: 'translateY(.3px)', offset: .74 },
      { transform: 'none' },
    ], 540, delay);
    play(middle, [
      { transform: 'none' },
      { transform: 'translateY(-1.3px)', offset: .36 },
      { transform: 'translateY(.15px)', offset: .76 },
      { transform: 'none' },
    ], 510, delay);
  } else {
    play(shell, [
      { transform: 'none' },
      { transform: 'translateY(-.5px)', offset: .32 },
      { transform: 'none' },
    ], 480, delay);
    const frame = root.querySelector('.stencil-frame')!;
    play(frame, [
      { transform: 'none' },
      { transform: 'rotate(-4deg)', offset: .3 },
      { transform: 'rotate(.5deg)', offset: .74 },
      { transform: 'none' },
    ], 480, delay);
    root.querySelectorAll('.aperture').forEach((target, index) => {
      const x = index % 2 === 0 ? 1.3 : -1.3;
      const y = index < 2 ? 1.3 : -1.3;
      play(target, [
        { transform: 'none', opacity: .64 },
        { transform: `translate(${x}px, ${y}px) scale(.55)`, opacity: .4, offset: .18 },
        { transform: 'scale(1.12)', opacity: 1, offset: .58 },
        { transform: 'scale(.985)', opacity: 1, offset: .84 },
        { transform: 'none', opacity: 1 },
      ], 380, delay + 40 + index * 35);
    });
  }
}, { flush: 'post' });

onBeforeUnmount(() => { for (const animation of animations) animation.cancel(); animations.clear(); });
</script>

<template>
  <svg ref="icon" class="mode-icon" :class="{ 'is-active': active }" viewBox="0 0 20 20"
    fill="none" aria-hidden="true">
    <g class="motion-shell">
      <template v-if="kind === 'jig'">
        <g class="layer-base"><path d="m3 13.5 7 3.7 7-3.7" /></g>
        <g class="layer-middle"><path d="m3 9.8 7 3.7 7-3.7" /></g>
        <g class="layer-top"><path class="layer-face" d="m3 6.1 7-3.7 7 3.7-7 3.7z" /></g>
      </template>
      <template v-else>
        <g class="stencil-frame"><rect x="2.5" y="2.5" width="15" height="15" rx="2.7" /></g>
        <rect class="aperture" x="6" y="6" width="2.5" height="2.5" rx=".45" />
        <rect class="aperture" x="11.5" y="6" width="2.5" height="2.5" rx=".45" />
        <rect class="aperture" x="6" y="11.5" width="2.5" height="2.5" rx=".45" />
        <rect class="aperture" x="11.5" y="11.5" width="2.5" height="2.5" rx=".45" />
      </template>
    </g>
  </svg>
</template>

<style scoped>
.mode-icon { display: block; width: 20px; height: 20px; flex-shrink: 0; overflow: visible; }
.mode-icon g { transform-origin: 10px 10px; }
.mode-icon path, .stencil-frame rect { stroke: currentColor; stroke-width: 1.45; stroke-linecap: round; stroke-linejoin: round; }
.layer-face { fill: currentColor; fill-opacity: .08; }
.aperture { fill: currentColor; opacity: .64; transform-box: fill-box; transform-origin: center; }
.is-active .aperture { opacity: 1; }
</style>
