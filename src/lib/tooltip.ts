export type TooltipPlacement = 'top' | 'bottom' | 'left' | 'right';
export interface TooltipRect { left: number; top: number; width: number; height: number }

export function positionTooltip(anchor: TooltipRect, size: { width: number; height: number },
  viewport: { width: number; height: number }, preferred: TooltipPlacement = 'top', gap = 8, padding = 8) {
  const room = {
    top: anchor.top - padding - gap,
    bottom: viewport.height - anchor.top - anchor.height - padding - gap,
    left: anchor.left - padding - gap,
    right: viewport.width - anchor.left - anchor.width - padding - gap,
  };
  const opposite: Record<TooltipPlacement, TooltipPlacement> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };
  const needed = preferred === 'top' || preferred === 'bottom' ? size.height : size.width;
  const side = room[preferred] < needed && room[opposite[preferred]] > room[preferred] ? opposite[preferred] : preferred;
  let x = anchor.left + (anchor.width - size.width) / 2;
  let y = anchor.top + (anchor.height - size.height) / 2;
  if (side === 'top') y = anchor.top - size.height - gap;
  else if (side === 'bottom') y = anchor.top + anchor.height + gap;
  else if (side === 'left') x = anchor.left - size.width - gap;
  else x = anchor.left + anchor.width + gap;
  return {
    x: Math.round(Math.max(padding, Math.min(x, viewport.width - size.width - padding))),
    y: Math.round(Math.max(padding, Math.min(y, viewport.height - size.height - padding))),
    side,
  };
}

/** No animation loop: idle controls only keep their own pointer/focus listeners. */
export function createTooltipInteraction(options: { show: () => void; hide: () => void; delay?: () => number }) {
  let hovered = false;
  let focused = false;
  let dismissed = false;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => { clearTimeout(timer); timer = undefined; };
  const schedule = (delay: number) => {
    if (dismissed || disposed) return;
    cancel();
    timer = setTimeout(() => { timer = undefined; if (!dismissed && !disposed && (hovered || focused)) options.show(); }, delay);
  };
  const leave = () => {
    if (hovered || focused) return;
    dismissed = false;
    cancel();
    options.hide();
  };
  return {
    enter(pointerType = 'mouse') { if (pointerType === 'touch' || disposed) return; hovered = true; schedule(options.delay?.() ?? 380); },
    leave() { hovered = false; leave(); },
    focus() { if (disposed) return; focused = true; schedule(80); },
    blur() { focused = false; leave(); },
    dismiss() { dismissed = true; cancel(); options.hide(); },
    dispose() { disposed = true; hovered = focused = false; cancel(); options.hide(); },
  };
}
