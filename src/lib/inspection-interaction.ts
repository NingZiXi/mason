import { zoomViewport, type InspectionViewport } from './stencil-inspection';
import { mergeSelection, padsInSelection, selectionRect, type SelectionPad, type SelectionPoint,
  type SelectionOperation, type SelectionRect } from './inspection-selection';

type Matrix = Pick<DOMMatrix, 'a' | 'b' | 'c' | 'd' | 'e' | 'f'>;
type GestureKind = 'pan' | 'select';
interface Gesture {
  id: number; kind: GestureKind; client: SelectionPoint; start: SelectionPoint; end: SelectionPoint;
  matrix: Matrix; view: InspectionViewport; moved: boolean; index: number | null;
  operation: SelectionOperation; selection: number[];
}

export function screenToInspection(point: SelectionPoint, matrix: Matrix): SelectionPoint | null {
  const det = matrix.a * matrix.d - matrix.b * matrix.c;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  const x = point.x - matrix.e, y = point.y - matrix.f;
  return { x: (matrix.d * x - matrix.c * y) / det, y: (-matrix.b * x + matrix.a * y) / det };
}

/** Pointer movement never changes Vue state or recreates pad paths. Only one
 * viewBox / selection-box update is painted per animation frame. */
export function createInspectionInteraction(options: {
  svg: () => SVGSVGElement | null;
  marquee: () => SVGRectElement | null;
  canSelect: () => boolean;
  pads: () => readonly SelectionPad[];
  selection: () => readonly number[];
  select: (indices: number[]) => void;
  gesture: (kind: GestureKind | null) => void;
  zoom: (value: number) => void;
  frame?: (callback: FrameRequestCallback) => number;
  cancelFrame?: (id: number) => void;
}) {
  const frame = options.frame ?? requestAnimationFrame;
  const cancelFrame = options.cancelFrame ?? cancelAnimationFrame;
  let view: InspectionViewport = { x: -10, y: -10, width: 20, height: 20 };
  let zoom = 1;
  let gesture: Gesture | null = null;
  let queued: number | null = null;
  let box: SelectionRect | null = null;
  let paintedView = '';
  let paintedSvg: SVGSVGElement | null = null;
  let displayedView = { ...view };

  function paint() {
    queued = null;
    const svg = options.svg();
    const viewBox = `${view.x} ${view.y} ${view.width} ${view.height}`;
    if (svg && (svg !== paintedSvg || viewBox !== paintedView)) {
      svg.setAttribute('viewBox', viewBox); paintedView = viewBox; paintedSvg = svg; displayedView = { ...view };
    }
    const rect = options.marquee();
    if (rect) {
      rect.style.display = box ? '' : 'none';
      if (box) for (const [key, value] of Object.entries(box)) rect.setAttribute(key, String(value));
    }
    options.zoom(zoom);
  }
  function queue() { if (queued === null) queued = frame(paint); }
  function flush() { if (queued !== null) cancelFrame(queued); paint(); }

  function move(event: PointerEvent) {
    if (!gesture || event.pointerId !== gesture.id) return;
    const point = screenToInspection({ x: event.clientX, y: event.clientY }, gesture.matrix);
    if (!point) return;
    if (Math.hypot(event.clientX - gesture.client.x, event.clientY - gesture.client.y) >= 4) gesture.moved = true;
    gesture.end = point;
    if (!gesture.moved) return;
    if (gesture.kind === 'pan') {
      view = { ...gesture.view, x: gesture.view.x - (point.x - gesture.start.x), y: gesture.view.y - (point.y - gesture.start.y) };
    } else box = selectionRect(gesture.start, point);
    queue();
  }

  function finish(event?: PointerEvent) {
    if (!gesture || (event && event.pointerId !== gesture.id)) return;
    if (event?.type === 'pointerup') move(event);
    const ended = gesture;
    gesture = null; box = null;
    const svg = options.svg();
    if (svg?.hasPointerCapture(ended.id)) svg.releasePointerCapture(ended.id);
    options.gesture(null);
    flush();
    if (event?.type !== 'pointerup' || ended.kind !== 'select' || !options.canSelect()) return;
    const hits = ended.moved ? padsInSelection(options.pads(), selectionRect(ended.start, ended.end))
      : ended.index === null ? [] : [ended.index];
    options.select(mergeSelection(ended.selection, hits, ended.operation));
  }

  function down(event: PointerEvent) {
    const svg = options.svg();
    if (gesture || !svg || (event.button !== 2 && (event.button !== 0 || !options.canSelect()))) return;
    event.preventDefault(); flush();
    svg.focus({ preventScroll: true });
    const matrix = svg.getScreenCTM();
    const client = { x: event.clientX, y: event.clientY };
    const point = matrix && screenToInspection(client, matrix);
    if (!matrix || !point) return;
    const target = (event.target as Element)?.closest?.('[data-pad-index]');
    const index = target?.getAttribute('data-pad-index');
    gesture = { id: event.pointerId, kind: event.button === 2 ? 'pan' : 'select', client, start: point, end: point,
      matrix: { a: matrix.a, b: matrix.b, c: matrix.c, d: matrix.d, e: matrix.e, f: matrix.f },
      view: { ...view }, moved: false, index: index == null ? null : Number(index),
      selection: [...options.selection()], operation: event.ctrlKey || event.metaKey ? 'toggle' : event.shiftKey ? 'add' : 'replace' };
    svg.setPointerCapture(event.pointerId);
    options.gesture(gesture.kind);
  }

  function zoomBy(factor: number, anchor?: SelectionPoint) {
    if (gesture) return;
    const next = Math.max(.5, Math.min(80, zoom * factor));
    view = zoomViewport(view, zoom / next, anchor ?? { x: view.x + view.width / 2, y: view.y + view.height / 2 });
    zoom = next; queue();
  }
  function wheel(event: WheelEvent) {
    if (gesture) return;
    // A previous wheel event may still be awaiting its frame. Translate from
    // the displayed view to the pending view instead of forcing a layout.
    if (paintedSvg !== options.svg() || Math.abs(view.width / view.height - displayedView.width / displayedView.height) > 1e-9) flush();
    const matrix = options.svg()?.getScreenCTM();
    const point = matrix && screenToInspection({ x: event.clientX, y: event.clientY }, matrix);
    if (point) zoomBy(Math.exp(-Math.max(-100, Math.min(100,
      event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 100 : 1))) * .008), {
      x: view.x + (point.x - displayedView.x) / displayedView.width * view.width,
      y: view.y + (point.y - displayedView.y) / displayedView.height * view.height,
    });
  }
  function fit(bounds: InspectionViewport) { finish(); view = { ...bounds }; zoom = 1; queue(); }
  function dispose() { finish(); if (queued !== null) cancelFrame(queued); queued = null; }
  return { down, move, finish, wheel, zoomBy, fit, refresh: queue, dispose };
}
