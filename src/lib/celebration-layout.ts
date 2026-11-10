export type CelebrationTarget = {
  element: HTMLElement;
  point: { x: number; y: number };
};

export type CelebrationSurface = {
  element: HTMLElement;
  rect: { left: number; top: number; width: number; height: number };
};

const CLIPPING_OVERFLOW = new Set(["hidden", "clip", "scroll", "auto"]);

function findVisibleElement(
  selectors: readonly string[],
  used: ReadonlySet<Element>,
  accepts: (width: number, height: number, totalArea: number) => boolean,
): CelebrationSurface | null {
  if (typeof document === "undefined" || typeof window === "undefined" || typeof HTMLElement === "undefined") return null;
  const width = window.innerWidth, height = window.innerHeight;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  const styles = new Map<HTMLElement, CSSStyleDeclaration>();
  const styleOf = (element: HTMLElement) => {
    let style = styles.get(element);
    if (!style) { style = getComputedStyle(element); styles.set(element, style); }
    return style;
  };

  for (const selector of selectors) {
    for (const candidate of document.querySelectorAll(selector)) {
      if (!(candidate instanceof HTMLElement) || used.has(candidate)) continue;
      const rect = candidate.getBoundingClientRect();
      if (![rect.left, rect.top, rect.width, rect.height].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0) continue;
      let left = Math.max(0, rect.left), top = Math.max(0, rect.top);
      let right = Math.min(width, rect.right), bottom = Math.min(height, rect.bottom);
      let hidden = false;
      for (let ancestor: HTMLElement | null = candidate; ancestor; ancestor = ancestor.parentElement) {
        const style = styleOf(ancestor);
        if (ancestor.inert || ancestor.hasAttribute("inert") || ancestor.getAttribute("aria-hidden") === "true"
          || style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse"
          || style.opacity === "0") {
          hidden = true;
          break;
        }
        // Root overflow controls the viewport, already intersected above. An
        // element's own overflow clips its children, not its own target box.
        if (ancestor === candidate || ancestor === document.body || ancestor === document.documentElement) continue;
        const clipX = CLIPPING_OVERFLOW.has(style.overflowX || style.overflow);
        const clipY = CLIPPING_OVERFLOW.has(style.overflowY || style.overflow);
        if (clipX || clipY) {
          const clip = ancestor.getBoundingClientRect();
          if (clipX) { left = Math.max(left, clip.left); right = Math.min(right, clip.right); }
          if (clipY) { top = Math.max(top, clip.top); bottom = Math.min(bottom, clip.bottom); }
        }
      }
      const visibleWidth = right - left, visibleHeight = bottom - top;
      if (hidden || !accepts(visibleWidth, visibleHeight, rect.width * rect.height)) continue;
      return { element: candidate, rect: { left, top, width: visibleWidth, height: visibleHeight } };
    }
  }
  return null;
}

/** Find an onscreen decoration target without moving or activating the UI. */
export function findCelebrationTarget(
  selectors: readonly string[],
  used: ReadonlySet<Element> = new Set(),
): CelebrationTarget | null {
  const target = findVisibleElement(selectors, used, (width, height, totalArea) =>
    width >= 12 && height >= 12 && width * height >= totalArea * 0.8);
  if (!target) return null;
  const { left, top, width, height } = target.rect;
  return { element: target.element, point: { x: left + width / 2, y: top + height / 2 } };
}

/** A panel's visible area may be decorated even when most of it is scrolled away. */
export function findCelebrationSurface(
  selectors: readonly string[],
  used: ReadonlySet<Element> = new Set(),
): CelebrationSurface | null {
  return findVisibleElement(selectors, used, (width, height) => width >= 48 && height >= 48);
}
