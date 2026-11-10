<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useUiStore } from '../stores/ui';
import { findCelebrationSurface, findCelebrationTarget, type CelebrationSurface } from '../lib/celebration-layout';
import { celebrationClipPath } from '../lib/celebration-reveal';

const ui = useUiStore();
const { t } = useI18n();
// Keep one destination for the whole scene: preview and skip may both apply
// it, but must never toggle back after the first coat has been painted.
const targetSkin = ui.skinCelebrationTarget;
const paintingSakura = targetSkin === 'sakura';
const scene = ref<HTMLElement | null>(null);
const resultCard = ref<HTMLDialogElement | null>(null);
const phase = ref<'painting' | 'result'>('painting');
const resultFallback = ref(false);
const animations = new Set<Animation>();
const timers = new Set<ReturnType<typeof setTimeout>>();
const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
let disposed = false;
let openingResult = false;
let transition: ViewTransition | null = null;
let clipStyle: HTMLStyleElement | null = null;
let revealFrame = 0;
let sceneStartedAt: number | null = null;
let sceneClock: Animation | null = null;
let launchOrigin: Point | null = null;

type Point = { x: number; y: number };
type Job = {
  actor: number;
  kind: 'paint' | 'edge' | 'accent';
  rect: CelebrationSurface['rect'];
  points: Point[];
  width: number;
  start: number;
  duration: number;
};
const jobs = ref<Job[]>([]);
// The crew paints actual panel bounds and carries accents into place. The
// temporary layers never dispatch clicks, focus or changes to project data.
const actors = paintingSakura ? [
  { color: '#D85C8A', ink: '#251820', outline: '#8F385A', name: 'Sakura' },
  { color: '#E49AB5', ink: '#583044', outline: '#A35D79', name: 'Mochi' },
  { color: '#D85C8A', ink: '#FFFFFF', outline: '#F3D9E4', name: 'Peach' },
  { color: '#4169D8', ink: '#FFFFFF', outline: '#D8E1FF', name: 'Soda' },
  { color: '#4169D8', ink: '#FFFFFF', outline: '#D8E1FF', name: 'Bubbles' },
  { color: '#AD3E69', ink: '#FFFFFF', outline: '#F3D9E4', name: 'Momo' },
] as const : [
  { color: '#3E7D62', ink: '#FFFFFF', outline: '#DCEBE2', name: 'Sakura' },
  { color: '#82B39A', ink: '#203D2D', outline: '#456D56', name: 'Mochi' },
  { color: '#3E7D62', ink: '#FFFFFF', outline: '#DCEBE2', name: 'Peach' },
  { color: '#E07A3C', ink: '#FFFFFF', outline: '#FBE4D6', name: 'Soda' },
  { color: '#E07A3C', ink: '#FFFFFF', outline: '#FBE4D6', name: 'Bubbles' },
  { color: '#2E624B', ink: '#FFFFFF', outline: '#DCEBE2', name: 'Momo' },
] as const;
const celebrationStyle = {
  '--celebration-color': actors[0].color,
  '--celebration-accent': actors[3].color,
  '--celebration-soft': paintingSakura ? '#F3D9E4' : '#82B39A',
};

function buildJobs() {
  launchOrigin = findCelebrationTarget(['.brand-logo'])?.point ?? null;
  const header = findCelebrationSurface(['.app-header']);
  const sidebar = findCelebrationSurface(['.app-sidebar']);
  const preview = findCelebrationSurface(['.preview-overlays', '.canvas-container']);
  if (header) {
    const rect = header.rect;
    jobs.value.push({ actor: 0, kind: 'paint', rect, width: rect.height * .88,
      points: [{ x: 18, y: rect.height / 2 }, { x: rect.width - 18, y: rect.height / 2 }],
      start: 680, duration: 1600 });
  }
  if (sidebar) {
    const rect = sidebar.rect, gap = Math.min(75, rect.height / 7);
    // Broad, overlapping roller passes follow the visible sidebar only.
    const points: Point[] = [];
    const rows = Math.max(2, Math.ceil((rect.height - gap) / (gap * 1.6)));
    for (let row = 0; row < rows; row++) {
      const y = gap / 2 + row * (rect.height - gap) / (rows - 1);
      points.push({ x: row % 2 ? rect.width - 24 : 24, y }, { x: row % 2 ? 24 : rect.width - 24, y });
    }
    jobs.value.push({ actor: 1, kind: 'paint', rect, points, width: gap * 1.8, start: 1000, duration: 2350 });
  }
  if (preview) {
    const rect = { ...preview.rect };
    // The WebGL canvas extends behind the sidebar; use its exposed workspace.
    if (sidebar) {
      const left = Math.max(rect.left, sidebar.rect.left + sidebar.rect.width);
      rect.width -= left - rect.left;
      rect.left = left;
    }
    if (rect.width >= 100 && rect.height >= 100) {
      const x = 18, y = 18, right = rect.width - x, bottom = rect.height - y, middle = rect.width / 2, r = 18;
      for (const [actor, edge, bend] of [[2, x, x + r], [3, right, right - r]] as const) {
        const direction = actor === 2 ? 1 : -1;
        // Short arc segments keep both the moving tip and the drawn corners
        // rounded without giving their timelines different path lengths.
        const topArc = [3, 2, 1, 0].map(step => {
          const angle = step * Math.PI / 8;
          return { x: edge + direction * r * (1 - Math.cos(angle)), y: y + r * (1 - Math.sin(angle)) };
        });
        const bottomArc = [1, 2, 3, 4].map(step => {
          const angle = step * Math.PI / 8;
          return { x: edge + direction * r * (1 - Math.cos(angle)), y: bottom - r + r * Math.sin(angle) };
        });
        jobs.value.push({ actor, kind: 'edge', rect, width: 3,
          points: [{ x: middle, y }, { x: bend, y }, ...topArc,
            { x: edge, y: bottom - r }, ...bottomArc, { x: middle, y: bottom }],
          start: 1450, duration: 2000 });
      }
    }
  }
  const used = new Set<Element>();
  for (const [actor, selectors] of [
    [4, ['.export-default', '.brand-logo']],
    [5, ['.mode-switch .mode-btn.active', '.config-presets .el-select__wrapper', '.settings-btn']],
  ] as const) {
    const target = findCelebrationTarget(selectors, used);
    if (!target) continue;
    used.add(target.element);
    const rect = target.element.getBoundingClientRect();
    jobs.value.push({ actor, kind: 'accent', rect, width: 0,
      points: [{ x: rect.width / 2, y: rect.height / 2 }], start: 3050 + (actor - 4) * 240, duration: 640 });
  }
}

const pathOf = (job: Job) => job.points.map((point, index) => `${index ? 'L' : 'M'}${point.x} ${point.y}`).join(' ');
const jobStyle = (job: Job) => ({ left: `${job.rect.left}px`, top: `${job.rect.top}px`, width: `${job.rect.width}px`, height: `${job.rect.height}px`, '--paint-color': actors[job.actor].color });
const glintStyle = (job: Job) => {
  const point = job.points[job.points.length - 1];
  return { left: `${job.rect.left + point.x}px`, top: `${job.rect.top + point.y}px`, '--cursor-color': actors[job.actor].color };
};

function later(callback: () => void, delay: number) {
  const timer = setTimeout(() => {
    timers.delete(timer);
    if (!disposed) callback();
  }, delay);
  timers.add(timer);
}

function animate(element: Element, frames: Keyframe[], options: KeyframeAnimationOptions) {
  const animation = element.animate(frames, { fill: 'both', ...options });
  if (sceneStartedAt !== null) animation.startTime = sceneStartedAt;
  animations.add(animation);
  animation.onfinish = () => {
    if (options.fill === 'forwards') return;
    animations.delete(animation);
    animation.cancel();
  };
  return animation;
}

function stopScene() {
  timers.forEach(clearTimeout);
  timers.clear();
  animations.forEach(animation => animation.cancel());
  animations.clear();
  cancelAnimationFrame(revealFrame);
  revealFrame = 0;
  sceneClock = null;
  transition?.skipTransition();
  transition = null;
  clipStyle?.remove();
  clipStyle = null;
  window.removeEventListener('resize', onLayoutChange);
  document.removeEventListener('scroll', onLayoutChange, true);
  document.removeEventListener('visibilitychange', onVisibilityChange);
  document.documentElement.classList.remove('skin-renovating');
}

function onLayoutChange() {
  if (phase.value === 'painting') void showResult();
}

function onVisibilityChange() {
  if (document.hidden) onLayoutChange();
}

function decorate(cursor: HTMLElement, layer: HTMLElement, job: Job) {
  const { rect, start, duration, points } = job;
  const first = points[0], last = points[points.length - 1];
  const pose = (point: Point) => `translate3d(${rect.left + point.x - 4}px, ${rect.top + point.y - 3}px, 0)`;
  const entry = launchOrigin
    ? { x: launchOrigin.x - rect.left, y: launchOrigin.y - rect.top }
    : { x: first.x - 80, y: first.y - 90 };
  const entryBend = { x: entry.x + (first.x - entry.x) * .72, y: entry.y + (first.y - entry.y) * .42 };
  // Distance-based timing keeps the brush tip and growing stroke together,
  // including the long vertical legs of the preview frame.
  const lengths = points.map((point, index) => index ? Math.hypot(point.x - points[index - 1].x, point.y - points[index - 1].y) : 0);
  const total = lengths.reduce((sum, length) => sum + length, 0) || 1;
  const whole = 500 + duration + 500;
  let travelled = 0;
  const travelFrames: Keyframe[] = points.map((point, index) => {
    travelled += lengths[index];
    return { transform: pose(point), opacity: 1, offset: (500 + duration * travelled / total) / whole };
  });
  if (job.kind === 'accent') travelFrames.push({ transform: pose(last), opacity: 1, offset: (500 + duration) / whole });
  cursor.classList.toggle('labels-left', rect.left + first.x > innerWidth - 180);
  cursor.classList.toggle('worker-right-edge', job.actor === 3);
  cursor.classList.toggle('bubble-below', rect.top + first.y < 140);
  animate(cursor, [
    { transform: pose(entry), opacity: 0, offset: 0, easing: 'cubic-bezier(.22, 1, .36, 1)' },
    { transform: pose(entryBend), opacity: 1, offset: 300 / whole, easing: 'cubic-bezier(.3, .1, .3, 1)' },
    ...travelFrames,
    { transform: pose(last), opacity: 1, offset: (500 + duration + 160) / whole },
    { transform: pose({ x: last.x + (entry.x - last.x) * .28, y: last.y - 45 }), opacity: 0, offset: 1 },
  ], { duration: whole, delay: start - 500, easing: 'linear' });

  // Keep the actual brush tip on the reveal path. The tool itself settles onto
  // the surface, while the label trails a little as its worker arrives.
  const pointer = cursor.querySelector('.cursor-pointer');
  if (pointer) animate(pointer, [
    { transform: 'rotate(-13deg) scale(.78)' },
    { transform: 'rotate(4deg) scale(1.08)', offset: .62 },
    { transform: 'rotate(0deg) scale(1)' },
  ], { duration: 620, delay: start - 500, easing: 'cubic-bezier(.22, 1, .36, 1)' });
  const tag = cursor.querySelector('.cursor-tag');
  if (tag) animate(tag, [
    { transform: 'translate(-5px, -4px) scale(.88)', opacity: 0 },
    { transform: 'translate(1px, 1px) scale(1.03)', opacity: 1, offset: .7 },
    { transform: 'none', opacity: 1 },
  ], { duration: 420, delay: start - 320, easing: 'cubic-bezier(.22, 1, .36, 1)' });

  if (job.kind === 'accent') {
    // Carry a color chip to the existing control, then press a transparent
    // outline into place so the real label stays legible throughout.
    const swatch = cursor.querySelector('.cursor-swatch');
    if (swatch) animate(swatch, [
      { opacity: 0, transform: 'rotate(-20deg) scale(.6)' },
      { opacity: 1, transform: 'rotate(-10deg) scale(1)', offset: .35 },
      { opacity: 1, transform: 'translate(7px, 7px) rotate(0) scale(.84)', offset: .8 },
      { opacity: 0, transform: 'translate(12px, 12px) scale(.4)' },
    ], { duration: 680, delay: start - 500 });
    animate(layer, [
      { transform: 'scale(.86)', opacity: 0 },
      { transform: 'scale(1.04)', opacity: 1, offset: .38 },
      { transform: 'scale(.99)', opacity: 1, offset: .7 },
      { transform: 'scale(1)', opacity: .8 },
    ], { duration, delay: start, easing: 'cubic-bezier(.22, 1, .36, 1)', fill: 'forwards' });
    if (pointer) animate(pointer, [
      { transform: 'scale(1)' }, { transform: 'scale(.86)', offset: .32 },
      { transform: 'rotate(-6deg) scale(1.08)', offset: .65 }, { transform: 'none' },
    ], { duration: 360, delay: start, easing: 'cubic-bezier(.22, 1, .36, 1)', fill: 'none' });
  } else {
    const stroke = layer.querySelector('.paint-stroke');
    if (stroke) animate(stroke, [{ strokeDashoffset: '1' }, { strokeDashoffset: '0' }], { duration, delay: start, easing: 'linear', fill: 'forwards' });
    const tool = cursor.querySelector('.cursor-tool');
    if (tool) animate(tool, [
      { opacity: 0, scale: '.65' }, { opacity: 1, scale: '1.12', offset: .05 },
      { opacity: 1, scale: '1', offset: .1 }, { opacity: 1, offset: .9 }, { opacity: 0, scale: '.8' },
    ], { duration: duration + 200, delay: start - 100 });
  }
  // A small completion glint anchors each job to its actual surface. Bounded
  // transform/opacity animations add contact without another canvas or RAF.
  cursor.parentElement?.querySelectorAll<HTMLElement>(`[data-spark-actor="${job.actor}"] .cursor-spark`).forEach((spark, index) => {
    const angle = (-145 + index * 95) * Math.PI / 180;
    const distance = job.kind === 'accent' ? 29 : 21;
    const x = Math.cos(angle) * distance, y = Math.sin(angle) * distance;
    animate(spark, [
      { transform: 'translate(0, 0) scale(.2)', opacity: 0 },
      { transform: `translate(${x * .45}px, ${y * .45}px) scale(1.15)`, opacity: 1, offset: .24 },
      { transform: `translate(${x}px, ${y}px) scale(.55)`, opacity: 0 },
    ], { duration: 460, delay: start + duration + 20 + index * 35, easing: 'cubic-bezier(.16, 1, .3, 1)' });
  });
  // Keep completed paint on the window until the crew's final tidy-up.
  animate(layer, [{ opacity: 1 }, { opacity: 1, offset: .75 }, { opacity: 0 }], { duration: 700, delay: 4100, fill: 'forwards' });
  const bubble = cursor.querySelector('.cursor-bubble');
  if (bubble) animate(bubble, [
    { opacity: 0, transform: 'translateY(4px) scale(.96)' },
    { opacity: 1, transform: 'none', offset: .16 },
    { opacity: 1, offset: .75 }, { opacity: 0, transform: 'translateY(-3px)' },
  ], { duration: 1100, delay: start + 100 });
}

async function prepareReveal() {
  if (disposed || openingResult || phase.value !== 'painting') return false;
  if (typeof document.startViewTransition !== 'function') return false;
  // Browser snapshots preserve every old pixel, including WebGL, gradients,
  // shadows and pseudo-elements. The live new view is exposed only where a
  // worker has painted; a selected list of frozen control colors cannot do it.
  document.documentElement.classList.add('skin-renovating');
  clipStyle = document.createElement('style');
  clipStyle.textContent = "html::view-transition-new(mason-workspace) { clip-path: path('M0 0Z'); }";
  document.head.append(clipStyle);
  try {
    const current = document.startViewTransition(async () => {
      if (disposed || openingResult) return;
      ui.previewCelebrationSkin();
      await nextTick();
    });
    transition = current;
    // A skipped transition can reject ready; both promises are handled even
    // when Escape or an unmount interrupts the capture before it finishes.
    void current.finished.catch(() => {});
    await current.ready;
    return !disposed && !openingResult && phase.value === 'painting';
  } catch {
    // An interrupted capture was already cleaned by stopScene(). Its pending
    // promise must not touch a subsequent celebration's global styling.
    if (disposed || openingResult || phase.value !== 'painting') return false;
    transition?.skipTransition();
    transition = null;
    clipStyle?.remove();
    clipStyle = null;
    document.documentElement.classList.remove('skin-renovating');
    // Older WebViews finish the makeover together instead of changing all
    // unpainted controls at the start of the scene.
    if (!disposed && !openingResult) ui.setSkin(ui.skinBeforeCelebration);
    return false;
  }
}

function updateReveal() {
  if (!clipStyle?.sheet || !sceneClock || disposed || openingResult) return;
  const rule = clipStyle.sheet.cssRules[0] as CSSStyleRule;
  rule.style.clipPath = celebrationClipPath(jobs.value, Number(sceneClock.currentTime ?? 0), { width: innerWidth, height: innerHeight });
  revealFrame = requestAnimationFrame(updateReveal);
}

async function openResult() {
  await nextTick();
  for (let attempt = 0; attempt < 3 && !disposed; attempt++) {
    const card = resultCard.value;
    if (card?.isConnected) {
      if (card.open && card.matches(':modal')) return;
      try {
        if (card.open) card.close();
        card.showModal();
        if (card.open) return;
      } catch { /* Retry after layout, then show the visible fallback below. */ }
    }
    await new Promise(resolve => setTimeout(resolve, 32));
  }
  if (disposed || !resultCard.value) return;
  resultFallback.value = true;
  resultCard.value.open = true;
  await nextTick();
  resultCard.value.querySelector<HTMLButtonElement>('.skin-keep')?.focus();
}

async function showResult() {
  if (disposed || openingResult || phase.value === 'result') return;
  openingResult = true;
  const current = transition;
  stopScene();
  // View-transition snapshots paint above dialogs. Release that layer before
  // opening the result, including when the user skips during initial capture.
  if (current) await current.finished.catch(() => {});
  if (disposed) return;
  ui.previewCelebrationSkin();
  phase.value = 'result';
  await openResult();
  openingResult = false;
}

function finish() {
  resultCard.value?.close();
  ui.endSkinCelebration(true);
  if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Tab' && resultFallback.value && phase.value === 'result') {
    const buttons = [...resultCard.value?.querySelectorAll<HTMLButtonElement>('button') ?? []];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    event.preventDefault();
    buttons[(index + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length]?.focus();
    return;
  }
  if (event.key !== 'Escape') return;
  event.preventDefault();
  event.stopImmediatePropagation();
  if (event.repeat || openingResult) return;
  if (phase.value === 'painting') void showResult();
  else finish();
}

onMounted(async () => {
  document.addEventListener('keydown', onKeydown, true);
  const root = scene.value;
  if (!root || typeof root.animate !== 'function') {
    void showResult();
    return;
  }

  // Always reach the result even if a browser capture fails to become ready.
  later(() => void showResult(), 6500);
  buildJobs();
  await nextTick();
  if (disposed || openingResult || phase.value !== 'painting') return;
  window.addEventListener('resize', onLayoutChange);
  document.addEventListener('scroll', onLayoutChange, true);
  document.addEventListener('visibilitychange', onVisibilityChange);
  const revealing = await prepareReveal();
  if (disposed || openingResult || phase.value !== 'painting') return;
  sceneStartedAt = Number(document.timeline.currentTime ?? performance.now());
  if (revealing) {
    sceneClock = animate(document.documentElement, [{ opacity: 1 }, { opacity: 1 }], {
      duration: 6000, pseudoElement: '::view-transition-old(mason-workspace)', easing: 'linear',
    });
    updateReveal();
  }
  root.querySelectorAll<HTMLElement>('.soda-cursor').forEach((cursor, index) => {
    const layer = root.querySelector<HTMLElement>(`[data-paint-layer="${index}"]`);
    if (layer) decorate(cursor, layer, jobs.value[index]);
  });
  const caption = root.parentElement?.querySelector('.painting-caption');
  if (caption) {
    animate(caption, [
      { opacity: 0, transform: 'translateY(10px) scale(.96)' },
      { opacity: 1, transform: 'none', offset: .09 },
      { opacity: 1, transform: 'none', offset: .94 },
      { opacity: 0, transform: 'translateY(-4px) scale(.98)' },
    ], { duration: 4900, easing: 'linear', fill: 'forwards' });
    const progress = caption.querySelector('.painting-progress-fill');
    if (progress) animate(progress, [
      { transform: 'scaleX(0)' }, { transform: 'scaleX(.12)', offset: .15 },
      { transform: 'scaleX(.78)', offset: .72 }, { transform: 'scaleX(1)' },
    ], { duration: 4800, easing: 'linear', fill: 'forwards' });
    const sparkle = caption.querySelector('.painting-caption-icon');
    if (sparkle) animate(sparkle, [
      { transform: 'rotate(0deg) scale(.92)' },
      { transform: 'rotate(90deg) scale(1.1)', offset: .48 },
      { transform: 'rotate(180deg) scale(.92)' },
    ], { duration: 2100, iterations: 2, easing: 'ease-in-out' });
  }
  later(() => void showResult(), 4950);
});

onBeforeUnmount(() => {
  disposed = true;
  stopScene();
  document.removeEventListener('keydown', onKeydown, true);
  resultCard.value?.close();
  // Also release the store lock if the owning app is unexpectedly unmounted.
  if (ui.skinCelebrationActive) ui.endSkinCelebration(false);
});
</script>

<template>
  <Teleport to="body">
    <div class="skin-celebration" :style="celebrationStyle" :data-target-skin="targetSkin">
      <div v-if="phase === 'painting'" ref="scene" class="skin-painting" aria-hidden="true">
        <div v-for="(job, index) in jobs" :key="`layer-${job.actor}`" :data-paint-layer="index" class="paint-layer" :class="`paint-${job.kind}`" :style="jobStyle(job)">
          <svg v-if="job.kind !== 'accent'" :viewBox="`0 0 ${job.rect.width} ${job.rect.height}`" preserveAspectRatio="none">
            <path class="paint-stroke" :d="pathOf(job)" pathLength="1" :stroke-width="job.width" />
          </svg>
          <span v-else class="fitted-accent" />
        </div>
        <div v-for="job in jobs" :key="`glints-${job.actor}`" class="job-glints" :data-spark-actor="job.actor" :style="glintStyle(job)">
          <i v-for="spark in 3" :key="spark" class="cursor-spark" />
        </div>
        <div v-for="job in jobs" :key="job.actor" class="soda-cursor" :class="`worker-${job.kind}`" :style="{ '--cursor-color': actors[job.actor].color, '--cursor-ink': actors[job.actor].ink, '--cursor-outline': actors[job.actor].outline }">
          <span v-if="job.kind === 'accent'" class="cursor-swatch"><i /><i /></span>
          <span v-else class="cursor-tool"><i /></span>
          <svg class="cursor-pointer" viewBox="0 0 32 40" fill="none">
            <path d="M4 3.5v27c0 1.5 1.7 2.3 2.8 1.3l6.5-6 4.3 9.4c.5 1.1 1.7 1.5 2.8 1l3.2-1.5c1.1-.5 1.5-1.7 1-2.8l-4.2-9.1h8.1c1.6 0 2.3-1.9 1.1-2.9L6.8 2.2C5.7 1.3 4 2 4 3.5Z"
              fill="var(--cursor-color)" stroke="var(--cursor-outline)" stroke-width="2.2" stroke-linejoin="round" />
          </svg>
          <span class="cursor-tag">{{ actors[job.actor].name }}</span>
          <span v-if="job.actor === 0 || job.actor === 5" class="cursor-bubble">{{ t(job.actor === 0 ? 'skin.bubblePaint' : 'skin.bubbleDone') }}</span>
        </div>
      </div>
      <div v-if="phase === 'painting'" class="painting-caption" role="status">
        <svg class="painting-caption-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m12 2 2.6 7.4L22 12l-7.4 2.6L12 22l-2.6-7.4L2 12l7.4-2.6Z" fill="currentColor" /></svg>
        <span class="painting-caption-text">{{ t('skin.performing', { skin: t(`skin.${targetSkin}`) }) }}</span>
        <span class="painting-progress" aria-hidden="true"><i class="painting-progress-fill" /></span>
      </div>
      <button v-if="phase === 'painting'" class="skin-skip" type="button" @click="showResult">{{ t('skin.skip') }}<kbd>Esc</kbd></button>

      <div v-if="resultFallback" class="skin-result-backdrop" />
      <dialog ref="resultCard" class="skin-result" :class="{ 'is-returning': ui.skinCelebrationWasUnlocked, 'is-fallback': resultFallback }" aria-modal="true" aria-labelledby="skin-result-title" aria-describedby="skin-result-description" @cancel.prevent="finish">
        <div v-if="!ui.skinCelebrationWasUnlocked" class="skin-art" aria-hidden="true">
          <span class="art-orbit orbit-one" /><span class="art-orbit orbit-two" /><span class="art-orbit orbit-three" />
          <svg viewBox="0 0 120 120" width="120" height="120" fill="none">
            <path d="M48 27V17c0-3 3-5 6-5h12c3 0 6 2 6 5v10l10 16c3 5 4 10 4 15v36c0 8-6 14-14 14H48c-8 0-14-6-14-14V58c0-5 1-10 4-15l10-16Z" fill="var(--surface-raised)" stroke="var(--bg-brand)" stroke-width="2.5" />
            <rect x="46" y="13" width="28" height="10" rx="5" fill="var(--bg-brand)" />
            <path d="M36 63c16-8 32 8 48 0v29c0 8-5 14-13 14H49c-8 0-13-6-13-14V63Z" fill="var(--bg-brand)" opacity=".16" />
            <path d="M60 62c-12-14-27 5 0 22 27-17 12-36 0-22Z" fill="var(--bg-brand)" />
            <circle cx="48" cy="47" r="3" fill="var(--brand-accent)" /><circle cx="70" cy="53" r="2.5" fill="var(--bg-brand)" /><circle cx="73" cy="90" r="3" fill="var(--brand-accent)" />
            <path d="M95 25v12M89 31h12M20 75v8M16 79h8" stroke="var(--brand-accent)" stroke-width="2.5" stroke-linecap="round" />
          </svg>
        </div>
        <div v-else class="returning-art" aria-hidden="true">
          <svg v-for="n in 3" :key="n" class="returning-cursor" viewBox="0 0 32 40" fill="none">
            <path d="M4 3.5v27c0 1.5 1.7 2.3 2.8 1.3l6.5-6 4.3 9.4c.5 1.1 1.7 1.5 2.8 1l3.2-1.5c1.1-.5 1.5-1.7 1-2.8l-4.2-9.1h8.1c1.6 0 2.3-1.9 1.1-2.9L6.8 2.2C5.7 1.3 4 2 4 3.5Z"
              fill="currentColor" stroke="var(--surface-raised)" stroke-width="2" stroke-linejoin="round" />
          </svg>
        </div>
        <span v-if="!ui.skinCelebrationWasUnlocked" class="unlock-eyebrow">NEW SKIN</span>
        <h2 id="skin-result-title">{{ t(ui.skinCelebrationWasUnlocked ? 'skin.returningTitle' : 'skin.unlockedTitle') }}</h2>
        <div v-if="!ui.skinCelebrationWasUnlocked" class="unlocked-skin-name">{{ t('skin.sakura') }}</div>
        <p id="skin-result-description">{{ t(ui.skinCelebrationWasUnlocked ? 'skin.returningDescription' : 'skin.description', { skin: t(`skin.${targetSkin}`) }) }}</p>
        <div class="skin-result-actions">
          <button class="skin-keep" type="button" autofocus @click="finish">{{ t(ui.skinCelebrationWasUnlocked ? 'skin.continue' : 'skin.keep') }}<span v-if="!ui.skinCelebrationWasUnlocked" aria-hidden="true">♡</span></button>
        </div>
      </dialog>
    </div>
  </Teleport>
</template>

<style scoped>
.skin-celebration { position: fixed; inset: 0; z-index: 4200; pointer-events: none; }
.skin-painting { position: absolute; inset: 0; overflow: hidden; }
.paint-layer { position: absolute; overflow: hidden; border-radius: 14px; transform-origin: center; }
.paint-layer svg { display: block; width: 100%; height: 100%; overflow: hidden; }
.paint-stroke { fill: none; stroke: var(--paint-color); stroke-opacity: .11; stroke-linecap: round; stroke-linejoin: round; stroke-dasharray: 1; stroke-dashoffset: 1; }
.paint-edge { border-radius: 22px; }
.paint-edge .paint-stroke { stroke-opacity: .75; }
.paint-accent { border-radius: var(--radius-control, 12px); opacity: 0; overflow: visible; }
.fitted-accent { display: block; box-sizing: border-box; width: 100%; height: 100%; border-radius: inherit; border: 1.5px solid var(--paint-color); background: color-mix(in srgb, var(--paint-color) 4%, transparent); box-shadow: 0 0 0 4px color-mix(in srgb, var(--paint-color) 10%, transparent); }
.job-glints { position: absolute; width: 0; height: 0; pointer-events: none; }
.cursor-spark { position: absolute; left: -4px; top: -4px; width: 8px; height: 8px; background: var(--cursor-color); opacity: 0; clip-path: polygon(50% 0, 62% 36%, 100% 50%, 62% 64%, 50% 100%, 38% 64%, 0 50%, 38% 36%); }
.cursor-spark:nth-child(2) { width: 5px; height: 5px; border-radius: 50%; clip-path: none; }
.soda-cursor { position: absolute; left: 0; top: 0; width: 34px; height: 42px; opacity: 0; will-change: transform, opacity; }
.cursor-pointer { display: block; width: 30px; height: 38px; transform: scale(1); transform-origin: 4px 3px; }
.cursor-tool { position: absolute; left: -17px; top: -13px; width: 38px; height: 13px; border-radius: 5px; background: var(--cursor-color); border: 2px solid var(--surface-raised); opacity: 0; box-shadow: 0 1px 0 var(--cursor-outline); transform-origin: 20px 16px; }
.cursor-tool::before { content: ''; position: absolute; inset: 2px 3px auto; height: 2px; border-radius: 2px; background: rgb(255 255 255 / 40%); }
.cursor-tool i { position: absolute; left: 17px; top: 11px; width: 9px; height: 10px; border-right: 2px solid var(--cursor-outline); border-bottom: 2px solid var(--cursor-outline); border-radius: 0 0 4px; }
.worker-edge .cursor-tool { left: -4px; top: -5px; width: 15px; height: 15px; border-radius: 5px; transform: rotate(45deg); }
.worker-edge .cursor-tool i { display: none; }
.worker-right-edge .cursor-pointer { scale: -1 1; }
.worker-right-edge .cursor-tag { left: auto; right: 10px; border-radius: 12px 5px 12px 12px; }
.cursor-swatch { position: absolute; left: -24px; top: -24px; display: flex; align-items: center; justify-content: center; gap: 4px; width: 35px; height: 28px; border-radius: 9px; border: 2px solid var(--surface-raised); background: var(--cursor-color); transform: rotate(-14deg); opacity: 0; }
.cursor-swatch i { width: 4px; height: 4px; border-radius: 50%; background: #fff; }
.cursor-tag { position: absolute; top: 30px; left: 25px; padding: 4px 9px; border: 1px solid color-mix(in srgb, var(--cursor-outline) 45%, transparent); border-radius: 5px 12px 12px; background: var(--cursor-color); color: var(--cursor-ink); font-size: 11px; font-weight: 600; line-height: 16px; letter-spacing: .01em; white-space: nowrap; transform-origin: top left; }
.cursor-bubble { position: absolute; left: 17px; bottom: 54px; width: max-content; max-width: 210px; padding: 9px 13px; border-radius: 16px 16px 16px 4px; background: var(--surface-raised); color: var(--text-default); border: 1px solid var(--border-neutral-l2); box-shadow: 0 3px 12px rgb(20 20 30 / 5%); font-size: 12px; line-height: 20px; opacity: 0; }
.labels-left .cursor-tag { left: auto; right: 10px; border-radius: 12px 5px 12px 12px; }
.labels-left .cursor-bubble { left: auto; right: 10px; }
.bubble-below .cursor-bubble { top: 56px; bottom: auto; border-radius: 4px 16px 16px; }
.painting-caption { position: absolute; left: 50%; bottom: 36px; translate: -50% 0; display: flex; align-items: center; gap: 10px; max-width: calc(100vw - 300px); padding: 12px 19px 14px; overflow: hidden; opacity: 0; border: 1px solid var(--border-neutral-l2); border-radius: 18px; background: var(--surface-raised); color: var(--text-default); box-shadow: 0 5px 20px rgb(20 20 30 / 6%); font-size: 12px; white-space: nowrap; }
.painting-caption-icon { flex-shrink: 0; width: 18px; height: 18px; color: var(--celebration-color); }
.painting-caption-text { overflow: hidden; text-overflow: ellipsis; }
.painting-progress { position: absolute; bottom: 0; left: 0; right: 0; height: 3px; background: color-mix(in srgb, var(--celebration-color) 9%, transparent); }
.painting-progress-fill { display: block; width: 100%; height: 100%; border-radius: 3px; background: linear-gradient(90deg, var(--celebration-color) 65%, var(--celebration-accent)); transform: scaleX(0); transform-origin: left; }
.skin-skip { position: absolute; right: 24px; bottom: 32px; display: flex; align-items: center; gap: 12px; padding: 8px 12px; border: 1px solid var(--border-neutral-l2); border-radius: 999px; background: var(--surface-raised); color: var(--text-secondary); font: inherit; font-size: 12px; cursor: pointer; pointer-events: auto; }
.skin-skip kbd { font: inherit; opacity: .6; }
.skin-result { position: fixed; inset: 0; width: min(420px, calc(100vw - 40px)); max-height: calc(100vh - 40px); margin: auto; padding: 30px 36px 24px; overflow: auto; border: 1px solid var(--border-neutral-l2); border-radius: 30px; background: var(--surface-raised); color: var(--text-default); text-align: center; pointer-events: auto; }
.skin-result[open] { animation: skin-card-enter 320ms cubic-bezier(.22, 1, .36, 1) both; }
.skin-result[open] > :is(.skin-art, .returning-art) { animation: skin-art-enter 560ms cubic-bezier(.16, 1, .3, 1) both; }
.skin-result[open] > :is(.unlock-eyebrow, h2, .unlocked-skin-name) { animation: skin-copy-enter 380ms 70ms cubic-bezier(.22, 1, .36, 1) both; }
.skin-result[open] > p { animation: skin-copy-enter 380ms 120ms cubic-bezier(.22, 1, .36, 1) both; }
.skin-result[open] > .skin-result-actions { animation: skin-copy-enter 380ms 170ms cubic-bezier(.22, 1, .36, 1) both; }
.skin-result[open] .returning-cursor { animation: skin-cursor-settle 580ms 60ms cubic-bezier(.16, 1, .3, 1) both; }
.skin-result[open] .returning-cursor:first-child { animation-delay: 120ms; }
.skin-result[open] .returning-cursor:last-child { animation-delay: 180ms; }
.skin-result[open] .art-orbit { animation: skin-orbit-settle 700ms 100ms cubic-bezier(.16, 1, .3, 1) both; }
.skin-result[open] .orbit-two { animation-delay: 160ms; }
.skin-result[open] .orbit-three { animation-delay: 220ms; }
.skin-result.is-returning { width: min(360px, calc(100vw - 40px)); padding: 26px 30px 24px; }
.returning-art { position: relative; width: 116px; height: 80px; margin: 0 auto 14px; }
.returning-cursor { position: absolute; width: 38px; height: 48px; top: 17px; left: 38px; color: var(--celebration-color); transform: rotate(-8deg); }
.returning-cursor:first-child { left: 5px; top: 26px; width: 29px; height: 37px; color: var(--celebration-accent); transform: rotate(-20deg); }
.returning-cursor:last-child { left: 78px; top: 10px; width: 29px; height: 37px; color: var(--celebration-soft); transform: rotate(14deg); }
.skin-result::backdrop { background: rgb(28 27 31 / 24%); }
.skin-result-backdrop { position: absolute; inset: 0; background: rgb(28 27 31 / 24%); pointer-events: auto; }
.skin-result.is-fallback { z-index: 1; }
.skin-art { position: relative; display: grid; place-items: center; width: 154px; height: 140px; margin: 0 auto 16px; border-radius: 50%; background: var(--skin-selection); }
.art-orbit { position: absolute; width: 7px; height: 7px; border-radius: 50%; background: var(--brand-accent); }
.orbit-one { left: 7px; top: 34px; }.orbit-two { right: 7px; bottom: 28px; width: 11px; height: 11px; background: var(--bg-brand); opacity: .5; }.orbit-three { left: 28px; bottom: 8px; width: 5px; height: 5px; }
.unlock-eyebrow { font-size: 10px; font-weight: 600; letter-spacing: .18em; color: var(--text-secondary); }
.skin-result h2 { margin: 10px 0 8px; font-size: 21px; font-weight: 600; line-height: 1.5; letter-spacing: -.03em; }
.unlocked-skin-name { color: var(--interaction-ink, var(--bg-brand)); font-size: 15px; font-weight: 600; letter-spacing: .05em; }
.skin-result p { margin: 12px auto 26px; color: var(--text-secondary); font-size: 13px; line-height: 1.8; text-wrap: balance; }
.skin-result-actions { display: grid; gap: 8px; }
.skin-result-actions button { display: flex; align-items: center; justify-content: center; gap: 10px; min-height: 42px; padding: 9px 16px; border: 0; border-radius: 14px; font: inherit; font-size: 13px; font-weight: 500; cursor: pointer; transition: background-color 160ms, transform 240ms cubic-bezier(.22, 1, .36, 1); }
.skin-result-actions button:active { transform: scale(.97); }
.skin-keep { color: var(--text-onbrand); background: var(--bg-brand); }
.skin-keep:hover { background: var(--bg-brand-hover); }
.skin-keep span { font-size: 20px; line-height: 16px; }
@keyframes skin-card-enter { from { opacity: 0; transform: translateY(14px) scale(.96); } to { opacity: 1; transform: none; } }
@keyframes skin-art-enter { from { opacity: 0; transform: translateY(8px) rotate(-7deg) scale(.86); } to { opacity: 1; transform: none; } }
@keyframes skin-copy-enter { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
@keyframes skin-cursor-settle { from { opacity: 0; translate: 0 8px; scale: .8; } to { opacity: 1; translate: 0 0; scale: 1; } }
@keyframes skin-orbit-settle { from { translate: 0 5px; scale: .2; } to { translate: 0 0; scale: 1; } }
@media (max-height: 680px) { .skin-result { padding-top: 22px; padding-bottom: 18px; }.skin-art { width: 130px; height: 118px; margin-bottom: 10px; }.skin-art svg { width: 100px; height: 100px; } }
</style>

<style>
/* Capture the old workspace once; the crew stays live in a separate group. */
html.skin-renovating { view-transition-name: none; }
html.skin-renovating .app-shell { view-transition-name: mason-workspace; }
html.skin-renovating .skin-celebration { view-transition-name: mason-crew; }
html.skin-renovating .app-shell * { transition: none !important; }
html::view-transition { pointer-events: none; }
html::view-transition-group(mason-workspace), html::view-transition-group(mason-crew) { animation: mason-reveal-hold 6s linear; }
html::view-transition-group(mason-workspace) { z-index: 0; }
html::view-transition-group(mason-crew) { z-index: 1; }
html::view-transition-old(mason-workspace), html::view-transition-new(mason-workspace), html::view-transition-new(mason-crew) { animation: none; mix-blend-mode: normal; }
html::view-transition-old(mason-crew) { display: none; }
@keyframes mason-reveal-hold { from { opacity: 1; } to { opacity: 1; } }
</style>
