<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { ElSwitch } from 'element-plus';
import { MAX_RELIEF_REGIONS, MAX_RELIEF_VERTICES, reliefRegionDepth,
  type ComponentReliefMergeResult, type ComponentReliefRegion } from '../lib/component-relief';
import type { PadPolygon } from '../lib/gerber/pads';
import { canAppendReliefVertex, clampReliefPoint, createReliefPolygon, drawReliefRegion, fitReliefView, isValidReliefPolygon,
  moveReliefRegion, reliefEditorBounds, reliefHandleSize, reliefRegionIntersectsBoard, reliefRegionsInMarquee, reliefScreenPoint, resizeReliefRegion,
  updateReliefDimensions, updateReliefVertex, zoomReliefView,
  type ReliefCorner, type ReliefPoint, type ReliefView } from '../lib/component-relief-editor';
import { generateAutomaticRelief } from '../lib/component-relief-auto';
import { reliefPadGuide } from '../lib/relief-pad-guide';
import { parameterHistoryShortcut } from '../lib/history-shortcuts';
import SlidingIndicator from './SlidingIndicator.vue';

const props = defineProps<{
  modelValue: boolean;
  regions: ComponentReliefRegion[];
  outline: Array<[number, number]>;
  holes: Array<Array<[number, number]>>;
  pads: PadPolygon[];
  printSide: 'top' | 'bottom';
  width: number;
  height: number;
  depth: number;
  ejectHoleEnabled: boolean;
  validateRegions: (regions: ComponentReliefRegion[]) => Promise<{ valid: boolean; error?: string }>;
  mergeRegions: (regions: ComponentReliefRegion[], gap: number, selectedIds: string[]) => Promise<ComponentReliefMergeResult>;
  canUndo?: boolean;
  canRedo?: boolean;
  undo?: () => Promise<void> | void;
  redo?: () => Promise<void> | void;
}>();
const emit = defineEmits<{
  'update:modelValue': [value: boolean];
  'update:regions': [value: ComponentReliefRegion[]];
  'update:depth': [value: number];
  'update:ejectHoleEnabled': [value: boolean];
  'interaction-start': [];
  'interaction-end': [];
}>();
const { t } = useI18n();
const MAX_REGIONS = MAX_RELIEF_REGIONS;
const svg = ref<SVGSVGElement | null>(null);
const viewport = shallowRef({ width: 600, height: 400 });
let canvasObserver: ResizeObserver | undefined;
watch(svg, element => {
  canvasObserver?.disconnect();
  canvasObserver = undefined;
  if (!element) return;
  const update = (width: number, height: number) => {
    if (width > 0 && height > 0 && (viewport.value.width !== width || viewport.value.height !== height)) {
      viewport.value = { width, height };
    }
  };
  update(element.clientWidth, element.clientHeight);
  if (typeof ResizeObserver !== 'undefined') {
    canvasObserver = new ResizeObserver(entries => {
      const entry = entries.find(entry => entry.target === element);
      if (entry) update(entry.contentRect.width, entry.contentRect.height);
    });
    canvasObserver.observe(element);
  }
}, { flush: 'post' });
type Tool = 'select' | 'rect' | 'circle' | 'polygon';
const tool = ref<Tool>('rect');
const selectedIds = shallowRef<ReadonlySet<string>>(new Set());
const selectedId = computed(() => selectedIds.value.size === 1 ? [...selectedIds.value][0] : null);
const selectionCount = computed(() => selectedIds.value.size);
function setSelection(ids: Iterable<string>) { selectedIds.value = new Set(ids); }
const draft = shallowRef<ComponentReliefRegion | null>(null);
const marquee = shallowRef<{ start: ReliefPoint; end: ReliefPoint } | null>(null);
const marqueeBox = computed(() => marquee.value ? {
  x: Math.min(marquee.value.start.x, marquee.value.end.x), y: Math.min(marquee.value.start.y, marquee.value.end.y),
  width: Math.abs(marquee.value.end.x - marquee.value.start.x), height: Math.abs(marquee.value.end.y - marquee.value.start.y),
} : null);
const gestureKind = ref<'pan' | 'draw' | 'move' | 'resize' | 'vertex' | 'marquee' | null>(null);
const polygonPoints = shallowRef<Array<[number, number]>>([]);
const polygonHover = shallowRef<ReliefPoint | null>(null);
const historyPending = ref(false);
const historyAvailable = computed(() => Boolean(props.undo && props.redo));
const canUndoHere = computed(() => !historyPending.value && Boolean(gestureKind.value || polygonPoints.value.length || props.canUndo));
const canRedoHere = computed(() => !historyPending.value && !gestureKind.value && !polygonPoints.value.length && Boolean(props.canRedo));
const invalidPolygon = ref(false);
const vertexLimitReached = ref(false);
const allowance = ref(0.6);
const autoStatus = ref<'added' | 'none' | 'noPads' | 'invalid' | 'error' | ''>('');
const autoAdded = ref(0);
const autoLimited = ref(false);
const autoValidating = ref(false);
const merging = ref(false);
const mergeStatus = ref<'done' | 'unchanged' | 'invalid' | 'error' | ''>('');
const mergedCount = ref(0);
const skippedCount = ref(0);
const asyncBusy = computed(() => autoValidating.value || merging.value);
let validationSequence = 0;
let disposed = false;
// Both batch actions share a sequence so a manual edit invalidates either result.
function invalidateAutomatic() { ++validationSequence; autoValidating.value = false; merging.value = false; }
const bounds = computed(() => reliefEditorBounds(props.outline, props.width, props.height));
const fitView = computed(() => fitReliefView(bounds.value, props.printSide));
const view = shallowRef<ReliefView>(fitView.value);
const viewBox = computed(() => `${view.value.x} ${view.value.y} ${view.value.width} ${view.value.height}`);
const zoom = computed(() => Math.round(fitView.value.width / view.value.width * 100));
const limitReached = computed(() => props.regions.length >= MAX_REGIONS);
const mirrored = computed(() => props.printSide === 'bottom' ? -1 : 1);
const displayed = computed(() => draft.value
  ? props.regions.some(region => region.id === draft.value!.id)
    ? props.regions.map(region => region.id === draft.value!.id ? draft.value! : region)
    : [...props.regions, draft.value]
  : props.regions);
const selected = computed(() => displayed.value.find(region => region.id === selectedId.value) ?? null);
const selectedRegions = computed(() => displayed.value.filter(region => selectedIds.value.has(region.id)));
const selectedCutMode = computed(() => {
  const regions = selectedRegions.value;
  if (!regions.length) return null;
  const through = Boolean(regions[0].through);
  return regions.every(region => Boolean(region.through) === through) ? through : null;
});
const selectedDepth = computed(() => {
  const regions = selectedRegions.value;
  if (!regions.length) return undefined;
  const depth = reliefRegionDepth(regions[0], props.depth);
  return regions.every(region => reliefRegionDepth(region, props.depth) === depth) ? depth : undefined;
});
const selectedIndex = computed(() => displayed.value.findIndex(region => region.id === selectedId.value));
const invalidPlacement = ref(false);
const intersectsBoard = (region: ComponentReliefRegion) => reliefRegionIntersectsBoard(region,
  props.outline, props.holes, props.width, props.height);
// A viewport-scaled handle remains easy to grab at every zoom level.
const handleSize = computed(() => reliefHandleSize(view.value, viewport.value.width, viewport.value.height));
const cornerHandles = computed(() => {
  const region = selected.value;
  if (!region || tool.value !== 'select') return [];
  return (['nw', 'ne', 'sw', 'se'] as const).map(corner => ({ corner,
    x: region.x + (corner.endsWith('w') ? -1 : 1) * region.width / 2,
    y: region.y + (corner.startsWith('s') ? -1 : 1) * region.height / 2 }));
});

function ringPath(ring: ReadonlyArray<readonly [number, number]>): string {
  return ring.length >= 3 ? `M${ring.map(([x, y]) => `${x},${y}`).join('L')}Z` : '';
}
const boardPath = computed(() => {
  const b = bounds.value;
  const exterior = props.outline.length >= 3 ? props.outline
    : [[b.minX, b.minY], [b.maxX, b.minY], [b.maxX, b.maxY], [b.minX, b.maxY]] as Array<[number, number]>;
  return ringPath(exterior) + props.holes.map(ringPath).join('');
});
const padPaths = computed(() => reliefPadGuide(props.pads));
const instanceId = `relief-${Math.random().toString(36).slice(2)}`;
const boardClipId = `${instanceId}-board`;
const padMaskId = `${instanceId}-pads`;
const polygonDraftPath = computed(() => {
  if (!polygonPoints.value.length) return '';
  const hover = polygonHover.value;
  return `M${polygonPoints.value.map(([x, y]) => `${x},${y}`).join('L')}${hover ? `L${hover.x},${hover.y}` : ''}`;
});
const cloneRegion = (region: ComponentReliefRegion): ComponentReliefRegion => ({ ...region,
  ...(region.points ? { points: region.points.map(([x, y]) => [x, y] as [number, number]) } : {}) });
const newRegionId = () => `relief-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
function clearNotices() {
  invalidPlacement.value = false; invalidPolygon.value = false; vertexLimitReached.value = false;
  autoStatus.value = ''; autoLimited.value = false; mergeStatus.value = ''; mergedCount.value = 0; skippedCount.value = 0;
}
function cancelPolygon() { polygonPoints.value = []; polygonHover.value = null; vertexLimitReached.value = false; }
function commitRegions(regions: ComponentReliefRegion[]) {
  emit('interaction-start');
  emit('update:regions', regions);
  void nextTick(() => emit('interaction-end'));
}
function finishPolygon() {
  if (tool.value !== 'polygon' || !polygonPoints.value.length || gesture) return;
  invalidateAutomatic();
  const region = createReliefPolygon(polygonPoints.value, newRegionId(), props.depth);
  invalidPolygon.value = !region;
  if (!region) return;
  invalidPlacement.value = !intersectsBoard(region);
  if (invalidPlacement.value || limitReached.value) return;
  cancelPolygon();
  setSelection([region.id]);
  tool.value = 'select';
  commitRegions([...props.regions, region]);
}
function appendPolygonVertex(point: ReliefPoint) {
  const first = polygonPoints.value[0];
  if (first && polygonPoints.value.length >= 3 && Math.hypot(point.x - first[0], point.y - first[1]) < handleSize.value * 1.2) {
    finishPolygon(); return;
  }
  const last = polygonPoints.value[polygonPoints.value.length - 1];
  // The second pointerdown of a double click must not add the same vertex twice.
  if (last && Math.hypot(point.x - last[0], point.y - last[1]) < handleSize.value * .3) return;
  if (polygonPoints.value.length >= MAX_RELIEF_VERTICES) { vertexLimitReached.value = true; return; }
  const next: [number, number] = [Math.round(point.x * 1000) / 1000, Math.round(point.y * 1000) / 1000];
  if (!canAppendReliefVertex(polygonPoints.value, next)) { invalidPolygon.value = true; return; }
  polygonPoints.value = [...polygonPoints.value, next];
  polygonHover.value = point;
  setSelection([]);
}
async function automaticRelief() {
  if (asyncBusy.value || disposed || !props.modelValue) return;
  invalidateAutomatic();
  endGesture(true); cancelPolygon(); clearNotices();
  if (!props.pads.length) { autoStatus.value = 'noPads'; return; }
  const result = generateAutomaticRelief(props.pads, props.outline, props.holes, props.width, props.height,
    props.regions, Number.isFinite(allowance.value) ? allowance.value : 0.6);
  if (!result.added) { autoStatus.value = 'none'; autoLimited.value = result.limited; return; }
  const sequence = ++validationSequence;
  const existingIds = new Set(props.regions.map(region => region.id));
  const candidates = result.regions.map(region => ({ ...cloneRegion(region),
    ...(!existingIds.has(region.id) ? { depth: reliefRegionDepth(region, props.depth) } : {}) }));
  autoValidating.value = true;
  try {
    const validation = await props.validateRegions(candidates);
    if (disposed || sequence !== validationSequence || !props.modelValue) return;
    if (!validation.valid) { autoStatus.value = 'invalid'; return; }
    autoAdded.value = result.added;
    autoLimited.value = result.limited;
    autoStatus.value = 'added';
    tool.value = 'select';
    commitRegions(candidates);
    setSelection(candidates.filter(region => !existingIds.has(region.id)).map(region => region.id));
  } catch {
    if (!disposed && sequence === validationSequence && props.modelValue) autoStatus.value = 'error';
  } finally {
    // A superseded request must never clear the spinner of a newer validation.
    if (sequence === validationSequence) autoValidating.value = false;
  }
}

async function mergeRelief() {
  if (asyncBusy.value || disposed || !props.modelValue || selectionCount.value < 2) return;
  invalidateAutomatic();
  endGesture(true); cancelPolygon(); clearNotices();
  const sequence = ++validationSequence;
  const candidates = props.regions.map(cloneRegion);
  const ids = candidates.filter(region => selectedIds.value.has(region.id)).map(region => region.id);
  if (ids.length < 2) return;
  const unselectedIds = new Set(candidates.filter(region => !selectedIds.value.has(region.id)).map(region => region.id));
  merging.value = true;
  try {
    // The backend already checks support islands for the merged geometry.
    // Keep the legacy command argument; selected areas use their enclosing box.
    const result = await props.mergeRegions(candidates, 0, ids);
    if (disposed || sequence !== validationSequence || !props.modelValue) return;
    if (!result.valid) { mergeStatus.value = 'invalid'; return; }
    mergedCount.value = result.merged;
    skippedCount.value = result.skipped;
    if (!result.merged) { mergeStatus.value = 'unchanged'; return; }
    const regions = result.regions.map(cloneRegion);
    mergeStatus.value = 'done';
    tool.value = 'select';
    commitRegions(regions);
    setSelection(regions.filter(region => !unselectedIds.has(region.id)).map(region => region.id));
  } catch {
    if (!disposed && sequence === validationSequence && props.modelValue) mergeStatus.value = 'error';
  } finally {
    if (sequence === validationSequence) merging.value = false;
  }
}

interface BaseGesture { pointerId: number; matrix: DOMMatrix; start: ReliefPoint; moved: boolean }
type Gesture = BaseGesture & (
  { kind: 'pan'; view: ReliefView }
  | { kind: 'marquee'; selection: string[]; additive: boolean }
  | { kind: 'draw'; shape: 'rect' | 'circle'; id: string }
  | { kind: 'move'; region: ComponentReliefRegion }
  | { kind: 'resize'; region: ComponentReliefRegion; corner: ReliefCorner }
  | { kind: 'vertex'; region: ComponentReliefRegion; index: number }
);
let gesture: Gesture | null = null;
let frame = 0;
let pendingPoint: ReliefPoint | null = null;

function worldPoint(event: { clientX: number; clientY: number }, matrix?: DOMMatrix): ReliefPoint | null {
  const transform = matrix ?? svg.value?.getScreenCTM()?.inverse();
  if (!transform) return null;
  const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(transform);
  return Number.isFinite(point.x) && Number.isFinite(point.y) ? { x: point.x, y: point.y } : null;
}
const canonicalPoint = (point: ReliefPoint) => reliefScreenPoint(point, props.printSide);

function pointerDown(event: PointerEvent) {
  if (gesture || ![0, 2].includes(event.button) || !svg.value || event.isPrimary === false) return;
  if (event.button !== 2) invalidateAutomatic();
  const matrix = svg.value.getScreenCTM()?.inverse();
  const start = matrix ? worldPoint(event, matrix) : null;
  if (!matrix || !start) return;
  event.preventDefault();
  clearNotices();
  svg.value.focus({ preventScroll: true });
  const base = { pointerId: event.pointerId, matrix, start, moved: false };
  if (event.button === 2) {
    gesture = { ...base, kind: 'pan', view: { ...view.value } };
  } else if (tool.value === 'polygon') {
    if (limitReached.value) return;
    const canonical = canonicalPoint(start), b = bounds.value;
    if (canonical.x < b.minX || canonical.x > b.maxX || canonical.y < b.minY || canonical.y > b.maxY) return;
    appendPolygonVertex(canonical);
    return;
  } else if (tool.value !== 'select') {
    if (limitReached.value) return;
    const canonical = canonicalPoint(start);
    const b = bounds.value;
    if (canonical.x < b.minX || canonical.x > b.maxX || canonical.y < b.minY || canonical.y > b.maxY) return;
    gesture = { ...base, kind: 'draw', shape: tool.value, id: newRegionId() };
    emit('interaction-start');
  } else {
    const target = event.target instanceof Element ? event.target.closest<SVGElement>('[data-relief-id]') : null;
    const region = props.regions.find(item => item.id === target?.dataset.reliefId);
    if (!region) {
      const selection = [...selectedIds.value];
      gesture = { ...base, kind: 'marquee', selection, additive: event.shiftKey || event.ctrlKey || event.metaKey };
      if (!gesture.additive) setSelection([]);
      marquee.value = { start, end: start };
      gestureKind.value = 'marquee';
      svg.value.setPointerCapture(event.pointerId);
      return;
    }
    if (event.shiftKey || event.ctrlKey || event.metaKey) {
      const next = new Set(selectedIds.value);
      if (next.has(region.id)) next.delete(region.id); else next.add(region.id);
      setSelection(next);
      return;
    }
    setSelection([region.id]);
    const corner = target?.dataset.corner as ReliefCorner | undefined;
    const vertex = target?.dataset.vertex;
    gesture = vertex !== undefined ? { ...base, kind: 'vertex', region: cloneRegion(region), index: Number(vertex) }
      : corner ? { ...base, kind: 'resize', region: cloneRegion(region), corner }
        : { ...base, kind: 'move', region: cloneRegion(region) };
    draft.value = cloneRegion(region);
    emit('interaction-start');
  }
  gestureKind.value = gesture.kind;
  svg.value.setPointerCapture(event.pointerId);
}

function updateGesture(point: ReliefPoint) {
  const active = gesture;
  if (!active) return;
  if (active.kind === 'pan') {
    view.value = { ...active.view, x: active.view.x - (point.x - active.start.x), y: active.view.y - (point.y - active.start.y) };
    return;
  }
  const start = canonicalPoint(active.start), end = canonicalPoint(point);
  active.moved ||= Math.hypot(point.x - active.start.x, point.y - active.start.y) > handleSize.value * 3 / 8;
  if (active.kind === 'marquee') {
    if (active.moved) {
      marquee.value = { start: active.start, end: point };
      const hits = reliefRegionsInMarquee(props.regions, start, end);
      setSelection(active.additive ? [...active.selection, ...hits] : hits);
    }
    return;
  }
  if (active.kind === 'draw') draft.value = drawReliefRegion(active.shape, start, end, bounds.value, active.id, props.depth);
  else if (active.kind === 'move') draft.value = moveReliefRegion(active.region,
    { x: end.x - start.x, y: end.y - start.y }, bounds.value);
  else if (active.kind === 'vertex') draft.value = updateReliefVertex(active.region, active.index, end, bounds.value);
  else draft.value = resizeReliefRegion(active.region, active.corner, clampReliefPoint(end, bounds.value), bounds.value);
}

function flushPoint() {
  if (frame) cancelAnimationFrame(frame);
  frame = 0;
  if (pendingPoint) {
    if (gesture) updateGesture(pendingPoint);
    else if (tool.value === 'polygon' && polygonPoints.value.length) polygonHover.value = clampReliefPoint(canonicalPoint(pendingPoint), bounds.value);
  }
  pendingPoint = null;
}
function pointerMove(event: PointerEvent) {
  if (gesture && event.pointerId !== gesture.pointerId || !gesture && (tool.value !== 'polygon' || !polygonPoints.value.length)) return;
  const point = worldPoint(event, gesture?.matrix);
  if (!point) return;
  pendingPoint = point;
  if (!frame) frame = requestAnimationFrame(() => { frame = 0; flushPoint(); });
}
function endGesture(cancel = false, event?: PointerEvent) {
  const active = gesture;
  if (!active || event && active.pointerId !== event.pointerId) return;
  if (event && !cancel) pendingPoint = worldPoint(event, active.matrix);
  flushPoint();
  const region = draft.value;
  gesture = null;
  draft.value = null;
  gestureKind.value = null;
  if (svg.value?.hasPointerCapture(active.pointerId)) svg.value.releasePointerCapture(active.pointerId);
  if (active.kind === 'pan') return;
  if (active.kind === 'marquee') {
    if (cancel) setSelection(active.selection);
    marquee.value = null;
    return;
  }
  if (!cancel && region && active.moved && region.shape === 'polygon' && !isValidReliefPolygon(region.points ?? [])) invalidPolygon.value = true;
  else if (!cancel && region && active.moved && !intersectsBoard(region)) invalidPlacement.value = true;
  else if (!cancel && region && active.moved) {
    const exists = props.regions.some(item => item.id === region.id);
    if (exists || props.regions.length < MAX_REGIONS) {
      const changed = !exists || JSON.stringify(region) !== JSON.stringify(props.regions.find(item => item.id === region.id));
      if (changed) emit('update:regions', exists ? props.regions.map(item => item.id === region.id ? region : item) : [...props.regions, region]);
      setSelection([region.id]);
      if (active.kind === 'draw') tool.value = 'select';
    }
  }
  void nextTick(() => emit('interaction-end'));
}

function fit() { endGesture(true); view.value = { ...fitView.value }; }
function zoomBy(factor: number, anchor = { x: view.value.x + view.value.width / 2, y: view.value.y + view.value.height / 2 }) {
  if (!gesture) view.value = zoomReliefView(view.value, anchor, factor, fitView.value);
}
function wheel(event: WheelEvent) {
  const point = worldPoint(event);
  if (point && !gesture) zoomBy(Math.exp(-Math.max(-100, Math.min(100, event.deltaY)) * 0.002), point);
}
function chooseTool(value: Tool) { invalidateAutomatic(); endGesture(true); cancelPolygon(); clearNotices(); tool.value = value; }
function chooseRegion(id: string, event?: MouseEvent) {
  invalidateAutomatic(); endGesture(true); cancelPolygon(); clearNotices(); tool.value = 'select';
  if (event?.shiftKey || event?.ctrlKey || event?.metaKey) {
    const next = new Set(selectedIds.value);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelection(next);
  } else setSelection([id]);
}
function selectAll() {
  invalidateAutomatic(); endGesture(true); cancelPolygon(); clearNotices(); tool.value = 'select';
  setSelection(props.regions.map(region => region.id));
}
function clearSelection() { invalidateAutomatic(); endGesture(true); cancelPolygon(); clearNotices(); setSelection([]); }
function updateDefaultDepth(value: number | undefined) {
  if (value === undefined || !Number.isFinite(value) || value < 0.5 || value > 20 || value === props.depth) return;
  invalidateAutomatic(); endGesture(true); cancelPolygon(); clearNotices();
  emit('interaction-start'); emit('update:depth', value);
  void nextTick(() => emit('interaction-end'));
}
function updateEjectHoleEnabled(enabled: boolean | string | number) {
  if (typeof enabled !== 'boolean' || disposed || !props.modelValue || historyPending.value || enabled === props.ejectHoleEnabled) return;
  invalidateAutomatic(); endGesture(true); cancelPolygon(); clearNotices();
  emit('interaction-start'); emit('update:ejectHoleEnabled', enabled);
  void nextTick(() => emit('interaction-end'));
}
function updateNumber(key: 'x' | 'y' | 'width' | 'height', value: number | undefined) {
  if (!selected.value || value === undefined || !Number.isFinite(value)) return;
  const region = updateReliefDimensions(selected.value, { [key]: value }, bounds.value);
  // Number fields may emit their current or clamped value when blurred. This
  // is not an edit and must not cancel a pending automatic support check.
  if (JSON.stringify(region) === JSON.stringify(selected.value)) return;
  invalidPolygon.value = region.shape === 'polygon' && !isValidReliefPolygon(region.points ?? []);
  if (invalidPolygon.value) return;
  invalidPlacement.value = !intersectsBoard(region);
  if (invalidPlacement.value) return;
  invalidateAutomatic();
  endGesture(true);
  clearNotices();
  commitRegions(props.regions.map(item => item.id === region.id ? region : item));
}
function updateSelectedDepth(value: number | undefined) {
  if (!selectedRegions.value.length || selectedCutMode.value !== false || value === undefined || !Number.isFinite(value) || value < 0.5 || value > 20
    || selectedRegions.value.every(region => region.depth !== undefined && region.depth === value)) return;
  invalidateAutomatic();
  const ids = new Set(selectedIds.value);
  endGesture(true);
  clearNotices();
  commitRegions(props.regions.map(region => ids.has(region.id) ? { ...cloneRegion(region), depth: value } : region));
}
function updateSelectedCutMode(through: boolean) {
  if (!selectedRegions.value.length || selectedCutMode.value === through) return;
  invalidateAutomatic();
  const ids = new Set(selectedIds.value);
  endGesture(true);
  clearNotices();
  commitRegions(props.regions.map(region => ids.has(region.id) && Boolean(region.through) !== through ? { ...cloneRegion(region), through,
    depth: reliefRegionDepth(region, props.depth) } : region));
}
function removeSelected() {
  if (!selectionCount.value) return;
  invalidateAutomatic();
  endGesture(true);
  commitRegions(props.regions.filter(region => !selectedIds.value.has(region.id)));
  setSelection([]);
}
async function applyHistory(action: 'undo' | 'redo') {
  if (!historyAvailable.value || disposed || !props.modelValue || historyPending.value
    || !(action === 'undo' ? canUndoHere.value : canRedoHere.value)) return;
  invalidateAutomatic();
  if (action === 'undo' && gesture) { endGesture(true); clearNotices(); return; }
  if (action === 'undo' && polygonPoints.value.length) {
    polygonPoints.value = polygonPoints.value.slice(0, -1);
    polygonHover.value = null;
    clearNotices();
    return;
  }
  endGesture(true); cancelPolygon(); clearNotices();
  historyPending.value = true;
  try { await props[action]?.(); }
  finally { historyPending.value = false; }
}
function onKeydown(event: KeyboardEvent) {
  const historyAction = historyAvailable.value ? parameterHistoryShortcut(event) : null;
  if (historyAction) {
    event.preventDefault(); event.stopPropagation();
    void applyHistory(historyAction);
  }
  else if (event.key === 'Escape' && (gesture || polygonPoints.value.length)) { event.preventDefault(); event.stopPropagation(); endGesture(true); cancelPolygon(); }
  else if (event.target === svg.value && tool.value === 'polygon' && polygonPoints.value.length && event.key === 'Enter') {
    event.preventDefault(); event.stopPropagation(); finishPolygon();
  } else if (event.target === svg.value && tool.value === 'polygon' && polygonPoints.value.length && event.key === 'Backspace') {
    event.preventDefault(); polygonPoints.value = polygonPoints.value.slice(0, -1); clearNotices();
    if (!polygonPoints.value.length) polygonHover.value = null;
  }
  else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a' && event.target === svg.value) {
    event.preventDefault(); selectAll();
  }
  else if (event.key === 'Escape' && selectionCount.value) { event.preventDefault(); event.stopPropagation(); clearSelection(); }
  else if (['Delete', 'Backspace'].includes(event.key) && event.target === svg.value && selectionCount.value) {
    event.preventDefault(); removeSelected();
  }
}
function close() { invalidateAutomatic(); endGesture(true); cancelPolygon(); emit('update:modelValue', false); }
// Losing focus only ends a live pointer gesture. It does not change the board
// or the proposals, so background checks and unfinished polygon points remain valid.
function onBlur() { endGesture(true); polygonHover.value = null; }
function onVisibility() { if (document.hidden) onBlur(); }
let listening = false;
function syncListeners(open: boolean) {
  if (open && !listening) { window.addEventListener('blur', onBlur); document.addEventListener('visibilitychange', onVisibility); listening = true; }
  else if (!open && listening) { window.removeEventListener('blur', onBlur); document.removeEventListener('visibilitychange', onVisibility); listening = false; }
}
watch(() => props.modelValue, async open => {
  invalidateAutomatic();
  endGesture(true);
  cancelPolygon();
  syncListeners(open);
  if (open) {
    setSelection([]);
    clearNotices();
    tool.value = props.regions.length ? 'select' : 'rect';
    await nextTick();
    fit();
  }
}, { immediate: true });
watch(() => [props.outline, props.holes, props.width, props.height, props.printSide, props.pads], () => {
  invalidateAutomatic(); endGesture(true); cancelPolygon(); setSelection([]); clearNotices(); fit();
}, { flush: 'sync' });
watch(() => [props.depth, props.ejectHoleEnabled], () => { invalidateAutomatic(); endGesture(true); cancelPolygon(); clearNotices(); }, { flush: 'sync' });
watch(() => props.regions, regions => {
  invalidateAutomatic();
  if (gesture && gesture.kind !== 'pan') endGesture(true);
  cancelPolygon();
  setSelection(regions.filter(region => selectedIds.value.has(region.id)).map(region => region.id));
}, { flush: 'sync' });
watch(allowance, () => { invalidateAutomatic(); clearNotices(); }, { flush: 'sync' });
watch(tool, invalidateAutomatic, { flush: 'sync' });
onBeforeUnmount(() => { disposed = true; canvasObserver?.disconnect(); invalidateAutomatic(); endGesture(true); cancelPolygon(); syncListeners(false); });
</script>

<template>
  <el-dialog :model-value="modelValue" :title="t('relief.editorTitle')" class="component-relief-dialog"
    width="1040px" append-to-body align-center :close-on-click-modal="false" :z-index="3200"
    :close-on-press-escape="!polygonPoints.length && !gestureKind"
    @update:model-value="(value: boolean) => value ? emit('update:modelValue', true) : close()" @close="close">
    <div class="relief-editor" @keydown="onKeydown">
      <div class="editor-intro">
        <p>{{ t('relief.editorSubtitle') }}</p>
        <span class="editor-count">{{ t('relief.regionCount', { n: regions.length }) }}</span>
      </div>
      <div class="editor-toolbar">
        <div class="draw-tools" :aria-label="t('relief.editorTitle')">
          <SlidingIndicator />
          <button type="button" :class="{ active: tool === 'select' }" :aria-pressed="tool === 'select'" @click="chooseTool('select')">
            <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="m4 2 8 7-4 .5-2 3.5z" /></svg>{{ t('relief.selectTool') }}
          </button>
          <button type="button" :class="{ active: tool === 'rect' }" :aria-pressed="tool === 'rect'" :disabled="limitReached" @click="chooseTool('rect')">
            <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><rect x="3" y="4" width="10" height="8" rx="1" /></svg>{{ t('relief.rectangleTool') }}
          </button>
          <button type="button" :class="{ active: tool === 'circle' }" :aria-pressed="tool === 'circle'" :disabled="limitReached" @click="chooseTool('circle')">
            <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><circle cx="8" cy="8" r="5" /></svg>{{ t('relief.circleTool') }}
          </button>
          <button type="button" :class="{ active: tool === 'polygon' }" :aria-pressed="tool === 'polygon'" :disabled="limitReached" @click="chooseTool('polygon')">
            <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="m3 4 7-2 3 7-5 4-6-3z" /><circle cx="3" cy="4" r="1" /></svg>{{ t('relief.polygonTool') }}
          </button>
        </div>
        <div class="zoom-tools">
          <template v-if="historyAvailable">
            <button type="button" class="editor-history-button" :disabled="!canUndoHere" :title="t('history.undoHint')"
              :aria-label="t('history.undo')" aria-keyshortcuts="Control+Z Meta+Z" @click="applyHistory('undo')">
              <svg viewBox="0 0 20 20" width="15" height="15" aria-hidden="true"><path d="m7 4-4 4 4 4M3.5 8H12a4.5 4.5 0 0 1 0 9" /></svg>
            </button>
            <button type="button" class="editor-history-button" :disabled="!canRedoHere" :title="t('history.redoHint')"
              :aria-label="t('history.redo')" aria-keyshortcuts="Control+Y Control+Shift+Z Meta+Shift+Z" @click="applyHistory('redo')">
              <svg viewBox="0 0 20 20" width="15" height="15" aria-hidden="true"><path d="m13 4 4 4-4 4M16.5 8H8a4.5 4.5 0 0 0 0 9" /></svg>
            </button>
            <span class="tool-divider" aria-hidden="true" />
          </template>
          <button type="button" :aria-label="t('relief.zoomOut')" @click="zoomBy(1 / 1.25)">−</button>
          <span>{{ zoom }}%</span>
          <button type="button" :aria-label="t('relief.zoomIn')" @click="zoomBy(1.25)">+</button>
          <button type="button" class="fit-button" @click="fit">{{ t('relief.fit') }}</button>
        </div>
      </div>
      <div class="generation-panel">
        <div class="new-region-settings">
          <label class="default-depth-control">
            <span>{{ t('relief.defaultDepth') }}</span>
            <span class="unit-input"><el-input-number :model-value="depth" :min="0.5" :max="20" :step="0.5" :precision="1" :controls="false" size="small"
              :aria-label="t('relief.defaultDepth')" @update:model-value="updateDefaultDepth" /><span>mm</span></span>
          </label>
          <p>{{ t('relief.newRegionDepthHint') }}</p>
        </div>
        <div class="automatic-tools">
          <label class="allowance-control"><span>{{ t('relief.allowance') }}</span>
            <span class="unit-input"><el-input-number v-model="allowance" :min="0.1" :max="5" :step="0.1" :precision="1" :controls="false" size="small" :aria-label="t('relief.allowance')" /><span>mm</span></span>
          </label>
        <button type="button" class="automatic-button" :disabled="limitReached || asyncBusy" :aria-busy="autoValidating"
          :aria-label="t(autoValidating ? 'relief.autoValidating' : 'relief.autoGenerate')" @click="automaticRelief">
          <svg v-if="autoValidating" class="validation-spinner" viewBox="0 0 18 18" width="16" height="16" aria-hidden="true"><path d="M9 2a7 7 0 1 1-7 7" /></svg>
          <svg v-else viewBox="0 0 18 18" width="16" height="16" aria-hidden="true"><path d="m3 13 8-8 3 3-8 8zM12 2v2M16 5h-2M4 3v3M2.5 4.5h3M9 11l-2-2" /></svg>
          <span class="action-label" aria-hidden="true">
            <span :class="{ 'is-visible': !autoValidating }">{{ t('relief.autoGenerate') }}</span>
            <span :class="{ 'is-visible': autoValidating }">{{ t('relief.autoValidating') }}</span>
          </span>
        </button>
        <p>{{ t('relief.autoGenerateHint') }}</p>
        </div>
      </div>
      <div class="editor-workspace">
        <div class="editor-canvas" :class="{ drawing: tool !== 'select', panning: gestureKind === 'pan' }">
          <svg ref="svg" :viewBox="viewBox" preserveAspectRatio="xMidYMid meet" tabindex="0"
            :aria-label="t('relief.editorTitle')" @pointerdown="pointerDown" @pointermove="pointerMove"
            @pointerup="endGesture(false, $event)" @pointercancel="endGesture(true, $event)"
            @lostpointercapture="endGesture(true, $event)" @contextmenu.prevent @wheel.prevent="wheel"
            @dblclick.stop.prevent="finishPolygon">
            <defs>
              <clipPath :id="boardClipId"><path :d="boardPath" clip-rule="evenodd" /></clipPath>
              <mask v-for="pad in padPaths.masked" :id="`${padMaskId}-${pad.sourceIndex}`" :key="pad.sourceIndex"
                maskUnits="userSpaceOnUse" :x="bounds.minX" :y="bounds.minY"
                :width="bounds.maxX - bounds.minX" :height="bounds.maxY - bounds.minY">
                <rect :x="bounds.minX" :y="bounds.minY" :width="bounds.maxX - bounds.minX" :height="bounds.maxY - bounds.minY" fill="black" />
                <path v-for="(exposure, index) in pad.exposures" :key="index" :d="exposure.path"
                  :fill="exposure.polarity === 'D' ? 'white' : 'black'" fill-rule="nonzero" />
              </mask>
              <mask :id="padMaskId" maskUnits="userSpaceOnUse" :x="bounds.minX" :y="bounds.minY"
                :width="bounds.maxX - bounds.minX" :height="bounds.maxY - bounds.minY">
                <rect :x="bounds.minX" :y="bounds.minY" :width="bounds.maxX - bounds.minX" :height="bounds.maxY - bounds.minY" fill="black" />
                <path v-for="(exposure, index) in padPaths.exposures" :key="index" :d="exposure.path"
                  :fill="exposure.polarity === 'D' ? 'white' : 'black'" fill-rule="nonzero"
                  :mask="exposure.maskIndex === undefined ? undefined : `url(#${padMaskId}-${exposure.maskIndex})`" />
              </mask>
            </defs>
            <g :transform="`scale(1, ${-mirrored})`">
              <path :d="boardPath" class="board-outline" />
              <g :clip-path="`url(#${boardClipId})`">
                <rect :x="bounds.minX" :y="bounds.minY" :width="bounds.maxX - bounds.minX" :height="bounds.maxY - bounds.minY"
                  class="pad-guide" :mask="`url(#${padMaskId})`" />
                <g v-for="region in displayed" :key="region.id" :data-relief-id="region.id"
                  class="relief-region" :class="{ selected: selectedIds.has(region.id), draft: draft?.id === region.id, through: region.through }">
                  <ellipse v-if="region.shape === 'circle'" :cx="region.x" :cy="region.y" :rx="region.width / 2" :ry="region.height / 2" />
                  <path v-else-if="region.shape === 'polygon'" :d="ringPath(region.points ?? [])" />
                  <rect v-else :x="region.x - region.width / 2" :y="region.y - region.height / 2" :width="region.width" :height="region.height" />
                </g>
              </g>
              <g v-if="selected && tool === 'select'" class="selection-handles">
                <rect class="region-bounds" :x="selected.x - selected.width / 2" :y="selected.y - selected.height / 2"
                  :width="selected.width" :height="selected.height" />
                <rect v-for="handle in cornerHandles" :key="handle.corner" :data-relief-id="selected.id" :data-corner="handle.corner"
                  :x="handle.x - handleSize / 2" :y="handle.y - handleSize / 2" :width="handleSize" :height="handleSize"
                  class="resize-handle" :class="handle.corner" />
                <g v-if="selected.shape === 'polygon'">
                  <circle v-for="(point, index) in selected.points" :key="index" :data-relief-id="selected.id" :data-vertex="index"
                    :cx="point[0]" :cy="point[1]" :r="handleSize * .55" class="vertex-handle" />
                </g>
              </g>
              <g v-if="polygonPoints.length" class="polygon-draft" aria-hidden="true">
                <path :d="polygonDraftPath" />
                <circle v-for="(point, index) in polygonPoints" :key="index" :cx="point[0]" :cy="point[1]"
                  :r="handleSize * (index === 0 ? .7 : .38)" :class="{ 'start-vertex': index === 0 }" />
              </g>
            </g>
            <rect v-if="marqueeBox" class="marquee-selection" :x="marqueeBox.x" :y="marqueeBox.y"
              :width="marqueeBox.width" :height="marqueeBox.height" aria-hidden="true" />
            <g class="region-labels" aria-hidden="true">
              <text v-for="(region, index) in displayed" :key="region.id" :x="region.x"
                :y="reliefScreenPoint({ x: region.x, y: region.y }, printSide).y"
                :font-size="handleSize * 1.6">{{ index + 1 }}</text>
            </g>
          </svg>
          <div class="canvas-feedback" :class="{ 'is-visible': autoStatus || autoLimited || mergeStatus }" role="status" aria-live="polite">
            <div v-if="autoStatus || autoLimited" class="generation-result" :class="{ warning: autoStatus === 'invalid' || autoStatus === 'error' }">
              <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><circle cx="8" cy="8" r="6" /><path v-if="autoStatus === 'invalid' || autoStatus === 'error'" d="M8 4.5v4M8 11v.1" /><path v-else d="m5 8 2 2 4-4" /></svg>
              <span><span v-if="autoStatus">{{ t(autoStatus === 'added' ? 'relief.autoAdded' : autoStatus === 'noPads' ? 'relief.autoNoPads' : autoStatus === 'invalid' ? 'relief.autoSupportWarning' : autoStatus === 'error' ? 'relief.autoFailed' : 'relief.autoNoNew', { n: autoAdded }) }}</span><span v-if="autoLimited"> {{ t('relief.autoLimit') }}</span></span>
            </div>
            <div v-if="mergeStatus" class="generation-result" :class="{ warning: mergeStatus === 'invalid' || mergeStatus === 'error' }">
              <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><circle cx="8" cy="8" r="6" /><path v-if="mergeStatus === 'invalid' || mergeStatus === 'error'" d="M8 4.5v4M8 11v.1" /><path v-else d="m5 8 2 2 4-4" /></svg>
              <span>{{ t(mergeStatus === 'done' ? 'relief.mergeDone' : mergeStatus === 'invalid' ? 'relief.mergeInvalid' : mergeStatus === 'error' ? 'relief.mergeError' : 'relief.mergeUnchanged', { count: mergedCount }) }}<span v-if="skippedCount"> {{ t('relief.mergeSkipped', { count: skippedCount }) }}</span></span>
            </div>
          </div>
          <div v-if="tool === 'polygon'" class="canvas-hint polygon-hint" aria-hidden="true">{{ t('relief.polygonHint') }}<span>{{ polygonPoints.length }} / {{ MAX_RELIEF_VERTICES }} · {{ t('relief.polygonGestures') }}</span></div>
          <div v-else-if="!displayed.length" class="canvas-hint" aria-hidden="true">{{ t('relief.emptyHint') }}</div>
          <div class="canvas-legend" aria-hidden="true">
            <span><i class="support-dot" />{{ t('relief.supportLegend') }}</span>
            <span><i class="relief-dot" />{{ t('relief.cutLegend') }}</span>
          </div>
        </div>
        <aside class="region-properties">
          <div class="tray-opening-control">
            <span>{{ t('config.ejectSlot') }}</span>
            <el-switch :model-value="ejectHoleEnabled" :disabled="historyPending" :aria-label="t('config.ejectSlot')" @update:model-value="updateEjectHoleEnabled" />
          </div>
          <div class="properties-heading"><strong>{{ t('relief.selectionTitle') }}</strong><span class="selection-count">{{ selectionCount }}</span></div>
          <div class="selection-controls">
            <span>{{ t('relief.selectedCount', { n: selectionCount }) }}</span>
            <button type="button" class="select-all" :disabled="!regions.length || selectionCount === regions.length" @click="selectAll">{{ t('relief.selectAll') }}</button>
            <button type="button" class="clear-selection" :disabled="!selectionCount" @click="clearSelection">{{ t('relief.clearSelection') }}</button>
          </div>
          <div v-if="regions.length" class="region-list" :aria-label="t('relief.cutLegend')">
            <button v-for="(region, index) in regions" :key="region.id" type="button" :class="{ active: selectedIds.has(region.id) }"
              :aria-label="t('relief.selectedRegion', { n: index + 1 })" :aria-pressed="selectedIds.has(region.id)" @click="chooseRegion(region.id, $event)">{{ index + 1 }}</button>
          </div>
          <div v-if="selectionCount" class="selected-properties">
            <div class="selected-heading"><span>{{ t(selected ? 'relief.selectedRegion' : 'relief.batchProperties', { n: selectedIndex + 1 }) }}</span><small v-if="selected">{{ t(selected.shape === 'circle' ? 'relief.circleTool' : selected.shape === 'polygon' ? 'relief.polygonTool' : 'relief.rectangleTool') }}</small></div>
            <div class="region-cut-mode">
              <span>{{ t('relief.cutMode') }}</span>
              <div class="cut-mode-switch" role="group" :aria-label="t('relief.cutMode')">
                <SlidingIndicator />
                <button type="button" :class="{ active: selectedCutMode === false }" :aria-pressed="selectedCutMode === false" @click="updateSelectedCutMode(false)">{{ t('relief.blind') }}</button>
                <button type="button" :class="{ active: selectedCutMode === true }" :aria-pressed="selectedCutMode === true" @click="updateSelectedCutMode(true)">{{ t('relief.through') }}</button>
              </div>
            </div>
            <div class="property-grid">
              <template v-if="selected">
                <label>{{ t('relief.centerX') }}<el-input-number :model-value="selected.x" :precision="2" :step="0.5" :controls="false" size="small" @update:model-value="(value: number | undefined) => updateNumber('x', value)" /></label>
                <label>{{ t('relief.centerY') }}<el-input-number :model-value="selected.y" :precision="2" :step="0.5" :controls="false" size="small" @update:model-value="(value: number | undefined) => updateNumber('y', value)" /></label>
                <label>{{ t(selected.shape === 'circle' ? 'relief.diameter' : 'relief.width') }}<el-input-number :model-value="selected.width" :min="0.5" :max="bounds.maxX - bounds.minX" :precision="2" :step="0.5" :controls="false" size="small" @update:model-value="(value: number | undefined) => updateNumber('width', value)" /></label>
                <label v-if="selected.shape !== 'circle'">{{ t('relief.height') }}<el-input-number :model-value="selected.height" :min="0.5" :max="bounds.maxY - bounds.minY" :precision="2" :step="0.5" :controls="false" size="small" @update:model-value="(value: number | undefined) => updateNumber('height', value)" /></label>
              </template>
              <div class="depth-setting">
                <label v-if="selectedCutMode === false" class="region-depth-field" :title="t('relief.regionDepthHint')">{{ t('relief.regionDepth') }} <span class="depth-unit">mm</span>
                  <el-input-number :model-value="selectedDepth" :min="0.5" :max="20" :precision="1" :step="0.5" :controls="false" size="small"
                    :placeholder="selectedDepth === undefined ? t('relief.mixedValues') : undefined" :aria-label="t('relief.regionDepth')" @update:model-value="updateSelectedDepth" />
                </label>
                <p v-else class="through-hint"><svg viewBox="0 0 18 18" width="18" height="18" aria-hidden="true"><path d="M3 6h12M3 12h12M9 2v14m-3-3 3 3 3-3" /></svg>{{ t(selectedCutMode === true ? 'relief.throughHint' : 'relief.mixedCutMode') }}</p>
              </div>
            </div>
            <p class="property-hint">{{ t(selected ? selected.shape === 'polygon' ? 'relief.vertexHint' : 'relief.selectedHint' : 'relief.batchEditHint') }}</p>
          </div>
          <p v-else class="property-empty">{{ t('relief.noSelectionHint') }}</p>
          <div class="selection-actions">
            <button type="button" class="automatic-button merge-button" :disabled="selectionCount < 2 || asyncBusy" :aria-busy="merging"
              :aria-label="t(merging ? 'relief.merging' : 'relief.mergeSelection')" @click="mergeRelief">
              <svg v-if="merging" class="validation-spinner" viewBox="0 0 18 18" width="16" height="16" aria-hidden="true"><path d="M9 2a7 7 0 1 1-7 7" /></svg>
              <svg v-else viewBox="0 0 18 18" width="16" height="16" aria-hidden="true"><path d="M6 2H3a1 1 0 0 0-1 1v3m10-4h3a1 1 0 0 1 1 1v3M2 12v3a1 1 0 0 0 1 1h3m10-4v3a1 1 0 0 1-1 1h-3M5 5h8v8H5z" /></svg>
              <span class="action-label" aria-hidden="true">
                <span :class="{ 'is-visible': !merging }">{{ t('relief.mergeSelection') }}</span>
                <span :class="{ 'is-visible': merging }">{{ t('relief.merging') }}</span>
              </span>
            </button>
            <p>{{ t('relief.mergeSelectionHint') }}</p>
            <button type="button" class="delete-region" :disabled="!selectionCount" @click="removeSelected">
              <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3 4h10M6 4V2h4v2M4 4l.7 9h6.6l.7-9M6.5 6v5M9.5 6v5" /></svg>{{ t('relief.deleteSelected') }}
            </button>
          </div>
          <p v-if="limitReached" class="limit-notice" role="status">{{ t('relief.limitReached', { n: MAX_REGIONS }) }}</p>
          <p v-if="vertexLimitReached" class="limit-notice" role="status">{{ t('relief.vertexLimit', { n: MAX_RELIEF_VERTICES }) }}</p>
          <p v-if="invalidPolygon" class="limit-notice" role="status">{{ t('relief.polygonInvalid') }}</p>
          <p v-if="invalidPlacement" class="limit-notice" role="status">{{ t('relief.outsideBoard') }}</p>
          <div class="orientation-note">
            <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true"><path d="m3 7 7-4 7 4-7 4zM3 11l7 4 7-4M3 14l7 4 7-4" /></svg>
            <span>{{ t(printSide === 'top' ? 'relief.orientationTop' : 'relief.orientationBottom') }}</span>
          </div>
          <p class="pad-guide-note">{{ t(pads.length ? 'relief.padGuide' : 'relief.noPadsHint') }}</p>
        </aside>
      </div>
      <div class="editor-bottom"><span>{{ t('relief.gestures') }}</span><span>{{ t('relief.liveHint') }}</span></div>
    </div>
    <template #footer><button type="button" class="relief-done" @click="close">{{ t('relief.done') }}</button></template>
  </el-dialog>
</template>

<style scoped>
.relief-editor { min-height: 0; color: var(--text-default); font-family: inherit; }
.editor-intro { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 14px; }
.editor-intro p { margin: 0; color: var(--text-secondary); font-size: 12px; line-height: 1.6; }
.editor-count { flex-shrink: 0; padding: 3px 9px; border-radius: var(--radius-full); background: var(--surface-well); color: var(--text-secondary); font-size: 11px; font-variant-numeric: tabular-nums; }
.editor-toolbar { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px; padding-bottom: 12px; }
.draw-tools { --selection-radius: var(--radius-inner); --selection-background: var(--surface-selected); --selection-shadow: none; position: relative; isolation: isolate; display: flex; gap: 3px; padding: 4px; border: 1px solid var(--surface-line); border-radius: var(--radius-control); corner-shape: var(--corner-shape); background: var(--surface-well); }
.relief-editor button { font: inherit; cursor: pointer; transition: var(--control-transition); }
.draw-tools button { --button-press-scale: .98; position: relative; z-index: 1; display: flex; align-items: center; justify-content: center; gap: 6px; min-height: 32px; padding: 6px 11px; border: 0; border-radius: var(--radius-inner); corner-shape: var(--corner-shape); background: transparent; color: var(--text-secondary); font-size: 12px; }
.draw-tools button.active { color: var(--interaction-ink, var(--bg-brand)); }
.draw-tools button > svg { transition: scale var(--motion-release) var(--ease-settle), rotate var(--motion-panel) var(--ease-out); }
.draw-tools button.active > svg { scale: 1.08; }
.draw-tools button:active:enabled > svg { scale: .9; rotate: -5deg; transition-duration: var(--motion-press); }
.draw-tools button:disabled { opacity: .4; cursor: default; }
.draw-tools button:hover:enabled:not(.active) { background: var(--bg-overlay-l1); color: var(--text-default); }
.draw-tools svg, .delete-region svg, .orientation-note svg { fill: none; stroke: currentColor; stroke-width: 1.4; stroke-linecap: round; stroke-linejoin: round; }
.generation-panel { display: grid; grid-template-columns: minmax(230px, .8fr) minmax(0, 1.4fr); gap: 12px 22px; margin-bottom: 14px; padding: 14px 16px; border: 1px solid var(--surface-line); border-radius: var(--radius-popover); corner-shape: var(--corner-shape); background: var(--surface-well); }
.new-region-settings { padding-right: 22px; border-right: 1px solid var(--surface-line); }
.default-depth-control { display: flex; align-items: center; justify-content: space-between; gap: 10px; color: var(--text-secondary); font-size: 11px; }
.default-depth-control > span:first-child { line-height: 1.5; }
.unit-input { position: relative; display: inline-flex; flex: 0 0 86px; width: 86px; }
.unit-input > span { position: absolute; right: 9px; top: 50%; transform: translateY(-50%); color: var(--text-tertiary); font-size: 10px; pointer-events: none; }
.unit-input :deep(.el-input-number) { width: 100%; }
.unit-input :deep(.el-input__wrapper) { padding: 0 28px 0 10px; min-height: 32px; border-radius: var(--radius-inner); corner-shape: var(--corner-shape); background: var(--surface-raised); }
.unit-input :deep(.el-input__inner) { text-align: left; font-family: var(--font-family-metric); font-size: 12px; font-variant-numeric: tabular-nums; }
.new-region-settings > p, .automatic-tools > p { margin: 7px 0 0; color: var(--text-tertiary); font-size: 10px; line-height: 1.65; }
.automatic-tools { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 0 12px; min-width: 0; }
.automatic-tools > p { flex-basis: 100%; }
.automatic-button { display: inline-flex; align-items: center; justify-content: center; gap: 7px; min-height: 34px; padding: 7px 12px; border: 1px solid color-mix(in srgb, var(--interaction-border) 24%, transparent); border-radius: var(--radius-control); corner-shape: var(--corner-shape); background: var(--control-selection-surface); color: var(--interaction-ink); font-size: 11px !important; }
.automatic-button svg { fill: none; stroke: currentColor; stroke-width: 1.3; stroke-linecap: round; stroke-linejoin: round; }
.automatic-button:hover:enabled { border-color: color-mix(in srgb, var(--interaction-border) 55%, transparent); background: color-mix(in srgb, var(--bg-brand) 15%, var(--surface-raised)); }
.automatic-button:disabled { opacity: .4; cursor: default; }
.automatic-button[aria-busy="true"] { opacity: .8; }
.action-label { display: inline-grid; min-width: 0; }
.action-label > span { grid-area: 1 / 1; opacity: 0; visibility: hidden; transition: opacity var(--motion-fast) var(--ease-out), visibility var(--motion-fast); }
.action-label > .is-visible { opacity: 1; visibility: visible; }
.validation-spinner { animation: relief-validation-spin 1s linear infinite; }
@keyframes relief-validation-spin { to { transform: rotate(360deg); } }
.allowance-control { display: flex; align-items: center; gap: 10px; color: var(--text-secondary); font-size: 11px; }
.canvas-feedback { position: absolute; z-index: 2; left: 12px; right: 12px; bottom: 55px; width: fit-content; max-width: calc(100% - 24px); margin-inline: auto; padding: 9px 12px; border: 1px solid var(--surface-line); border-radius: var(--radius-control); corner-shape: var(--corner-shape); background: var(--surface-raised); box-shadow: var(--shadow-control); pointer-events: none; opacity: 0; visibility: hidden; translate: 0 5px; transition: opacity var(--motion-fast) var(--ease-out), translate var(--motion-panel) var(--ease-out), visibility var(--motion-fast); }
.canvas-feedback.is-visible { opacity: 1; visibility: visible; translate: 0; }
.generation-result { display: flex; align-items: flex-start; gap: 7px; color: var(--interaction-ink); font-size: 11px; line-height: 1.6; }
.generation-result + .generation-result { margin-top: 5px; }
.generation-result > svg { flex-shrink: 0; margin-top: 1px; fill: none; stroke: currentColor; stroke-width: 1.4; stroke-linecap: round; stroke-linejoin: round; }
.generation-result.warning { color: var(--status-warning-default); }
.zoom-tools { display: flex; align-items: center; gap: 2px; padding: 4px; border: 1px solid var(--surface-line); border-radius: var(--radius-control); corner-shape: var(--corner-shape); background: var(--surface-well); }
.zoom-tools button { --button-press-scale: .92; width: 30px; height: 30px; padding: 0; border: 0; border-radius: var(--radius-inner); corner-shape: var(--corner-shape); background: transparent; color: var(--text-secondary); font-size: 17px; }
.zoom-tools button:hover:enabled { background: var(--surface-selected); color: var(--interaction-ink); }
.zoom-tools button:disabled { opacity: .35; cursor: default; }
.zoom-tools .editor-history-button { display: grid; place-items: center; padding: 0; }
.editor-history-button svg { fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
.zoom-tools .tool-divider { min-width: 0; width: 1px; height: 16px; margin-inline: 4px; background: var(--surface-line); }
.zoom-tools span { min-width: 44px; text-align: center; color: var(--text-secondary); font-family: var(--font-family-metric); font-size: 11px; font-variant-numeric: tabular-nums; }
.zoom-tools .fit-button { width: auto; margin-left: 4px; padding: 0 9px; font-size: 11px; }
.editor-workspace { display: grid; grid-template-columns: minmax(0, 1fr) 252px; min-height: 260px; height: min(500px, 55dvh); border: 1px solid var(--surface-line); border-radius: var(--radius-popover); corner-shape: var(--corner-shape); overflow: hidden; }
.editor-canvas { position: relative; min-width: 0; min-height: 0; overflow: hidden; background-color: var(--surface-well); background-image: radial-gradient(var(--surface-line) .8px, transparent .8px); background-size: 18px 18px; }
.editor-canvas > svg { position: absolute; inset: 0; width: 100%; height: 100%; touch-action: none; user-select: none; outline: none; cursor: default; }
.editor-canvas > svg:focus-visible { outline: 1px solid var(--interaction-ink, var(--bg-brand)); outline-offset: -2px; }
.editor-canvas.drawing > svg { cursor: crosshair; }
.editor-canvas.panning > svg, .editor-canvas.panning .relief-region { cursor: grabbing; }
.editor-canvas path, .editor-canvas rect, .editor-canvas ellipse, .editor-canvas circle { vector-effect: non-scaling-stroke; }
.board-outline { fill: var(--inspection-board-fill, var(--surface-raised)); fill-rule: evenodd; stroke: var(--inspection-board-stroke, var(--text-tertiary)); stroke-width: 1; stroke-opacity: .7; }
.pad-guide { fill: var(--inspection-original, #638caf); opacity: .38; pointer-events: none; }
.relief-region { fill: var(--bg-brand); fill-opacity: .18; stroke: var(--interaction-ink, var(--bg-brand)); stroke-width: 1.1; cursor: move; transition: fill-opacity 120ms var(--ease-out), stroke-width 120ms var(--ease-out); }
.drawing .relief-region { cursor: crosshair; }
.relief-region:hover, .relief-region.selected { fill-opacity: .28; stroke-width: 1.6; }
.relief-region.draft { fill-opacity: .25; }
.relief-region.through { stroke-dasharray: 5 3; }
.marquee-selection { fill: var(--bg-brand); fill-opacity: .09; stroke: var(--interaction-ink); stroke-width: 1; stroke-dasharray: 4 3; pointer-events: none; }
.selection-handles .region-bounds { fill: none; stroke: var(--interaction-ink, var(--bg-brand)); stroke-width: 1; stroke-dasharray: 4 3; opacity: .8; pointer-events: none; }
.selection-handles .resize-handle { fill: var(--surface-raised); stroke: var(--interaction-ink, var(--bg-brand)); stroke-width: 1.5; pointer-events: all; }
.selection-handles .vertex-handle { fill: var(--surface-raised); stroke: var(--interaction-ink); stroke-width: 1.5; cursor: grab; pointer-events: all; }
.selection-handles .vertex-handle:active { cursor: grabbing; }
.polygon-draft { fill: none; stroke: var(--interaction-ink); stroke-width: 1.5; stroke-linejoin: round; pointer-events: none; }
.polygon-draft > path { stroke-dasharray: 5 3; }
.polygon-draft > circle { fill: var(--surface-raised); }
.polygon-draft > .start-vertex { fill: var(--bg-brand); stroke: var(--surface-raised); stroke-width: 2; }
.resize-handle.nw, .resize-handle.se { cursor: nwse-resize; }
.resize-handle.ne, .resize-handle.sw { cursor: nesw-resize; }
.region-labels { pointer-events: none; fill: var(--interaction-ink, var(--bg-brand)); font-family: var(--font-family-mono); font-weight: 600; text-anchor: middle; dominant-baseline: central; }
.canvas-hint { position: absolute; top: 14px; left: 12px; right: 12px; width: fit-content; margin: auto; padding: 7px 11px; border: 1px solid var(--surface-line); border-radius: var(--radius-inner); background: var(--surface-raised); color: var(--text-tertiary); font-size: 11px; pointer-events: none; }
.polygon-hint { display: flex; flex-direction: column; gap: 3px; text-align: center; }
.polygon-hint > span { font-size: 10px; opacity: .85; }
.canvas-legend { position: absolute; left: 12px; bottom: 12px; display: flex; flex-wrap: wrap; gap: 12px; padding: 7px 10px; border: 1px solid var(--surface-line); border-radius: var(--radius-inner); background: var(--surface-raised); font-size: 10px; color: var(--text-secondary); pointer-events: none; }
.canvas-legend > span { display: flex; align-items: center; gap: 6px; }
.canvas-legend i { width: 7px; height: 7px; border: 1px solid var(--surface-line); border-radius: 2px; }
.canvas-legend .support-dot { background: var(--inspection-board-fill, var(--surface-raised)); }
.canvas-legend .relief-dot { border-color: var(--bg-brand); background: color-mix(in srgb, var(--bg-brand) 35%, var(--surface-raised)); }
.region-properties { display: flex; flex-direction: column; min-width: 0; overflow-y: auto; padding: 16px; border-left: 1px solid var(--surface-line); background: var(--surface-raised); scrollbar-width: thin; }
.region-properties > * { flex-shrink: 0; }
.tray-opening-control { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 14px; padding-bottom: 12px; border-bottom: 1px solid var(--surface-line); color: var(--text-secondary); font-size: 11px; }
.tray-opening-control :deep(.el-switch) { flex-shrink: 0; }
.properties-heading { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.properties-heading strong { font-size: 12px; font-weight: 600; }
.selection-count { display: grid; place-items: center; min-width: 24px; height: 24px; padding-inline: 6px; border-radius: var(--radius-inner); background: var(--control-selection-surface); color: var(--interaction-ink); font-family: var(--font-family-metric); font-size: 11px; font-variant-numeric: tabular-nums; }
.selection-controls { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 9px; padding-top: 10px; }
.selection-controls > span { flex: 1; color: var(--text-tertiary); font-size: 10px; }
.selection-controls > button { min-height: 27px; padding: 3px 5px; border: 0; border-radius: var(--radius-inner); background: transparent; color: var(--interaction-ink); font-size: 10px; }
.selection-controls > button:disabled { color: var(--text-tertiary); opacity: .45; cursor: default; }
.selection-controls > button:hover:enabled { background: var(--surface-well); color: var(--text-default); }
.region-list { display: flex; flex: 0 0 auto; align-content: flex-start; gap: 5px; flex-wrap: wrap; box-sizing: border-box; min-height: 50px; max-height: 89px; overflow-y: auto; padding: 12px 0; border-bottom: 1px solid var(--surface-line); }
.region-list button { --button-press-scale: .92; display: grid; flex: 0 0 28px; place-items: center; box-sizing: border-box; width: 28px; height: 28px; padding: 0; border: 1px solid transparent; border-radius: var(--radius-inner); corner-shape: var(--corner-shape); background: var(--surface-well); color: var(--text-secondary); font-family: var(--font-family-metric); font-size: 11px; font-variant-numeric: tabular-nums; }
.region-list button:hover { border-color: var(--surface-line); color: var(--interaction-ink); }
.region-list button.active { border-color: color-mix(in srgb, var(--bg-brand) 24%, var(--surface-line)); background: var(--control-selection-surface); color: var(--interaction-ink, var(--bg-brand)); }
.selected-properties { animation: relief-properties-arrive 180ms var(--ease-out); }
@keyframes relief-properties-arrive { from { opacity: .35; translate: 0 3px; } to { opacity: 1; translate: 0; } }
.selected-heading { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin: 15px 0 12px; font-size: 12px; }
.selected-heading small { color: var(--text-tertiary); font-size: 10px; }
.region-cut-mode { display: flex; flex-direction: column; gap: 7px; margin-bottom: 13px; }
.region-cut-mode > span { color: var(--text-secondary); font-size: 10px; }
.cut-mode-switch { --selection-radius: 999px; --selection-background: var(--surface-selected); --selection-shadow: none; position: relative; isolation: isolate; display: flex; gap: 3px; padding: 3px; border: 1px solid var(--surface-line); border-radius: 999px; background: var(--surface-well); }
.cut-mode-switch > button { position: relative; z-index: 1; flex: 1; min-width: 0; padding: 6px 5px; border: 0; border-radius: 999px; background: transparent; color: var(--text-secondary); font-size: 11px; white-space: nowrap; }
.cut-mode-switch > button.active { color: var(--interaction-ink, var(--bg-brand)); }
.cut-mode-switch > button:hover:not(.active) { color: var(--text-default); background: var(--bg-overlay-l1); }
.cut-mode-switch > button:focus-visible { outline: 1px solid var(--interaction-ink); outline-offset: 1px; }
.depth-setting { grid-column: 1 / -1; min-height: 61px; }
.through-hint { display: flex; align-items: center; gap: 8px; min-height: 53px; margin: 4px 0; padding: 8px 10px; border-radius: var(--radius-inner); background: var(--surface-well); color: var(--text-secondary); font-size: 10px; line-height: 1.6; animation: relief-properties-arrive 180ms var(--ease-out); }
.through-hint svg { flex-shrink: 0; fill: none; stroke: var(--interaction-ink); stroke-width: 1.4; stroke-linecap: round; stroke-linejoin: round; }
.property-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 11px 8px; }
.property-grid label { display: flex; flex-direction: column; gap: 6px; min-width: 0; color: var(--text-secondary); font-size: 10px; }
.property-grid :deep(.el-input-number) { width: 100%; }
.property-grid :deep(.el-input__wrapper) { min-height: 32px; padding-inline: 10px; border-radius: var(--radius-inner); corner-shape: var(--corner-shape); background: var(--surface-well); }
.property-grid :deep(.el-input__inner) { text-align: left; font-family: var(--font-family-metric); font-size: 12px; font-variant-numeric: tabular-nums; }
.property-grid label:focus-within { color: var(--interaction-ink); }
.property-grid .region-depth-field { position: relative; grid-column: 1 / -1; padding-top: 4px; }
.region-depth-field .depth-unit { position: absolute; top: 4px; right: 1px; color: var(--text-tertiary); font-family: var(--font-family-mono); }
.property-hint, .property-empty, .pad-guide-note { margin: 12px 0; color: var(--text-tertiary); font-size: 10px; line-height: 1.7; }
.property-hint { min-height: 34px; margin-bottom: 6px; }
.property-empty { padding-block: 8px; }
.selection-actions { display: flex; flex-direction: column; flex-shrink: 0; gap: 10px; margin-top: 6px; padding-top: 14px; border-top: 1px solid var(--surface-line); }
.selection-actions > p { margin: -3px 0 0; color: var(--text-tertiary); font-size: 10px; line-height: 1.65; }
.selection-actions .delete-region { margin-top: 3px; }
.delete-region { display: flex; align-items: center; justify-content: center; gap: 6px; padding: 8px 10px; border: 1px solid var(--surface-line); border-radius: var(--radius-inner); background: transparent; color: var(--text-secondary); font-size: 11px !important; }
.delete-region:hover { background: var(--status-error-surface-l1, var(--surface-well)); color: var(--status-error-default, var(--text-default)); }
.delete-region:disabled { opacity: .35; cursor: default; }
.delete-region:disabled:hover { background: transparent; color: var(--text-secondary); }
.orientation-note { display: flex; align-items: flex-start; gap: 7px; margin-top: auto; padding-top: 20px; color: var(--text-secondary); font-size: 10px; line-height: 1.7; }
.orientation-note svg { flex-shrink: 0; color: var(--text-tertiary); }
.pad-guide-note { margin-bottom: 0; }
.limit-notice { padding: 8px; border-radius: var(--radius-inner); background: var(--status-warning-surface-l1); color: var(--status-warning-default); font-size: 10px; line-height: 1.6; }
.editor-bottom { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 6px 16px; padding-top: 12px; color: var(--text-tertiary); font-size: 10px; line-height: 1.7; }
.relief-done { min-width: 90px; padding: 9px 22px; border: 1px solid transparent; border-radius: var(--radius-control); background: var(--bg-brand); color: var(--text-onbrand); font: inherit; font-size: 12px; cursor: pointer; transition: var(--control-transition); }
.relief-done:hover { background: var(--bg-brand-hover); }
.relief-editor button:focus-visible { outline: 2px solid var(--interaction-border); outline-offset: 2px; }
@media (max-width: 720px) {
  .editor-intro { flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }
  .generation-panel { grid-template-columns: 1fr; gap: 12px; padding: 12px; }
  .new-region-settings { padding-right: 0; padding-bottom: 10px; border-right: 0; border-bottom: 1px solid var(--surface-line); }
  .new-region-settings > p { margin-top: 4px; }
  .editor-workspace { grid-template-columns: minmax(0, 1fr) 212px; height: min(460px, 53dvh); }
  .region-properties { padding: 11px; }
  .editor-bottom > span:last-child { display: none; }
}
@media (max-width: 520px) {
  .editor-toolbar { gap: 8px; }
  .draw-tools button { padding: 6px 8px; }
  .draw-tools svg { display: none; }
  .zoom-tools { margin-left: auto; }
  .editor-workspace { grid-template-columns: 1fr; grid-template-rows: minmax(210px, 1fr) auto; height: min(530px, 61dvh); }
  .region-properties { max-height: 230px; padding: 12px; border-left: 0; border-top: 1px solid var(--surface-line); }
  .region-list { padding: 8px 0; min-height: 42px; max-height: 75px; }
  .property-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
  .property-hint, .orientation-note, .pad-guide-note { display: none; }
  .property-empty { margin: 10px 0; padding: 0; }
}
</style>

<style>
.component-relief-dialog.el-dialog { display: flex; flex-direction: column; max-width: calc(100vw - 32px); max-height: calc(100dvh - 32px); padding: 24px; border: 1px solid var(--surface-line); border-radius: var(--radius-dialog); corner-shape: var(--corner-shape); box-shadow: var(--shadow-float); }
.component-relief-dialog .el-dialog__header { flex-shrink: 0; padding: 0 36px 12px 0; }
.component-relief-dialog .el-dialog__title { font-size: 18px; font-weight: 600; letter-spacing: -.02em; }
.component-relief-dialog .el-dialog__body { min-height: 0; overflow-y: auto; padding: 0; }
.component-relief-dialog .el-dialog__footer { flex-shrink: 0; margin-top: 16px; padding: 0; }
@media (max-width: 720px) { .component-relief-dialog.el-dialog { padding: 16px; } }
@media (max-height: 530px) { .component-relief-dialog.el-dialog { padding: 14px; } }
@media (max-height: 530px) and (min-width: 521px) { .component-relief-dialog .editor-workspace { min-height: 180px; height: 230px; } }
</style>
