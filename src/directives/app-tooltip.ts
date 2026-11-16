import type { ObjectDirective } from 'vue';
import { createTooltipInteraction, positionTooltip, type TooltipPlacement } from '../lib/tooltip';
import '../tooltip.css';

export interface AppTooltipOptions { content: string; placement?: TooltipPlacement; disabled?: boolean; delay?: number }
export type AppTooltipValue = string | AppTooltipOptions | null | undefined | false;
let nextId = 0;
let closeActive: (() => void) | undefined;
const instances = new WeakMap<HTMLElement, ReturnType<typeof attachAppTooltip>>();
const normalize = (value: AppTooltipValue): AppTooltipOptions => typeof value === 'string' ? { content: value } : value || { content: '' };

function visibleModal(document: Document, window: Window) {
  let top: HTMLElement | undefined;
  let zIndex = -1;
  for (const modal of document.querySelectorAll<HTMLElement>('.el-overlay')) {
    if (!modal.getClientRects().length) continue;
    const z = Number.parseInt(window.getComputedStyle(modal).zIndex, 10) || 0;
    if (z >= zIndex) { top = modal; zIndex = z; }
  }
  return { top, zIndex };
}

/** Native-element directive avoids wrappers that change toolbar or segment layout. */
export function attachAppTooltip(element: HTMLElement, value: AppTooltipValue) {
  const document = element.ownerDocument;
  const window = document.defaultView!;
  const id = `mason-tooltip-${++nextId}`;
  let options = normalize(value);
  let tooltip: HTMLDivElement | undefined;
  let frame: number | undefined;
  let removal: ReturnType<typeof setTimeout> | undefined;
  let observer: MutationObserver | undefined;
  let resize: ResizeObserver | undefined;
  let shown = false;

  const allowed = () => {
    if (!element.isConnected || options.disabled || !options.content.trim() || !element.getClientRects().length
      || element.closest('[inert], [aria-hidden="true"]') || window.getComputedStyle(element).visibility === 'hidden') return false;
    const { top } = visibleModal(document, window);
    return !top || top.contains(element);
  };
  const describe = (add: boolean) => {
    const ids = new Set((element.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean));
    if (add) ids.add(id); else ids.delete(id);
    if (ids.size) element.setAttribute('aria-describedby', [...ids].join(' '));
    else element.removeAttribute('aria-describedby');
  };
  const place = () => {
    if (!tooltip || !shown) return;
    if (!allowed()) { interaction.dismiss(); return; }
    const viewport = window.visualViewport;
    const width = viewport?.width ?? window.innerWidth;
    const height = viewport?.height ?? window.innerHeight;
    tooltip.style.maxWidth = `${Math.max(1, Math.min(280, width - 16))}px`;
    tooltip.style.maxHeight = `${Math.max(1, height - 16)}px`;
    const bounds = element.getBoundingClientRect();
    const position = positionTooltip({ left: bounds.left - (viewport?.offsetLeft ?? 0), top: bounds.top - (viewport?.offsetTop ?? 0), width: bounds.width, height: bounds.height }, tooltip.getBoundingClientRect(),
      { width, height }, options.placement);
    tooltip.style.left = `${position.x + (viewport?.offsetLeft ?? 0)}px`;
    tooltip.style.top = `${position.y + (viewport?.offsetTop ?? 0)}px`;
    tooltip.dataset.side = position.side;
  };
  function keydown(event: KeyboardEvent) {
    if (event.key !== 'Escape' || !shown) return;
    interaction.dismiss();
    event.preventDefault();
    // Escape dismisses this hint first; a second press can close its dialog.
    event.stopPropagation();
  }
  const dismiss = () => interaction.dismiss();
  const focusOutside = (event: FocusEvent) => { if (event.target !== element && !element.contains(event.target as Node)) dismiss(); };
  const observeModals = () => {
    for (const modal of document.querySelectorAll('.el-overlay')) observer?.observe(modal, { attributes: true, attributeFilter: ['style', 'class'] });
  };
  const checkModal = () => { observeModals(); if (shown && !allowed()) dismiss(); };
  function stopWatching() {
    document.removeEventListener('keydown', keydown, true);
    document.removeEventListener('pointerdown', dismiss, true);
    document.removeEventListener('focusin', focusOutside, true);
    document.removeEventListener('scroll', dismiss, true);
    window.removeEventListener('blur', dismiss);
    window.removeEventListener('resize', dismiss);
    window.visualViewport?.removeEventListener('resize', dismiss);
    window.visualViewport?.removeEventListener('scroll', dismiss);
    observer?.disconnect(); observer = undefined;
    resize?.disconnect(); resize = undefined;
  }
  function hide() {
    shown = false;
    if (closeActive === dismiss) closeActive = undefined;
    if (frame !== undefined) window.cancelAnimationFrame(frame);
    frame = undefined;
    stopWatching();
    describe(false);
    if (!tooltip) return;
    tooltip.classList.remove('is-visible');
    tooltip.setAttribute('aria-hidden', 'true');
    clearTimeout(removal);
    removal = setTimeout(() => { tooltip?.remove(); tooltip = undefined; }, 130);
  }
  function show() {
    if (!allowed() || shown) return;
    closeActive?.();
    closeActive = dismiss;
    shown = true;
    clearTimeout(removal);
    tooltip ??= document.createElement('div');
    tooltip.id = id;
    tooltip.className = 'app-tooltip';
    tooltip.textContent = options.content;
    tooltip.setAttribute('role', 'tooltip');
    tooltip.removeAttribute('aria-hidden');
    const { zIndex } = visibleModal(document, window);
    tooltip.style.zIndex = String(Math.max(2000, zIndex + 1));
    document.body.appendChild(tooltip);
    describe(true);
    place();
    frame = window.requestAnimationFrame(() => { frame = undefined; if (shown) tooltip?.classList.add('is-visible'); });
    document.addEventListener('keydown', keydown, true);
    document.addEventListener('pointerdown', dismiss, true);
    document.addEventListener('focusin', focusOutside, true);
    document.addEventListener('scroll', dismiss, true);
    window.addEventListener('blur', dismiss);
    window.addEventListener('resize', dismiss);
    window.visualViewport?.addEventListener('resize', dismiss);
    window.visualViewport?.addEventListener('scroll', dismiss);
    // Only observe modal roots/body, not animated CAD content. A newly opened
    // mask must immediately remove hints belonging to the covered workspace.
    observer = new MutationObserver(checkModal);
    observer.observe(document.body, { childList: true });
    observeModals();
    resize = new ResizeObserver(place);
    resize.observe(element);
    resize.observe(tooltip);
  }
  const interaction = createTooltipInteraction({ show, hide, delay: () => Math.max(0, Math.min(options.delay ?? 380, 2000)) });
  const enter = (event: PointerEvent) => interaction.enter(event.pointerType);
  const leave = () => interaction.leave();
  const focus = () => interaction.focus();
  const blur = () => interaction.blur();
  element.addEventListener('pointerenter', enter);
  element.addEventListener('pointerleave', leave);
  element.addEventListener('focus', focus);
  element.addEventListener('blur', blur);
  // Dismiss before pointer focus, so clicking a tool never summons its hint.
  element.addEventListener('pointerdown', dismiss);
  return {
    update(next: AppTooltipValue) {
      const previous = options;
      options = normalize(next);
      // Parameter dragging rerenders many controls. Hidden hints do not read
      // layout or search modal roots; eligibility is checked when shown.
      if (!shown) return;
      if (previous.content === options.content && previous.placement === options.placement
        && previous.disabled === options.disabled && previous.delay === options.delay) return;
      if (options.disabled || !options.content.trim()) dismiss();
      else if (shown && tooltip) { tooltip.textContent = options.content; place(); }
    },
    destroy() {
      interaction.dispose();
      clearTimeout(removal);
      tooltip?.remove(); tooltip = undefined;
      element.removeEventListener('pointerenter', enter);
      element.removeEventListener('pointerleave', leave);
      element.removeEventListener('focus', focus);
      element.removeEventListener('blur', blur);
      element.removeEventListener('pointerdown', dismiss);
    },
  };
}

export const vAppTooltip: ObjectDirective<HTMLElement, AppTooltipValue> = {
  mounted(element, binding) { instances.set(element, attachAppTooltip(element, binding.value)); },
  updated(element, binding) { instances.get(element)?.update(binding.value); },
  beforeUnmount(element) { instances.get(element)?.destroy(); instances.delete(element); },
};
