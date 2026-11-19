<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, onUpdated, ref } from 'vue';

// The slot contains the actual buttons. Click, keyboard and drag therefore use
// the same selection handler; moving the thumb never starts a model build.
const rail = ref<HTMLElement | null>(null);
const thumb = ref<HTMLElement | null>(null);
type Stop = { button: HTMLButtonElement; x: number; w: number; y: number; h: number };
let stops: Stop[] = [], target: Stop | undefined, resize: ResizeObserver | undefined;
let gesture: { id: number; button: HTMLButtonElement; startX: number; startY: number; offset: number; origin: number; dragging: boolean } | undefined;
let x = 0, velocity = 0, tail = 0, width = 0, frame = 0, last = 0, suppressClick = false;
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(v, b));
const nearest = (point: number) => stops.reduce((a, b) => Math.abs(b.x - point) < Math.abs(a.x - point) ? b : a);

function paint() {
  if (!thumb.value || !target) return;
  const first = stops[0], end = stops[stops.length - 1];
  const left = first.x - first.w / 2, right = end.x + end.w / 2;
  // The leading edge pulls the tail. On hitting a rail end the drop squashes
  // against it, so even the outer two choices get a visible, contained rebound.
  const wake = clamp(x - tail, -width * .34, width * .34);
  const impact = Math.min(width * .12, Math.max(0, left - (x - width / 2), x + width / 2 - right));
  const w = Math.min(right - left, width + Math.abs(wake) * .78 - impact * 1.4);
  const h = 1 - .28 * Math.abs(wake) / width + .65 * impact / width;
  const start = clamp(x - wake * .30 - w / 2, left, right - w);
  thumb.value.style.transform = `translate3d(${start}px,${target.y}px,0) scale(${w / target.w},${h})`;
}
function tick(now: number) {
  frame = 0;
  if (!target) return;
  const dt = Math.min((now - last) / 1000, .04); last = now;
  // Small integration steps give the same spring at 60 and 144 Hz.
  const count = Math.max(1, Math.ceil(dt * 160)), step = dt / count;
  for (let i = 0; i < count; i++) {
    if (!gesture?.dragging) {
      velocity += ((target.x - x) * 510 - velocity * 29) * step;
      x += velocity * step;
    }
    tail += (x - tail) * (1 - Math.exp(-step * 26));
    width += (target.w - width) * (1 - Math.exp(-step * 24));
  }
  const moving = (!gesture?.dragging && (Math.abs(x - target.x) > .06 || Math.abs(velocity) > .8))
    || Math.abs(tail - x) > .06 || Math.abs(width - target.w) > .06;
  if (!moving) { if (!gesture?.dragging) x = target.x; tail = x; width = target.w; velocity = 0; }
  paint();
  if (moving) frame = requestAnimationFrame(tick);
}
function wake() { if (!frame) { last = performance.now(); frame = requestAnimationFrame(tick); } }
function aim(stop: Stop | undefined, snap = false) {
  const el = thumb.value;
  if (!el) return;
  if (!stop) {
    target = undefined; el.hidden = true; cancelAnimationFrame(frame); frame = 0; return;
  }
  const first = !target; target = stop;
  el.style.width = `${stop.w}px`; el.style.height = `${stop.h}px`; el.hidden = false;
  if (snap || first) { x = tail = stop.x; width = stop.w; velocity = 0; paint(); }
  else { paint(); wake(); }
}
function measure() {
  if (!rail.value) return;
  const buttons = Array.from(rail.value.querySelectorAll<HTMLButtonElement>(':scope > button:not(:disabled)'));
  const next = buttons.filter(b => b.offsetWidth > 0).map(button => ({ button, x: button.offsetLeft + button.offsetWidth / 2,
    w: button.offsetWidth, y: button.offsetTop, h: button.offsetHeight }));
  const changed = next.length !== stops.length || next.some((b, i) => {
    const a = stops[i]; return !a || a.button !== b.button || a.x !== b.x || a.w !== b.w || a.y !== b.y || a.h !== b.h;
  });
  if (changed) {
    if (gesture) release();
    for (const a of stops) if (!buttons.includes(a.button)) resize?.unobserve(a.button);
    for (const b of next) resize?.observe(b.button);
    stops = next;
  }
  if (gesture?.dragging) return;
  const selected = stops.find(s => s.button.getAttribute('aria-pressed') === 'true');
  if (changed || selected !== target) aim(selected, changed);
}
function press(e: PointerEvent) {
  if (!e.isPrimary || e.button !== 0 || gesture) return;
  suppressClick = false;
  if (stops.length < 2 || !rail.value) return;
  const button = (e.target as Element).closest('button');
  const stop = stops.find(s => s.button === button);
  if (!stop) return;
  const origin = rail.value.getBoundingClientRect().left + rail.value.clientLeft;
  gesture = { id: e.pointerId, button: stop.button, startX: e.clientX, startY: e.clientY, origin,
    offset: e.clientX - origin - stop.x, dragging: false };
  stop.button.setPointerCapture(e.pointerId);
}
function move(e: PointerEvent) {
  const g = gesture;
  if (!g || g.id !== e.pointerId) return;
  if (!g.dragging) {
    const dx = Math.abs(e.clientX - g.startX), dy = Math.abs(e.clientY - g.startY);
    if (dx < 4 || dx < dy) return;
    g.dragging = true; rail.value!.dataset.dragging = '';
    if (!target) aim(stops.find(s => s.button === g.button), true);
  }
  x = clamp(e.clientX - g.origin - g.offset, stops[0].x, stops[stops.length - 1].x);
  velocity = 0; const near = nearest(x);
  if (target !== near) aim(near); else wake();
}
function release() {
  const g = gesture;
  if (!g) return;
  gesture = undefined;
  if (rail.value) delete rail.value.dataset.dragging;
  if (g.button.hasPointerCapture(g.id)) g.button.releasePointerCapture(g.id);
  if (g.dragging) suppressClick = true;
}
function end(e: PointerEvent) {
  if (gesture?.id !== e.pointerId) return;
  if (!gesture.dragging) { release(); return; }
  move(e);
  const chosen = nearest(x);
  release();
  chosen.button.focus({ preventScroll: true });
  if (chosen.button.getAttribute('aria-pressed') !== 'true') chosen.button.click();
  aim(chosen); void nextTick(measure);
}
function cancel(e?: PointerEvent | KeyboardEvent | Event) {
  if (!gesture || (e && 'pointerId' in e && e.pointerId !== gesture.id)) return;
  release(); aim(stops.find(s => s.button.getAttribute('aria-pressed') === 'true'));
}
function click(e: MouseEvent) {
  if (suppressClick && e.detail !== 0) { suppressClick = false; e.preventDefault(); e.stopImmediatePropagation(); }
}
onMounted(() => {
  resize = new ResizeObserver(measure); resize.observe(rail.value!); measure();
  window.addEventListener('blur', cancel);
});
onUpdated(measure);
onBeforeUnmount(() => { release(); resize?.disconnect(); cancelAnimationFrame(frame); window.removeEventListener('blur', cancel); });
</script>

<template>
  <div ref="rail" class="liquid-track" role="group" @pointerdown="press" @pointermove="move" @pointerup="end"
    @pointercancel="cancel" @lostpointercapture="cancel" @keydown.esc="cancel" @click.capture="click">
    <span ref="thumb" class="liquid-thumb" hidden aria-hidden="true" />
    <slot />
  </div>
</template>

<style scoped>
.liquid-track { touch-action: pan-y; user-select: none; }
.liquid-thumb {
  position: absolute; inset: 0 auto auto 0; z-index: 0; pointer-events: none;
  box-sizing: border-box; transform-origin: left center;
  border: 1px solid var(--selection-border, var(--surface-line)); border-radius: var(--radius-full);
  corner-shape: var(--corner-shape); background: var(--selection-background, var(--surface-raised));
  box-shadow: var(--selection-shadow, var(--shadow-control));
}
.liquid-track[data-dragging], .liquid-track[data-dragging] > :deep(button) { cursor: grabbing; }
.liquid-track[data-dragging] > :deep(button) { --button-press-scale: 1; background: transparent; }
</style>
