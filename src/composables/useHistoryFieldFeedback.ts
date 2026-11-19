import { nextTick, onScopeDispose } from 'vue';
import type { useConfigStore } from '../stores/config';

const form = ':is(.config-form,.stencil-form,.screw-diagram,.relief-editor)';
const fields = `${form} :is(input:not([role="combobox"]),[role="slider"],[role="switch"],button[aria-pressed],.el-select__placeholder)`;

function valueOf(el: HTMLElement) {
  if (el instanceof HTMLInputElement) return el.type === 'checkbox' || el.type === 'radio' ? el.checked : el.value;
  return el.getAttribute('aria-valuenow') ?? el.getAttribute('aria-checked') ?? el.getAttribute('aria-pressed') ?? el.textContent;
}

function surface(el: HTMLElement) {
  const number = el.closest('.el-input-number');
  return number?.querySelector<HTMLElement>('.el-input__wrapper') ?? el.closest<HTMLElement>(
    '.el-slider,.el-select__wrapper,.el-checkbox,.el-switch') ?? el;
}

function visible(el: HTMLElement) {
  if (!el.isConnected || el.closest('[inert],[aria-hidden="true"]')) return false;
  const rect = el.getBoundingClientRect();
  const clip = el.closest('.app-sidebar, .relief-editor')?.getBoundingClientRect();
  const l = Math.max(0, rect.left, clip?.left ?? 0), t = Math.max(0, rect.top, clip?.top ?? 0);
  const r = Math.min(innerWidth, rect.right, clip?.right ?? innerWidth), b = Math.min(innerHeight, rect.bottom, clip?.bottom ?? innerHeight);
  return r > l && b > t && el.contains(document.elementFromPoint((l + r) / 2, (t + b) / 2));
}

// Sample the actual controls only on a history action. Normal typing and
// slider input do no extra work; a derived value only pulses if it changed.
export function useHistoryFieldFeedback(store: ReturnType<typeof useConfigStore>) {
  const playing = new Map<HTMLElement, Animation>();
  let alive = true;
  const stop = store.$onAction(({ name, after }) => {
    if (name !== 'undo' && name !== 'redo') return;
    const previous = Array.from(document.querySelectorAll<HTMLElement>(fields), el => [el, valueOf(el)] as const);
    after(async () => {
      await nextTick();
      if (!alive) return;
      const changed = new Set(previous.filter(([el, value]) => el.isConnected && valueOf(el) !== value).map(([el]) => surface(el)));
      for (const el of changed) {
        if (!visible(el) || typeof el.animate !== 'function') continue;
        const base = getComputedStyle(el).backgroundColor;
        const tint = `color-mix(in srgb, var(--bg-brand) 19%, ${base})`;
        const old = playing.get(el);
        old?.cancel();
        const pulse = el.animate([{ backgroundColor: base }, { backgroundColor: tint, offset: .17 }, { backgroundColor: base }],
          { duration: 540, easing: 'ease-out' });
        playing.set(el, pulse);
        pulse.onfinish = () => { if (playing.get(el) === pulse) playing.delete(el); };
      }
    });
  });
  onScopeDispose(() => { alive = false; stop(); playing.forEach(a => a.cancel()); playing.clear(); });
}
