/** Coalesce layout and display-scale changes into one resize per frame. */
export function observePreviewResize(element: HTMLElement, resize: () => void): () => void {
  let stopped = false;
  let frame: number | null = null;
  let resolution: MediaQueryList | null = null;
  const schedule = () => {
    if (stopped || frame !== null) return;
    frame = window.requestAnimationFrame(() => {
      frame = null;
      if (!stopped) resize();
    });
  };
  const watchResolution = () => {
    resolution?.removeEventListener('change', onResolutionChange);
    resolution = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    resolution.addEventListener('change', onResolutionChange);
  };
  function onResolutionChange() {
    if (stopped) return;
    // A resolution query only changes once away from its original density.
    watchResolution();
    schedule();
  }
  const observer = new ResizeObserver(schedule);
  observer.observe(element);
  window.addEventListener('resize', schedule);
  watchResolution();
  return () => {
    stopped = true;
    observer.disconnect();
    window.removeEventListener('resize', schedule);
    resolution?.removeEventListener('change', onResolutionChange);
    if (frame !== null) window.cancelAnimationFrame(frame);
    frame = null;
  };
}
