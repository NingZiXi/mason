<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useUiStore } from '../stores/ui';

const { t } = useI18n();
const ui = useUiStore();
const symbol = ref<SVGGElement | null>(null);
const pulses = ref<SVGGElement | null>(null);
const startNode = ref<SVGGElement | null>(null);
const endNode = ref<SVGGElement | null>(null);
const logo = ref<HTMLButtonElement | null>(null);
const fireworks = ref<HTMLElement | null>(null);
const animations = new Map<Element, Animation>();
const pulseCount = 6;
const confettiCount = 28;
let nextPulse = 0;
let clickCount = 0;
let lastClickAt = 0;
const route = 'M14 14 L50 14 L50 26 L26 26 L26 38 L50 38 L50 50 L14 50';

function registerClick() {
  if (ui.skinCelebrationActive) {
    clickCount = 0;
    lastClickAt = 0;
    return;
  }
  const now = performance.now();
  clickCount = now - lastClickAt > 2400 ? 1 : clickCount + 1;
  lastClickAt = now;
  if (clickCount === 10) {
    clickCount = 0;
    if (ui.beginSkinCelebration()) burst();
  }
}

function stopBurst() {
  const root = fireworks.value;
  if (root) {
    for (const element of [root, ...root.querySelectorAll('*')]) cancel(element);
    root.dataset.active = 'false';
  }
  window.removeEventListener('resize', stopBurst);
}

function burst() {
  const root = fireworks.value, button = logo.value;
  if (!root || !button || typeof root.animate !== 'function') return;
  stopBurst();
  const rect = button.getBoundingClientRect();
  const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
  // The real Logo is the launch point, independent of header clipping or scroll.
  root.style.left = `${x}px`;
  root.style.top = `${y}px`;
  const colors = ui.skinCelebrationTarget === 'sakura'
    ? ['#D85C8A', '#4169D8', '#EDA6C2', '#8CA8F2']
    : ['#3E7D62', '#E07A3C', '#91BDA4', '#F1B58E'];
  root.style.setProperty('--firework-primary', colors[0]);
  root.style.setProperty('--firework-accent', colors[1]);
  root.dataset.active = 'true';
  window.addEventListener('resize', stopBurst, { passive: true });

  // Fan slightly into the available workspace, so a corner Logo still gets a
  // full, readable burst instead of losing most of its paper above the window.
  const nearEdge = Math.min(x, y, innerWidth - x, innerHeight - y) < 120;
  const heading = Math.atan2(innerHeight / 2 - y, innerWidth / 2 - x);
  root.querySelectorAll<HTMLElement>('.brand-confetti').forEach((piece, index) => {
    const spread = nearEdge ? 2.7 : Math.PI * 2;
    const angle = heading + (index / (confettiCount - 1) - .5) * spread;
    const distance = 50 + (index * 17 % 59);
    const dx = Math.cos(angle) * distance, dy = Math.sin(angle) * distance;
    const rotation = index * 47;
    const turn = (index % 2 ? 1 : -1) * (220 + index * 13);
    piece.style.background = colors[index % colors.length];
    const pose = (progress: number, fall: number, scale: number) =>
      `translate3d(${dx * progress}px, ${dy * progress + fall}px, 0) rotate(${rotation + turn * progress}deg) scale(${scale})`;
    play(piece, [
      { transform: pose(0, 0, .2), opacity: 0 },
      { transform: pose(.26, -5, 1), opacity: 1, offset: .12 },
      { transform: pose(.78, -8, 1), opacity: 1, offset: .4 },
      { transform: pose(.96, 9, .9), opacity: .95, offset: .72 },
      { transform: pose(1.06, 35, .65), opacity: 0 },
    ], 1000 + index % 5 * 65, index % 4 * 16);
  });
  root.querySelectorAll<HTMLElement>('.brand-burst-ring').forEach((ring, index) => {
    play(ring, [
      { transform: 'scale(.35)', opacity: 0 },
      { opacity: .8, offset: .12 },
      { transform: `scale(${index ? 3 : 3.8})`, opacity: 0 },
    ], 620, index * 75, 'cubic-bezier(.16, 1, .3, 1)');
  });
  // A finite root animation owns cleanup; no persistent RAF or particle timer.
  play(root, [{ opacity: 1 }, { opacity: 1 }], 1400, 0, 'linear', stopBurst);
}

function cancel(element: Element) {
  animations.get(element)?.cancel();
  animations.delete(element);
}

function play(element: Element, frames: Keyframe[], duration: number, delay = 0,
  easing = 'linear', onComplete?: () => void) {
  cancel(element);
  const staged = frames.length > 2 && easing !== 'linear';
  const timeline = staged ? frames.map(frame => ({ ...frame, easing })) : frames;
  const animation = element.animate(timeline, { duration, delay,
    easing: staged ? 'linear' : easing, fill: 'both' });
  animations.set(element, animation);
  animation.onfinish = () => {
    if (animations.get(element) !== animation) return;
    animations.delete(element);
    animation.cancel();
    onComplete?.();
  };
}

function illuminate() {
  if (!symbol.value || !pulses.value || !startNode.value || !endNode.value) return;
  registerClick();

  // Every click responds from the current pose. In-flight signals keep
  // travelling instead of blocking input or jumping back to the start.
  play(symbol.value, [
    { transform: getComputedStyle(symbol.value).transform },
    { transform: 'scale(.94)', offset: .2 },
    { transform: 'scale(1.025)', offset: .62 },
    { transform: 'none' },
  ], 230, 0, 'cubic-bezier(.22, .8, .3, 1)');
  play(startNode.value, [
    { transform: getComputedStyle(startNode.value).transform },
    { transform: 'scale(1.24)', offset: .35 }, { transform: 'none' },
  ], 170, 0, 'cubic-bezier(.22, .8, .3, 1)');

  // Reuse a bounded pool. Rapid clicks recycle only the oldest pulse,
  // with no growing DOM, animation queue, or delayed input response.
  const slot = pulses.value.children[nextPulse];
  nextPulse = (nextPulse + 1) % pulseCount;
  const trail = slot.querySelector('.brand-trail')!;
  const signal = slot.querySelector('.brand-signal')!;
  const ring = slot.querySelector('.brand-ring')!;
  for (const element of [trail, signal, ring]) cancel(element);

  play(trail, [
    { strokeDashoffset: '14', opacity: 0 },
    { opacity: .8, offset: .06 },
    { opacity: .8, offset: .9 },
    { strokeDashoffset: '-86', opacity: 0 },
  ], 760);

  // The head follows the same polyline at constant speed. These finite
  // keyframes need no timer or permanent animation loop.
  const vertices = [[14, 14], [50, 14], [50, 26], [26, 26], [26, 38], [50, 38], [50, 50], [14, 50]];
  let distance = 0;
  const frames: Keyframe[] = vertices.map(([x, y], index) => {
    if (index) distance += Math.hypot(x - vertices[index - 1][0], y - vertices[index - 1][1]);
    return { transform: `translate(${x}px, ${y}px)`, opacity: index === 0 || index === vertices.length - 1 ? 0 : 1,
      offset: distance / 156 };
  });
  play(signal, frames, 760, 0, 'linear', () => {
    const node = endNode.value;
    if (!node) return;
    play(node, [
      { transform: getComputedStyle(node).transform },
      { transform: 'scale(1.4)', offset: .32 },
      { transform: 'scale(.96)', offset: .7 },
      { transform: 'none' },
    ], 280, 0, 'cubic-bezier(.22, .8, .3, 1)');
    play(ring, [
      { transform: 'scale(.65)', opacity: 0 },
      { opacity: .65, offset: .16 },
      { transform: 'scale(1.55)', opacity: 0 },
    ], 320, 0, 'cubic-bezier(.22, 1, .36, 1)');
  });
}

onBeforeUnmount(() => {
  stopBurst();
  for (const animation of animations.values()) animation.cancel();
  animations.clear();
});
</script>

<template>
  <button ref="logo" type="button" class="brand-logo" :title="t('app.logoInteraction')"
    :aria-label="t('app.logoInteraction')" @click="illuminate" @dblclick.stop>
    <svg class="brand-mark" viewBox="0 0 64 64" fill="none" aria-hidden="true">
      <g ref="symbol" class="brand-symbol">
        <path :d="route" class="brand-trace" />
        <g ref="startNode" class="brand-start"><circle cx="14" cy="14" r="5" /></g>
        <g ref="endNode" class="brand-end"><circle cx="14" cy="50" r="5" /></g>
        <g ref="pulses" class="brand-pulses">
          <g v-for="pulse in pulseCount" :key="pulse" class="brand-pulse">
            <path :d="route" class="brand-trail" pathLength="100"
              stroke-dasharray="14 114" stroke-dashoffset="14" />
            <circle class="brand-signal" r="2.3" />
            <circle class="brand-ring" cx="14" cy="50" r="7" />
          </g>
        </g>
      </g>
    </svg>
  </button>
  <Teleport to="body">
    <div ref="fireworks" class="brand-fireworks" aria-hidden="true" data-active="false">
      <i class="brand-burst-ring" /><i class="brand-burst-ring is-accent" />
      <i v-for="piece in confettiCount" :key="piece" class="brand-confetti"
        :class="piece % 7 === 0 ? 'is-star' : piece % 3 === 0 ? 'is-dot' : 'is-paper'" />
    </div>
  </Teleport>
</template>

<style scoped>
.brand-logo {
  --button-press-scale: .96;
  position: relative;
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  flex-shrink: 0;
  margin: -4px;
  padding: 4px;
  border: 0;
  border-radius: calc(var(--radius-control) + 4px);
  corner-shape: var(--corner-shape);
  background: var(--status-success-surface-l1);
  cursor: pointer;
}
.brand-mark {
  display: block;
  width: 28px;
  height: 28px;
  overflow: visible;
  pointer-events: none;
  transition: transform 220ms var(--ease-out);
}
.brand-symbol { transform-origin: 32px 32px; opacity: 1; transition: opacity 160ms var(--ease-out); }
.brand-trace, .brand-trail { stroke-width: 6; stroke-linecap: round; stroke-linejoin: round; }
.brand-trace { stroke: var(--bg-brand); }
.brand-trail { stroke: var(--brand-accent); opacity: 0; }
.brand-start { fill: var(--bg-brand); transform-origin: 14px 14px; }
.brand-end { fill: var(--brand-accent); transform-origin: 14px 50px; }
.brand-signal { fill: var(--surface-raised); opacity: 0; }
.brand-ring { stroke: var(--brand-accent); stroke-width: 2; opacity: 0; transform-origin: 14px 50px; }
.brand-fireworks {
  position: fixed;
  left: 0;
  top: 0;
  width: 1px;
  height: 1px;
  z-index: 4300;
  overflow: visible;
  opacity: 0;
  pointer-events: none;
  view-transition-name: mason-logo-fireworks;
}
.brand-confetti { position: absolute; left: -2px; top: -4px; width: 4px; height: 8px; border-radius: 1px; opacity: 0; }
.brand-confetti.is-paper:nth-child(2n) { width: 5px; height: 9px; }
.brand-confetti.is-dot { left: -2px; top: -2px; width: 4px; height: 4px; border-radius: 50%; }
.brand-confetti.is-star { left: -5px; top: -5px; width: 10px; height: 10px; clip-path: polygon(50% 0, 61% 36%, 100% 50%, 61% 61%, 50% 100%, 39% 61%, 0 50%, 39% 36%); }
.brand-burst-ring { position: absolute; left: -11px; top: -11px; width: 22px; height: 22px; border: 1.5px solid var(--firework-primary); border-radius: 50%; opacity: 0; }
.brand-burst-ring.is-accent { border-color: var(--firework-accent); border-width: 1px; }
@media (hover: hover) and (pointer: fine) {
  .brand-logo:hover { background: color-mix(in srgb, var(--bg-brand) 17%, transparent); }
  .brand-logo:hover .brand-mark { transform: translateY(-.5px); }
}
.brand-logo:focus-visible { outline: 2px solid var(--bg-brand); outline-offset: 2px; }
</style>

<style>
/* Keep this burst live above the makeover rather than frozen into its snapshot. */
html::view-transition-group(mason-logo-fireworks) { z-index: 3; animation: none; }
html::view-transition-old(mason-logo-fireworks) { display: none; }
html::view-transition-new(mason-logo-fireworks) { animation: none; mix-blend-mode: normal; }
</style>
