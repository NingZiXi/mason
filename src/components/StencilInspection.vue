<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, useId, watch } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { useI18n } from 'vue-i18n';
import { useConfigStore } from '../stores/config';
import { useUiStore } from '../stores/ui';
import { buildScadParams, enginePads, scadPartHash } from '../lib/model-params';
import { GenerationTasks } from '../lib/generation-tasks';
import { inspectionBounds, inspectionScaleOrigin, polygonPath, type StencilInspection } from '../lib/stencil-inspection';
import { useStencilInspection } from '../composables/useStencilInspection';
import { APERTURE_SCALE_MIN, APERTURE_SCALE_MAX, APERTURE_SCALE_ORIGINAL, defaultApertureScaleFromShrink, type ApertureOverride } from '../lib/pad-overrides';
import { createInspectionInteraction } from '../lib/inspection-interaction';
import { indexPadSizes, mergeSelection, padSizeFractionDigits, prepareSelectionPads, type PadSizeMetric } from '../lib/inspection-selection';
import { useFirstUseTour } from '../composables/useFirstUseTour';
import { useCompletionFeedback } from '../composables/useCompletionFeedback';
import SlidingIndicator from './SlidingIndicator.vue';
import ActionStatusIcon from './ActionStatusIcon.vue';
import { vAppTooltip } from '../directives/app-tooltip';

const OnboardingTour = defineAsyncComponent(() => import('./OnboardingTour.vue'));

const props = defineProps<{ active: boolean; side: 'top' | 'bottom' }>();
const emit = defineEmits<{ presentable: [] }>();
const { t, locale } = useI18n();
const store = useConfigStore();
const ui = useUiStore();
const inspectionEl = ref<HTMLElement | null>(null);
const tasks = new GenerationTasks(invoke);
const enabled = computed(() => props.active);
const { completed: checkCompleted, complete: completeCheck, reset: resetCheck } = useCompletionFeedback();
const request = computed(() => {
  if (!props.active || !store.pythonDetected) return null;
  // Serialize only the active side, so the other side cannot trigger this request.
  const top = props.side === 'top';
  const pads = enginePads(top ? store.config.stencilPadsTop : store.config.stencilPadsBottom);
  const params = buildScadParams(store.config, top ? pads : [], top ? [] : pads);
  const part = `stencil_${props.side}`;
  return { key: scadPartHash(params, part), part, params };
});
const { data: latest, resolvedKey, loading, error, ready: resultReady, retry } = useStencilInspection(enabled, request,
  (snapshot, signal) => tasks.run<StencilInspection>('inspect_stencil', { params: snapshot.params, part: snapshot.part }, 'preview', signal));
// Raw pad geometry stays editable while its openings recalculate. Only an
// import/board/side change invalidates those source indices and this snapshot.
const data = shallowRef<StencilInspection | null>(null);
const mode = ref<'original' | 'openings' | 'compare'>('original');
const isEditing = computed(() => mode.value === 'original');
const showFiltered = ref(true);
const sourcePads = computed(() => props.side === 'top' ? store.config.stencilPadsTop : store.config.stencilPadsBottom);
const selectedIds = shallowRef<number[]>([]);
const decisionEl = ref<HTMLDivElement | null>(null);
const selectedPads = computed(() => {
  const ids = new Set(selectedIds.value);
  return data.value?.pads.filter(pad => ids.has(pad.sourceIndex)) ?? [];
});
const singlePad = computed(() => selectedPads.value.length === 1 ? selectedPads.value[0] : null);
const selectedFilter = computed(() => resultReady.value && singlePad.value
  ? data.value?.filtered.find(pad => pad.sourceIndex === singlePad.value!.sourceIndex) : null);
const editable = computed(() => props.active && isEditing.value && !!data.value
  && store.pythonDetected && !store.historyBusy);
const showSelectionTools = computed(() => isEditing.value && selectedIds.value.length > 0);
const commonDecision = computed(() => {
  const values = new Set(selectedIds.value.map(index => sourcePads.value[index]?.apertureOverride ?? 'auto'));
  return values.size === 1 ? [...values][0] : null;
});
const scaleValues = computed(() => new Set(selectedIds.value.map(index => sourcePads.value[index]?.apertureScale)));
const commonScale = computed(() => scaleValues.value.size > 1 ? null : scaleValues.value.values().next().value);
const hasLocalScale = computed(() => scaleValues.value.size > (scaleValues.value.has(undefined) ? 1 : 0));
const compactPanelOpen = ref(false);
const sidebarToggle = ref<HTMLButtonElement | null>(null);
const sidebarClose = ref<HTMLButtonElement | null>(null);
const sidebarEl = ref<HTMLElement | null>(null);
const sidebarTitle = ref<HTMLHeadingElement | null>(null);
let sidebarObserver: ResizeObserver | undefined;
const sizePickerOpen = ref(false);
const detailsOpen = ref(false);
const sizeButton = ref<HTMLButtonElement | null>(null);
const sizeRange = ref<HTMLInputElement | null>(null);
const sizeMetricControl = ref<HTMLDivElement | null>(null);
const scaleInput = ref<HTMLInputElement | null>(null);
const sidebarId = 'inspection-sidebar-' + useId();
const sizePanelId = sidebarId + '-size';
const sizeMetric = ref<PadSizeMetric>('shortEdge');
const sizeStepIndex = ref(0);
const sizeIndex = computed(() => indexPadSizes(data.value?.pads ?? [], sizeMetric.value));
const sizeSteps = computed(() => sizeIndex.value.steps);
const currentSizeStep = computed(() => sizePickerOpen.value && editable.value
  ? sizeSteps.value[Math.min(sizeStepIndex.value, sizeSteps.value.length - 1)] : undefined);
const sizeFormat = computed(() => new Intl.NumberFormat(locale.value,
  { maximumFractionDigits: padSizeFractionDigits[sizeMetric.value] }));
const sizeUnit = computed(() => sizeMetric.value === 'shortEdge' ? 'mm' : 'mm²');
const formatSize = (limit: number) => `${sizeFormat.value.format(limit)} ${sizeUnit.value}`;
function changeSizeMetric(metric: PadSizeMetric) {
  sizeMetric.value = metric;
  sizeStepIndex.value = 0;
}
const scaleDraft = ref<number | null>(null);
const defaultScale = computed(() => defaultApertureScaleFromShrink(store.config.padShrink));
const displayedScale = computed(() => scaleDraft.value ?? (commonScale.value === undefined ? defaultScale.value : commonScale.value));
// Keep the exact inherited scale for the guide; the editable thumb uses whole percentages.
const scaleSliderValue = computed(() => Math.min(APERTURE_SCALE_MAX,
  Math.max(APERTURE_SCALE_MIN, Math.round(displayedScale.value ?? APERTURE_SCALE_ORIGINAL))));
const scaleFormat = computed(() => new Intl.NumberFormat(locale.value, { style: 'percent', maximumFractionDigits: 2 }));
const formatScale = (value: number) => scaleFormat.value.format(value / APERTURE_SCALE_ORIGINAL);
const scaleStatusKeys = {
  inherited: 'inspection.scaleInherited', individual: 'inspection.scaleIndividual',
  draft: 'inspection.scaleDraft', mixed: 'inspection.mixedScales',
} as const;
const scaleStatus = computed<keyof typeof scaleStatusKeys>(() => {
  if (scaleDraft.value !== null && scaleDraft.value !== commonScale.value) return 'draft';
  if (commonScale.value === undefined) return 'inherited';
  return commonScale.value === null ? 'mixed' : 'individual';
});
const scaleValueText = computed(() => {
  const value = displayedScale.value;
  const key = scaleStatusKeys[scaleStatus.value];
  return value === null ? t(key) : t(key, { value: formatScale(value) });
});
const scalePosition = (value: number) => 100 * (value - APERTURE_SCALE_MIN) / (APERTURE_SCALE_MAX - APERTURE_SCALE_MIN);
const scaleTrackStyle = computed(() => {
  const baseline = scalePosition(APERTURE_SCALE_ORIGINAL);
  const current = scalePosition(scaleSliderValue.value);
  return { '--scale-baseline': `${baseline}%`, '--scale-fill-start': `${Math.min(baseline, current)}%`,
    '--scale-fill-end': `${Math.max(baseline, current)}%` };
});
const canApplyScale = computed(() => {
  const scale = scaleDraft.value;
  return editable.value && !!selectedIds.value.length && scale !== null && Number.isInteger(scale)
    && scale >= APERTURE_SCALE_MIN && scale <= APERTURE_SCALE_MAX && scale !== commonScale.value;
});
const metricFormat = computed(() => new Intl.NumberFormat(locale.value, { maximumFractionDigits: 3 }));

function syncSidebarFocus(previous?: Element) {
  const toggle = sidebarToggle.value;
  if (!props.active || !toggle) return;
  const { activeElement, body } = toggle.ownerDocument;
  if (previous && activeElement !== previous && activeElement !== body) return;
  const focused = previous ?? activeElement;
  // The toolbar button measures zero when the container query docks the tools.
  if (focused && toggle.offsetWidth) {
    if (!compactPanelOpen.value && sidebarEl.value?.contains(focused)) toggle.focus({ preventScroll: true });
  } else if (focused && (focused === toggle || focused === sidebarClose.value)) {
    sidebarTitle.value?.focus({ preventScroll: true });
  }
}
function sidebarFocusOut(event: FocusEvent) {
  // When a button becomes display:none, the browser can blur it before the resize observer runs.
  const target = event.target;
  if (!event.relatedTarget && target instanceof Element) queueMicrotask(() => syncSidebarFocus(target));
}
function closeSidebar() {
  compactPanelOpen.value = false;
  sizePickerOpen.value = false;
  scaleDraft.value = null;
  sidebarToggle.value?.focus({ preventScroll: true });
}
async function toggleSidebar() {
  if (compactPanelOpen.value) { closeSidebar(); return; }
  compactPanelOpen.value = true;
  await nextTick();
  sidebarClose.value?.focus({ preventScroll: true });
}
async function toggleSizePicker() {
  if (sizePickerOpen.value) { sizePickerOpen.value = false; return; }
  sizeStepIndex.value = 0;
  sizePickerOpen.value = true;
  await nextTick();
  if (sizePickerOpen.value) (sizeRange.value ?? sizeMetricControl.value?.querySelector<HTMLInputElement>('input:checked'))?.focus();
}
function sidebarKey(event: KeyboardEvent) {
  if (event.key !== 'Escape') return;
  if (sizePickerOpen.value) {
    sizePickerOpen.value = false;
    sizeButton.value?.focus();
  } else if (scaleDraft.value !== null) {
    scaleDraft.value = null;
    scaleInput.value?.focus();
  } else if (compactPanelOpen.value && sidebarToggle.value?.offsetWidth) {
    closeSidebar();
  } else return;
  event.preventDefault();
  event.stopPropagation();
}
function selectBySize() {
  if (!currentSizeStep.value) return;
  selectedIds.value = mergeSelection([], sizeIndex.value.padIds.slice(0, currentSizeStep.value.count), 'replace');
  sizePickerOpen.value = false;
  void focusDecision(sizeButton.value);
}
function setScale(reset: boolean) {
  const scale = reset ? undefined : scaleDraft.value;
  if (!editable.value || !selectedIds.value.length || scale === null || (reset ? !hasLocalScale.value : !canApplyScale.value)) return;
  store.setApertureScales(props.side, selectedIds.value, scale);
  scaleDraft.value = null;
  scaleInput.value?.focus({ preventScroll: true });
}
function clearSelection() {
  selectedIds.value = [];
  svgEl.value?.focus({ preventScroll: true });
}

const selectedPath = computed(() => selectedPads.value.map(pad => polygonPath(pad.polygons)).join(' '));
const selectionPads = computed(() => prepareSelectionPads(data.value?.pads ?? []));
const paths = computed(() => data.value ? {
  outline: polygonPath(data.value.outline), original: polygonPath(data.value.original),
  openings: polygonPath(data.value.openings),
  overlaps: data.value.overlaps.map(overlap => polygonPath(overlap.polygons)), filtered: data.value.filtered.map(pad => polygonPath(pad.polygons)),
  pads: data.value.pads.map(pad => ({ ...pad, path: polygonPath(pad.polygons) })),
} : null);
// Memoize the geometry for the current selection. Dragging updates one CSS value,
// leaving both the pad paths and the generated opening result alone until Apply.
const scalePreviewPads = computed(() => {
  if (!showSelectionTools.value || !editable.value) return [];
  const selected = new Set(selectedIds.value);
  const filtered = new Set(data.value?.filtered.map(pad => pad.sourceIndex));
  return (paths.value?.pads ?? []).flatMap(pad => {
    if (!selected.has(pad.sourceIndex)) return [];
    const decision = sourcePads.value[pad.sourceIndex]?.apertureOverride;
    if (decision === 'closed' || (decision !== 'open' && (!resultReady.value || filtered.has(pad.sourceIndex)))) return [];
    const origin = inspectionScaleOrigin(pad.polygons);
    return origin ? [{ sourceIndex: pad.sourceIndex, path: pad.path, origin }] : [];
  });
});
const showScalePreview = computed(() => !sizePickerOpen.value && scaleDraft.value !== null && scalePreviewPads.value.length > 0);
const sizePreviewPaths = computed(() => new Map(paths.value?.pads.map(pad => [pad.sourceIndex, pad.path])));
const sizePreviewPath = computed(() => {
  if (!currentSizeStep.value) return '';
  const ids = sizeIndex.value.padIds.slice(0, currentSizeStep.value.count);
  return ids.map(id => sizePreviewPaths.value.get(id)).join(' ');
});
// Decision metadata is cheap and immediate; keep it out of the memoized raw
// geometry so continuous edits never rebuild the dense pad/hit-target paths.
const manualPads = computed(() => (paths.value?.pads ?? []).flatMap(pad => {
  const decision = sourcePads.value[pad.sourceIndex]?.apertureOverride;
  return decision ? [{ ...pad, decision }] : [];
}));
const scaledPath = computed(() => isEditing.value ? (paths.value?.pads ?? [])
  .filter(pad => sourcePads.value[pad.sourceIndex]?.apertureScale !== undefined).map(pad => pad.path).join(' ') : '');
const overlapCount = computed(() => resultReady.value ? data.value?.overlaps.length ?? 0 : 0);
const legendItems = computed(() => {
  const items: { tone: string; label: string }[] = [];
  if (mode.value === 'compare') items.push({ tone: 'original', label: 'original' }, { tone: 'opening', label: 'openings' });
  if (mode.value !== 'openings') {
    if (manualPads.value.some(pad => pad.decision === 'closed')) items.push({ tone: 'closed', label: 'manualClosed' });
    if (manualPads.value.some(pad => pad.decision === 'open')) items.push({ tone: 'manual-open', label: 'manualOpen' });
  }
  if (scaledPath.value) items.push({ tone: 'local-scale', label: 'localScale' });
  if (mode.value !== 'original' && overlapCount.value) items.push({ tone: 'overlap', label: 'overlapLegend' });
  return items;
});
function reviewOverlaps() {
  mode.value = 'compare';
  svgEl.value?.focus({ preventScroll: true });
}
function decide(value: 'auto' | ApertureOverride) {
  if (!selectedIds.value.length || !editable.value) return;
  store.setApertureOverrides(props.side, selectedIds.value, value === 'auto' ? undefined : value);
}
async function focusDecision(fallback?: HTMLElement | null) {
  // On wide layouts the tools are already visible; don't open a future narrow overlay.
  if (selectedIds.value.length && sidebarToggle.value?.offsetWidth) compactPanelOpen.value = true;
  await nextTick();
  // Focus may scroll the tools, which have their own scroll area beside the drawing.
  (decisionEl.value?.querySelector<HTMLButtonElement>('button:not(:disabled)') ?? fallback)?.focus();
}
function selectWithKeyboard(index: number, event: KeyboardEvent) {
  if (!editable.value) return;
  selectedIds.value = mergeSelection(selectedIds.value, [index], event.ctrlKey || event.metaKey ? 'toggle' : event.shiftKey ? 'add' : 'replace');
  void focusDecision();
}
const svgEl = ref<SVGSVGElement | null>(null);
const marqueeEl = ref<SVGRectElement | null>(null);
const gestureKind = ref<'pan' | 'select' | null>(null);
const zoom = ref(1);
const interaction = createInspectionInteraction({
  svg: () => svgEl.value, marquee: () => marqueeEl.value,
  canSelect: () => editable.value,
  pads: () => selectionPads.value, selection: () => selectedIds.value,
  select: indices => { selectedIds.value = indices; },
  gesture: kind => { gestureKind.value = kind; }, zoom: value => { zoom.value = value; },
});
let geometryKey = '';
let displayedRequestKey = '';
// Identical SR boards and reimported files can replace all geometry references
// without changing the engine key. Reaccept that cached result after the sync
// context reset below, while rejecting results for a different request.
watch([latest, resolvedKey, () => props.side,
  () => props.side === 'top' ? store.config.stencilPadsTop : store.config.stencilPadsBottom,
  () => store.config.pcbOutlinePoints, () => store.config.pcbOutlineHoles], ([value]) => {
  if (!value || resolvedKey.value !== request.value?.key) return;
  const key = `${value.side}:${JSON.stringify(value.outline)}`;
  const updated = !!data.value && key === geometryKey && displayedRequestKey !== request.value?.key;
  data.value = value;
  const validIds = new Set(value.pads.map(pad => pad.sourceIndex));
  const validSelection = selectedIds.value.filter(id => validIds.has(id));
  if (validSelection.length !== selectedIds.value.length) selectedIds.value = validSelection;
  if (key !== geometryKey) { geometryKey = key; fit(); }
  displayedRequestKey = request.value?.key ?? '';
  if (updated && props.active && !error.value) completeCheck();
});
watch([() => props.side, () => props.side === 'top' ? store.config.stencilPadsTop : store.config.stencilPadsBottom,
  () => store.config.pcbOutlinePoints, () => store.config.pcbOutlineHoles], () => {
  sizePickerOpen.value = false; detailsOpen.value = false; changeSizeMetric('shortEdge'); scaleDraft.value = null;
  interaction.finish(); data.value = null; selectedIds.value = []; geometryKey = ''; displayedRequestKey = ''; resetCheck();
}, { flush: 'sync' });
function fit() {
  if (data.value) interaction.fit(inspectionBounds(data.value));
}
function canvasKey(event: KeyboardEvent) {
  if (!editable.value) return;
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
    event.preventDefault(); selectedIds.value = data.value?.pads.map(pad => pad.sourceIndex) ?? [];
    void focusDecision();
  } else if (event.key === 'Escape') {
    interaction.finish(); selectedIds.value = [];
  }
}
watch(selectedIds, (ids, previous) => {
  if (ids.length === previous.length && ids.every((id, index) => id === previous[index])) return;
  sizePickerOpen.value = false;
  scaleDraft.value = null;
}, { flush: 'sync' });
watch(mode, () => { sizePickerOpen.value = false; scaleDraft.value = null; interaction.finish(); }, { flush: 'sync' });
watch(editable, canEdit => {
  if (!canEdit) { sizePickerOpen.value = false; scaleDraft.value = null; }
});
watch([enabled, () => request.value?.key, error], resetCheck);
watch(enabled, active => {
  if (!active) { compactPanelOpen.value = false; detailsOpen.value = false; }
  interaction.finish(); interaction.refresh();
});
watch(svgEl, () => interaction.refresh());
// Signal after the SVG (or an actionable error state) has reached the DOM.
watch(() => props.active && ((resultReady.value && !!svgEl.value) || !!error.value || !store.pythonDetected),
  ready => { if (ready) emit('presentable'); }, { flush: 'post', immediate: true });
const tourReady = computed(() => props.active && !!latest.value && !!svgEl.value
  && store.pythonDetected && !loading.value && !error.value);
const { open: tourOpen, start: replayTour, close: finishTour } = useFirstUseTour({
  ready: () => tourReady.value,
  seen: () => ui.inspectionOnboardingSeen,
  prepare: () => { interaction.finish(); mode.value = 'original'; },
  dismiss: () => ui.dismissInspectionOnboarding(),
});
onMounted(() => {
  if (!sidebarToggle.value || typeof ResizeObserver === 'undefined') return;
  sidebarObserver = new ResizeObserver(() => syncSidebarFocus());
  sidebarObserver.observe(sidebarToggle.value);
});
onBeforeUnmount(() => {
  sidebarObserver?.disconnect();
  interaction.dispose(); tasks.cancel(['preview']);
});
</script>

<template>
  <div ref="inspectionEl" class="inspection">
    <div class="inspection-toolbar">
      <div class="inspection-segments" role="group" :aria-label="t('inspection.displayMode')">
        <SlidingIndicator />
        <button v-for="item in (['original', 'openings', 'compare'] as const)" :key="item" :class="{ active: mode === item }"
          :aria-label="t(`inspection.${item}`)" :aria-pressed="mode === item" @click="mode = item">
          <span class="inspection-mode-label">{{ t(`inspection.${item}`) }}</span>
          <span aria-hidden="true" class="inspection-mode-short">{{ t(`inspection.${item === 'compare' ? item : `${item}Short`}`) }}</span>
        </button>
      </div>
      <div class="inspection-view-tools">
        <div class="zoom-tools">
          <button class="inspection-tool-button icon-tool" :aria-label="t('inspection.zoomOut')" v-app-tooltip="t('inspection.zoomOut')" @click="interaction.zoomBy(1 / 1.35)">
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M4 8h8" /></svg>
          </button>
          <span>{{ Math.round(zoom * 100) }}%</span>
          <button class="inspection-tool-button icon-tool" :aria-label="t('inspection.zoomIn')" v-app-tooltip="t('inspection.zoomIn')" @click="interaction.zoomBy(1.35)">
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M4 8h8M8 4v8" /></svg>
          </button>
        </div>
        <button class="inspection-tool-button icon-tool" :aria-label="t('inspection.fit')" v-app-tooltip="t('inspection.fit')" @click="fit">
          <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M2.75 6V2.75H6m4 0h3.25V6m0 4v3.25H10m-4 0H2.75V10" />
            <rect x="6.1" y="6.1" width="3.8" height="3.8" rx=".75" />
          </svg>
        </button>
        <button class="inspection-tool-button icon-tool tour-button" :disabled="!tourReady" v-app-tooltip="t('inspection.tour.replay')"
          :aria-label="t('inspection.tour.replay')" aria-haspopup="dialog" :aria-expanded="tourOpen" @click="replayTour">
          <svg viewBox="0 0 20 20" width="16" height="16" fill="none" aria-hidden="true">
            <circle cx="10" cy="10" r="7.25" stroke="currentColor" stroke-width="1.3" />
            <path d="M7.9 7.6a2.1 2.1 0 1 1 3.5 1.55C10.45 9.8 10 10.05 10 11.1" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
            <circle cx="10" cy="13.5" r=".8" fill="currentColor" />
          </svg>
        </button>
        <button ref="sidebarToggle" class="inspection-tool-button icon-tool inspection-sidebar-toggle" :class="{ 'has-selection': showSelectionTools }"
          :aria-label="t('inspection.panelTitle')" :aria-expanded="compactPanelOpen" :aria-controls="sidebarId"
          :aria-description="showSelectionTools ? t('inspection.selectedShort', { n: selectedIds.length }) : undefined"
          v-app-tooltip="t('inspection.panelTitle')" @click="toggleSidebar" @blur="sidebarFocusOut">
          <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" aria-hidden="true">
            <rect x="2" y="3" width="12" height="10" rx="2" /><path d="M9.5 3v10m2-7h.6m-.6 3h.6" />
          </svg>
        </button>
      </div>
    </div>
    <div class="inspection-workspace">
      <!-- Keep sidebar controls ahead of the pad hit targets in the tab order. -->
      <aside :id="sidebarId" ref="sidebarEl" class="inspection-sidebar" :class="{ 'is-open': compactPanelOpen }"
        :aria-labelledby="`${sidebarId}-title`" @keydown="sidebarKey" @focusout="sidebarFocusOut">
        <div class="inspection-sidebar-heading">
          <h3 :id="`${sidebarId}-title`" ref="sidebarTitle" tabindex="-1">{{ t('inspection.panelTitle') }}</h3>
          <button ref="sidebarClose" class="inspection-tool-button icon-tool inspection-sidebar-close"
            :aria-label="t('inspection.closePanel')" v-app-tooltip="t('inspection.closePanel')" @click="closeSidebar">
            <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true">
              <path d="m4.5 4.5 7 7m0-7-7 7" />
            </svg>
          </button>
        </div>
        <div v-if="data" class="inspection-sidebar-body">
          <div class="inspection-sidebar-summary">
            <dl class="inspection-counts" aria-live="polite">
              <div><dt>{{ t('inspection.sourceCount') }}</dt><dd>{{ data.summary.sourcePads }}</dd></div>
              <div><dt>{{ t('inspection.openingCount') }}</dt><dd>{{ resultReady ? data.summary.openings : '—' }}</dd></div>
            </dl>
            <button v-if="mode !== 'openings'" class="inspection-tool-button filtered-toggle"
              :aria-label="t('inspection.filteredMarkers')" :aria-pressed="showFiltered"
              v-app-tooltip="t('inspection.filteredMarkers')" @click="showFiltered = !showFiltered">
              <i class="legend-dot filtered" aria-hidden="true" />
              <span class="filtered-label">{{ t('inspection.filteredShort') }}</span>
              <strong>{{ resultReady ? data.summary.filteredPads : '—' }}</strong>
            </button>
          </div>
          <div v-if="isEditing" class="inspection-size-tools">
            <button ref="sizeButton" class="inspection-tool-button inspection-size-trigger" :disabled="!editable"
              :aria-expanded="sizePickerOpen" :aria-controls="sizePickerOpen ? sizePanelId : undefined" @click="toggleSizePicker">
              <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M2 4.25h12m-10 3.5h8m-6 3.5h4" stroke-width="1.4" />
              </svg>
              <span>{{ t('inspection.selectBySize') }}</span>
              <svg class="inspection-disclosure" viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="m4.5 6.25 3.5 3.5 3.5-3.5" />
              </svg>
            </button>
            <form v-if="sizePickerOpen" :id="sizePanelId" class="inspection-edit-panel inspection-size-panel" :aria-label="t('inspection.selectBySize')" @submit.prevent="selectBySize">
              <div ref="sizeMetricControl" class="inspection-size-metric" role="radiogroup"
                :aria-label="t('inspection.sizeMetric')" :data-metric="sizeMetric">
                <label v-for="metric in (['shortEdge', 'area'] as const)" :key="metric">
                  <input type="radio" :name="`${sizePanelId}-metric`" :value="metric" :checked="sizeMetric === metric"
                    @change="changeSizeMetric(metric)" />
                  <span>{{ t(metric === 'shortEdge' ? 'inspection.sizeShortEdge' : 'inspection.sizeArea') }}</span>
                </label>
              </div>
              <p v-if="sizeSteps.length > 1" :id="`${sizePanelId}-size-hint`">{{ t('inspection.sizeHint') }}</p>
              <div v-if="currentSizeStep" class="inspection-size-picker">
                <div class="inspection-size-current">
                  <span :id="`${sizePanelId}-size-label`">{{ t('inspection.sizeLimit') }}</span>
                  <strong>≤ {{ formatSize(currentSizeStep.limit) }}</strong>
                </div>
                <template v-if="sizeSteps.length > 1">
                  <input ref="sizeRange" class="inspection-size-range" type="range" min="0" :max="sizeSteps.length - 1" step="1"
                    :value="Math.min(sizeStepIndex, sizeSteps.length - 1)" :aria-labelledby="`${sizePanelId}-size-label`"
                    :aria-describedby="`${sizePanelId}-size-hint`"
                    :aria-valuetext="`≤ ${formatSize(currentSizeStep.limit)} · ${t('inspection.selectSizeMatches', { n: currentSizeStep.count }, currentSizeStep.count)}`"
                    @input="sizeStepIndex = Number(($event.target as HTMLInputElement).value)" @keydown.enter.prevent="selectBySize" />
                  <div class="inspection-size-endpoints" aria-hidden="true">
                    <span>{{ formatSize(sizeSteps[0].limit) }}</span>
                    <span>{{ formatSize(sizeSteps[sizeSteps.length - 1].limit) }}</span>
                  </div>
                </template>
              </div>
              <div class="inspection-edit-actions">
                <span v-if="!currentSizeStep" class="size-empty" role="status">{{ t('inspection.noSizeMatches') }}</span>
                <button type="submit" class="inspection-edit-button primary" :disabled="!currentSizeStep">
                  {{ currentSizeStep ? t('inspection.selectSizeMatches', { n: currentSizeStep.count }, currentSizeStep.count) : t('inspection.selectBySize') }}
                </button>
              </div>
            </form>
          </div>
          <div v-if="showSelectionTools && !sizePickerOpen" class="inspection-selected-tools">
            <div class="inspection-selection">
              <span class="inspection-selection-count" role="status">{{ t('inspection.selectedShort', { n: selectedIds.length }) }}</span>
              <button class="inspection-tool-button icon-tool clear-selection" :aria-label="t('inspection.clearSelection')"
                v-app-tooltip="t('inspection.clearSelection')" @click="clearSelection">
                <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="m5 5 6 6m0-6-6 6" /></svg>
              </button>
            </div>
            <div ref="decisionEl" class="decision-controls" role="group" :aria-label="t('inspection.decision')">
              <SlidingIndicator />
              <button v-for="choice in (['open', 'closed', 'auto'] as const)" :key="choice" :class="[choice, { active: commonDecision === choice }]"
                :disabled="!editable" :aria-pressed="commonDecision === choice"
                @click="decide(choice)">{{ t(choice === 'auto' ? 'inspection.restoreAuto' : `inspection.decision_${choice}`) }}</button>
            </div>
            <div v-if="singlePad" class="inspection-pad-details">
              <span :title="t('inspection.originalMetrics')">#{{ singlePad.sourceIndex + 1 }} · {{ metricFormat.format(singlePad.shortEdge) }} mm · {{ metricFormat.format(singlePad.area) }} mm²</span>
              <p v-if="selectedFilter && commonDecision === 'auto'" :title="t('inspection.filterReason')">{{ t(`inspection.reason_${selectedFilter.reason}`) }}</p>
            </div>
            <form class="inspection-edit-panel inspection-scale-panel" :aria-label="t('inspection.scaleApertures')" @submit.prevent="setScale(false)">
              <div class="inspection-scale-heading">
                <strong>{{ t('inspection.scaleApertures') }}</strong>
                <span class="inspection-scale-value" :class="{ 'is-neutral': scaleStatus === 'mixed' || scaleStatus === 'inherited' }" aria-hidden="true">
                  {{ scaleValueText }}
                </span>
              </div>
              <p :id="`${sidebarId}-scale-hint`">{{ t(scalePreviewPads.length || !resultReady ? 'inspection.scaleHint' : 'inspection.scaleNoPreview') }}</p>
              <div class="inspection-scale-picker" :class="{ 'is-mixed': displayedScale === null }" :style="scaleTrackStyle">
                <div class="inspection-scale-track" aria-hidden="true" />
                <input ref="scaleInput" class="inspection-scale-range" type="range" :min="APERTURE_SCALE_MIN" :max="APERTURE_SCALE_MAX"
                  step="1" :value="scaleSliderValue" :disabled="!editable" :aria-label="t('inspection.scalePercent')" :aria-describedby="`${sidebarId}-scale-hint`"
                  :aria-valuetext="scaleValueText"
                  @input="scaleDraft = ($event.target as HTMLInputElement).valueAsNumber" @keydown.enter.prevent="setScale(false)" />
                <div class="inspection-scale-marks">
                  <span aria-hidden="true">{{ formatScale(APERTURE_SCALE_MIN) }}</span>
                  <button type="button" class="inspection-scale-baseline" :disabled="!editable"
                    @click="scaleDraft = APERTURE_SCALE_ORIGINAL">{{ t('inspection.scaleOriginal', { value: formatScale(APERTURE_SCALE_ORIGINAL) }) }}</button>
                  <span aria-hidden="true">{{ formatScale(APERTURE_SCALE_MAX) }}</span>
                </div>
              </div>
              <div class="inspection-edit-actions">
                <button type="button" class="inspection-edit-button" :disabled="!editable || !hasLocalScale" @click="setScale(true)">{{ t('inspection.restoreDefaultScale') }}</button>
                <button type="submit" class="inspection-edit-button primary" :disabled="!canApplyScale">{{ t('inspection.applyScale') }}</button>
              </div>
            </form>
          </div>
          <div v-if="!showSelectionTools && !sizePickerOpen" class="inspection-selection-prompt">
            <svg v-if="isEditing" viewBox="0 0 20 20" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M8 4H5.5A1.5 1.5 0 0 0 4 5.5V8m8-4h2.5A1.5 1.5 0 0 1 16 5.5V8M4 12v2.5A1.5 1.5 0 0 0 5.5 16H8m4 0h2.5a1.5 1.5 0 0 0 1.5-1.5V12" />
              <rect x="8" y="8" width="4" height="4" rx=".8" />
            </svg>
            <p>{{ t(isEditing ? 'inspection.selectionPrompt' : 'inspection.readonlyHint') }}</p>
          </div>
          <div class="inspection-details-tools">
            <button class="inspection-tool-button details-button" :class="{ 'has-warning': data.summary.invalidPads }"
              :aria-expanded="detailsOpen" :aria-controls="detailsOpen ? `${sidebarId}-details` : undefined" @click="detailsOpen = !detailsOpen">
              <span>{{ t('inspection.details') }}</span>
              <svg class="inspection-disclosure" viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="m4.5 6.25 3.5 3.5 3.5-3.5" />
              </svg>
            </button>
            <section v-if="detailsOpen" :id="`${sidebarId}-details`" class="inspection-edit-panel inspection-details-panel" :aria-label="t('inspection.details')">
              <dl class="inspection-detail-counts">
                <div><dt>{{ t('inspection.filtered') }}</dt><dd>{{ resultReady ? data.summary.filteredPads : '—' }}</dd></div>
                <div v-if="manualPads.length"><dt>{{ t('inspection.manualCount') }}</dt><dd>{{ manualPads.length }}</dd></div>
              </dl>
              <p v-if="data.summary.invalidPads" class="inspection-invalid">{{ t('inspection.invalid', { n: data.summary.invalidPads }) }}</p>
              <p>{{ t(isEditing ? 'inspection.gestures' : 'inspection.viewGestures') }}</p>
              <p>{{ t(data.mirrored ? 'inspection.topOrientation' : 'inspection.bottomOrientation') }} · {{ t('inspection.countHint') }}</p>
              <div v-if="isEditing && manualPads.length" class="inspection-edit-actions">
                <button class="inspection-edit-button" :disabled="!editable" @click="store.resetApertureOverrides(side)">{{ t('inspection.resetSide') }}</button>
              </div>
            </section>
          </div>
        </div>
      </aside>
      <div class="inspection-canvas" :class="{ panning: gestureKind === 'pan', selecting: gestureKind === 'select', editing: isEditing }">
        <svg v-if="data && paths" ref="svgEl" viewBox="-10 -10 20 20" :class="{ 'is-stale': !resultReady }" :aria-label="t('inspection.title')" tabindex="0"
          @wheel.prevent="interaction.wheel" @pointerdown="interaction.down" @pointermove="interaction.move" @pointerup="interaction.finish"
          @pointercancel="interaction.finish" @lostpointercapture="interaction.finish" @contextmenu.prevent @keydown="canvasKey">
          <g v-memo="[paths, mode, showFiltered, locale]">
            <path :d="paths.outline" class="pcb-outline" />
            <g class="inspection-layer" :class="{ 'is-visible': mode !== 'openings' }" aria-hidden="true">
              <path :d="paths.original" class="original-mask" :class="{ overlay: mode === 'compare' }" />
            </g>
            <g class="inspection-layer derived" :class="{ 'is-visible': mode !== 'original' }" aria-hidden="true">
              <path :d="paths.openings" class="opening-mask" />
            </g>
            <g class="inspection-layer derived" :class="{ 'is-visible': showFiltered && mode !== 'openings' }" aria-hidden="true">
              <path v-for="(path, index) in paths.filtered" :key="index" :d="path" class="filtered-mask" />
            </g>
            <!-- Hide hit targets immediately; only the visible geometry fades. -->
            <g v-show="isEditing" class="pad-hit-layer" :aria-hidden="!isEditing">
              <path v-for="pad in paths.pads" :key="pad.sourceIndex" :d="pad.path" class="pad-hit"
                :data-pad-index="pad.sourceIndex" role="button" tabindex="0"
                :aria-label="t('inspection.selectPad', { n: pad.sourceIndex + 1 })"
                @keydown.enter.prevent="selectWithKeyboard(pad.sourceIndex, $event)" @keydown.space.prevent="selectWithKeyboard(pad.sourceIndex, $event)">
                <title>{{ t('inspection.selectPad', { n: pad.sourceIndex + 1 }) }}</title>
              </path>
            </g>
          </g>
          <g class="inspection-layer" :class="{ 'is-visible': mode !== 'openings' }" aria-hidden="true">
            <path v-for="pad in manualPads" :key="`manual-${pad.sourceIndex}`" :d="pad.path" class="manual-mask" :class="pad.decision" />
          </g>
          <path v-if="scaledPath" :d="scaledPath" class="scaled-mask" aria-hidden="true" />
          <g v-if="mode !== 'original' && overlapCount" v-memo="[paths]" aria-hidden="true">
            <path v-for="(path, index) in paths.overlaps" :key="index" :d="path" class="overlap-mask" />
          </g>
          <path v-if="isEditing && sizePreviewPath" :d="sizePreviewPath" class="size-preview-pad" aria-hidden="true" />
          <path v-else-if="isEditing && selectedPath" :d="selectedPath" class="selected-pad" :class="{ 'is-scale-reference': showScalePreview }" />
          <g v-if="showScalePreview" class="scale-draft-preview" aria-hidden="true"
            :style="{ '--aperture-draft-factor': (displayedScale ?? APERTURE_SCALE_ORIGINAL) / APERTURE_SCALE_ORIGINAL }">
            <g v-memo="[scalePreviewPads]">
              <path v-for="pad in scalePreviewPads" :key="pad.sourceIndex" :d="pad.path" class="scale-preview-pad"
                :style="{ transformOrigin: `${pad.origin.x}px ${pad.origin.y}px` }" />
            </g>
          </g>
          <rect ref="marqueeEl" class="selection-box" style="display: none" />
        </svg>
        <div v-if="overlapCount" class="inspection-overlap-alert">
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-linecap="round" aria-hidden="true">
            <circle cx="8" cy="8" r="6" stroke-width="1.3"/><path d="M8 5v3.5m0 2v.2" stroke-width="1.4"/>
          </svg>
          <span role="status">{{ t('inspection.overlapCount', { n: overlapCount }) }}</span>
          <button v-if="mode === 'original'" @click="reviewOverlaps">{{ t('inspection.reviewOverlaps') }}</button>
        </div>
        <Transition name="inspection-status">
          <div v-if="loading || error || !store.pythonDetected || (checkCompleted && resultReady && !overlapCount)" class="inspection-state"
            :key="error ? 'error' : !store.pythonDetected ? 'unavailable' : 'progress'"
            :class="{ compact: data && store.pythonDetected, 'has-error': !!error, 'is-complete': checkCompleted && resultReady }" role="status">
            <template v-if="error"><strong>{{ t('inspection.failed') }}</strong><span v-if="!data" class="error-detail">{{ error }}</span><button @click="retry">{{ t('inspection.retry') }}</button></template>
            <template v-else-if="!store.pythonDetected">{{ t(store.engineLoading ? 'preview.checkingEngine' : store.pythonError ? 'python.unavailable' : 'preview.noPythonPreview') }}</template>
            <template v-else>
              <ActionStatusIcon :state="loading ? 'busy' : 'success'" :size="data ? 14 : 22" />
              <span>{{ t(loading ? 'inspection.loading' : 'preview.refreshed') }}</span>
            </template>
          </div>
        </Transition>
        <div v-if="data && legendItems.length" class="inspection-legend" aria-hidden="true">
          <span v-for="item in legendItems" :key="item.tone"><i class="legend-dot" :class="item.tone" />{{ t(`inspection.${item.label}`) }}</span>
        </div>
      </div>
    </div>
    <OnboardingTour v-if="tourOpen && inspectionEl" mode="stencil" context="inspection" :root="inspectionEl" @close="finishTour" />
  </div>
</template>

<style scoped>
.inspection {
  --inspection-gutter: 16px;
  --inspection-tool-size: 28px;
  --inspection-row-height: 42px;
  --inspection-sidebar-width: 272px;
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  container: stencil-inspection / inline-size;
  background: var(--surface-raised);
}
/* The sidebar handle overlaps the left edge of this row. */
.inspection-toolbar {
  position: relative;
  z-index: 2;
  display: flex;
  flex: none;
  align-items: center;
  gap: 10px;
  min-height: var(--inspection-row-height);
  box-sizing: border-box;
  padding: 5px var(--inspection-gutter) 5px 38px;
  border-bottom: 1px solid var(--surface-line);
}
.inspection button { font-family: inherit; font-size: 12px; color: var(--text-secondary); cursor: pointer; transition: var(--control-transition); }
.inspection button:disabled { opacity: .45; cursor: default; }
.inspection-segments, .decision-controls {
  --selection-radius: var(--radius-inner);
  --selection-background: var(--surface-selected);
  position: relative;
  isolation: isolate;
  display: flex;
  flex: none;
  padding: 2px;
  gap: 2px;
  border-radius: var(--radius-control);
  corner-shape: var(--corner-shape);
  background: var(--surface-well);
}
.inspection-segments button, .decision-controls button {
  --button-press-scale: .97;
  position: relative;
  z-index: 1;
  min-height: 26px;
  padding: 3px 10px;
  border: 0;
  border-radius: var(--radius-inner);
  background: transparent;
  white-space: nowrap;
}
.inspection-segments button:hover:not(.active), .decision-controls button:hover:enabled:not(.active) { color: var(--text-default); background: var(--bg-overlay-l1); }
.inspection-segments button.active, .decision-controls button.active { color: var(--interaction-ink, var(--bg-brand)); }
.inspection-mode-short { display: none; }
.inspection-view-tools { display: flex; flex: none; align-items: center; gap: 5px; margin-inline-start: auto; }
.inspection .inspection-tool-button {
  --button-press-scale: .94;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  min-height: var(--inspection-tool-size);
  box-sizing: border-box;
  padding: 0 7px;
  border: 0;
  border-radius: var(--radius-inner);
  background: transparent;
  white-space: nowrap;
}
.inspection .icon-tool { width: var(--inspection-tool-size); padding: 0; }
.inspection .inspection-tool-button:hover:enabled { color: var(--text-default); background: var(--bg-overlay-l1); }
.inspection .inspection-tool-button[aria-expanded="true"] { color: var(--interaction-ink); background: var(--control-selection-surface); }
.inspection-tool-button svg, .inspection-edit-button svg { flex: none; }
.zoom-tools { display: flex; align-items: center; gap: 1px; border-radius: var(--radius-control); background: var(--surface-well); }
.zoom-tools span { min-width: 42px; text-align: center; font-variant-numeric: tabular-nums; font-size: 11px; color: var(--text-secondary); }
.inspection .inspection-edit-button { --button-press-scale: .97; display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 30px; padding: 4px 9px; border: 1px solid var(--surface-line); border-radius: var(--radius-inner); background: var(--surface-raised); }
.inspection .inspection-edit-button:hover:enabled { background: var(--surface-well); color: var(--text-default); }
.inspection .inspection-edit-button.primary { color: var(--text-brand); background: var(--control-selection-surface); border-color: var(--interaction-border); }
.inspection-edit-panel {
  display: grid;
  gap: 8px;
  min-width: 0;
  color: var(--text-default);
  font-size: 12px;
}
.inspection-edit-panel strong { font-size: 12px; font-weight: 600; }
.inspection-edit-panel p, .inspection-pad-details p { margin: 0; font-size: 11px; line-height: 1.55; color: var(--text-secondary); }
.inspection-size-current, .inspection-size-endpoints { display: flex; align-items: center; justify-content: space-between; gap: 6px 8px; }
.inspection-size-metric {
  position: relative;
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  padding: 2px;
  border: 1px solid var(--surface-line);
  border-radius: var(--radius-control);
  corner-shape: var(--corner-shape);
  background: var(--surface-well);
}
.inspection-size-metric::before {
  content: "";
  position: absolute;
  inset: 2px auto 2px 2px;
  width: calc((100% - 4px) / 2);
  border-radius: var(--radius-inner);
  corner-shape: var(--corner-shape);
  background: var(--control-selection-surface);
  pointer-events: none;
  transition: transform var(--motion-fast) var(--ease-selection);
}
.inspection-size-metric[data-metric="area"]::before { transform: translateX(100%); }
.inspection-size-metric label { position: relative; cursor: pointer; }
.inspection-size-metric input { position: absolute; inset: 0; width: 100%; height: 100%; margin: 0; opacity: 0; cursor: inherit; }
.inspection-size-metric label span {
  display: grid;
  place-items: center;
  min-width: 44px;
  min-height: 26px;
  padding: 0 9px;
  border-radius: var(--radius-inner);
  corner-shape: var(--corner-shape);
  color: var(--text-secondary);
  font-weight: 550;
  white-space: nowrap;
  transition: color var(--motion-fast) var(--ease-out);
}
.inspection-size-metric label:hover input:not(:checked) + span { color: var(--text-default); }
.inspection-size-metric input:checked + span { color: color-mix(in srgb, var(--text-brand) 80%, var(--text-default)); }
.inspection-size-metric input:focus-visible + span { outline: 2px solid var(--interaction-border); outline-offset: -2px; }
@media (forced-colors: active) {
  .inspection-size-metric input:checked + span { text-decoration: underline; }
}
.inspection-size-picker { min-width: 0; padding-block: 2px; }
.inspection-size-current { flex-wrap: wrap; color: var(--text-secondary); }
.inspection-size-current strong { color: var(--text-default); font-variant-numeric: tabular-nums; }
.inspection-size-range { display: block; width: 100%; height: 26px; margin: 3px 0 0; padding: 0; border-radius: var(--radius-inner); cursor: pointer; accent-color: var(--interaction-ink); }
.inspection-size-range:focus-visible { outline: 2px solid var(--interaction-border); outline-offset: 1px; }
.inspection-size-endpoints { gap: 4px; color: var(--text-secondary); font-size: 10px; font-variant-numeric: tabular-nums; }
.inspection-scale-heading { display: flex; align-items: center; justify-content: space-between; gap: 6px 10px; flex-wrap: wrap; }
.inspection-scale-value {
  min-width: 54px;
  padding: 4px 8px;
  border-radius: var(--radius-inner);
  background: var(--control-selection-surface);
  color: color-mix(in srgb, var(--text-brand) 80%, var(--text-default));
  font-size: 12px;
  line-height: 1.4;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  text-align: center;
}
.inspection-scale-value.is-neutral { background: var(--surface-well); color: var(--text-secondary); }
.inspection-scale-picker {
  --scale-thumb: 16px;
  --scale-thumb-color: var(--interaction-ink);
  --scale-thumb-border: var(--surface-raised);
  position: relative;
  min-width: 0;
}
.inspection-scale-picker.is-mixed { --scale-thumb-color: var(--text-secondary); }
.inspection-scale-track {
  position: absolute;
  inset: 12px calc(var(--scale-thumb) / 2) auto;
  height: 4px;
  border-radius: var(--radius-full);
  background: color-mix(in srgb, var(--text-secondary) 26%, var(--surface-line));
  pointer-events: none;
}
.inspection-scale-track::before, .inspection-scale-track::after { content: ""; position: absolute; border-radius: inherit; }
.inspection-scale-track::before {
  inset: 0 auto 0 var(--scale-fill-start);
  width: calc(var(--scale-fill-end) - var(--scale-fill-start));
  background: var(--interaction-ink);
}
.inspection-scale-track::after {
  inset: 50% auto auto var(--scale-baseline);
  width: 2px;
  height: 8px;
  translate: -50% -50%;
  background: var(--text-secondary);
}
.inspection-scale-range {
  position: relative;
  display: block;
  width: 100%;
  height: 28px;
  margin: 0;
  padding: 0;
  border-radius: var(--radius-inner);
  appearance: none;
  background: transparent;
  cursor: grab;
}
.inspection-scale-range:active { cursor: grabbing; }
.inspection-scale-range:focus-visible { outline: 2px solid var(--interaction-border); outline-offset: 1px; }
.inspection-scale-range::-webkit-slider-runnable-track { height: var(--scale-thumb); background: transparent; }
.inspection-scale-range::-webkit-slider-thumb {
  width: var(--scale-thumb);
  height: var(--scale-thumb);
  border: 2px solid var(--scale-thumb-border);
  border-radius: 50%;
  appearance: none;
  background: var(--scale-thumb-color);
}
.inspection-scale-range::-moz-range-thumb {
  width: calc(var(--scale-thumb) - 4px);
  height: calc(var(--scale-thumb) - 4px);
  border: 2px solid var(--scale-thumb-border);
  border-radius: 50%;
  background: var(--scale-thumb-color);
}
.inspection-scale-marks {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 24px;
  margin-inline: calc(var(--scale-thumb) / 2);
  color: var(--text-secondary);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.inspection .inspection-scale-baseline {
  position: absolute;
  inset-inline-start: var(--scale-baseline);
  translate: -50% 0;
  padding: 4px 7px;
  border: 0;
  border-radius: var(--radius-inner);
  background: transparent;
  color: var(--text-default);
  font: inherit;
  font-weight: 600;
}
.inspection .inspection-scale-baseline:hover:enabled { background: var(--control-selection-surface); }
@media (forced-colors: active) {
  .inspection-scale-range, .inspection-scale-track { forced-color-adjust: none; }
  .inspection-scale-range {
    --scale-thumb-color: Highlight;
    --scale-thumb-border: Canvas;
  }
  .inspection-scale-range:focus-visible { outline-color: Highlight; }
  .inspection-scale-track { background: GrayText; }
  .inspection-scale-track::before, .inspection-scale-track::after { background: Highlight; }
}
.inspection-edit-actions { display: flex; justify-content: flex-end; flex-wrap: wrap; align-items: center; gap: 6px 8px; }
.size-empty { margin-inline-end: auto; font-size: 11px; color: var(--text-tertiary); }
.inspection-state button:hover { background: var(--surface-well); }
.inspection-workspace { position: relative; display: flex; flex: 1; min-width: 0; min-height: 0; overflow: clip; }
.inspection-canvas { position: relative; order: -1; flex: 1; min-width: 0; min-height: 0; overflow: hidden; background-color: var(--surface-well); background-image: radial-gradient(var(--surface-line) .8px, transparent .8px); background-size: 20px 20px; }
.inspection-canvas > svg { display: block; width: 100%; height: 100%; position: absolute; inset: 0; touch-action: none; cursor: grab; user-select: none; }
.inspection-canvas.editing > svg { cursor: crosshair; }
.inspection-canvas.panning > svg, .inspection-canvas.panning .pad-hit { cursor: grabbing; }
.inspection-canvas.selecting .pad-hit { pointer-events: none; }
.inspection-canvas.panning .pad-hit { pointer-events: none; }
.inspection-canvas > svg:focus { outline: none; }
.inspection-canvas > svg:focus-visible { outline: 1px solid var(--interaction-ink, var(--bg-brand)); outline-offset: -2px; }
.inspection-canvas path { fill-rule: evenodd; vector-effect: non-scaling-stroke; }
.inspection-layer { opacity: 0; pointer-events: none; transition: opacity 180ms var(--ease-out); }
.inspection-layer.is-visible { opacity: 1; }
.inspection-canvas > svg.is-stale .inspection-layer.derived.is-visible { opacity: .4; }
.pcb-outline { fill: var(--inspection-board-fill, var(--surface-raised)); stroke: var(--inspection-board-stroke, var(--text-tertiary)); stroke-opacity: .6; stroke-width: 1; }
.original-mask { fill: var(--inspection-original, #638caf); fill-opacity: 1; stroke-opacity: 0; transition: fill-opacity 180ms var(--ease-out), stroke-opacity 180ms var(--ease-out); }
.original-mask.overlay { fill-opacity: .3; stroke: var(--inspection-original, #638caf); stroke-opacity: .65; stroke-width: .6; }
.opening-mask { fill: var(--inspection-opening, var(--bg-brand)); }
.filtered-mask { fill: var(--inspection-filtered, #d9913d); fill-opacity: .7; stroke: var(--inspection-filtered-stroke, #b97924); stroke-width: 1.2; }
.manual-mask, .filtered-mask, .selected-pad, .size-preview-pad { pointer-events: none; }
.manual-mask.closed { fill: var(--inspection-closed, #c56e75); fill-opacity: .55; stroke: var(--inspection-closed-stroke, #b95760); stroke-width: 1.2; }
.manual-mask.open { fill: none; stroke: var(--inspection-manual-open, #5b8eb9); stroke-width: 1.8; }
.pad-hit { fill: transparent; cursor: pointer; stroke: transparent; stroke-width: 0; pointer-events: fill; }
.pad-hit:hover, .pad-hit:focus-visible { fill: var(--inspection-selection, var(--bg-brand)); fill-opacity: .2; stroke: var(--inspection-selection, var(--bg-brand)); stroke-width: 1.2; }
.pad-hit:focus { outline: none; }
.scaled-mask, .overlap-mask { pointer-events: none; }
.scaled-mask { fill: none; stroke: var(--interaction-ink); stroke-width: 1.25; stroke-dasharray: 3 2; }
.overlap-mask { fill: var(--status-error-surface-l1); stroke: var(--status-error-default); stroke-width: 1.8; }
.inspection-overlap-alert { position: absolute; top: 12px; left: 38px; max-width: calc(100% - 50px); box-sizing: border-box; display: flex; align-items: center; flex-wrap: wrap; gap: 6px 8px; padding: 6px 9px; border: 1px solid color-mix(in srgb, var(--status-warning-default) 25%, transparent); border-radius: var(--radius-control); background: var(--status-warning-surface-l1); color: var(--text-default); font-size: 11px; }
.inspection-overlap-alert svg { flex: none; color: var(--status-warning-default); }
.inspection-overlap-alert button { border: 0; border-radius: var(--radius-inner); background: transparent; padding: 3px 5px; color: inherit; font-size: inherit; text-decoration: underline; text-underline-offset: 3px; }
.inspection-overlap-alert button:hover { background: color-mix(in srgb, currentColor 10%, transparent); }
.selected-pad, .size-preview-pad { fill: none; stroke: var(--inspection-selection, var(--bg-brand)); stroke-width: 2; }
.size-preview-pad { fill: var(--inspection-selection, var(--bg-brand)); fill-opacity: .12; stroke-width: 1.5; }
.selected-pad.is-scale-reference { opacity: .45; }
.scale-draft-preview { pointer-events: none; }
.scale-preview-pad {
  fill: var(--inspection-selection, var(--bg-brand));
  fill-opacity: .08;
  stroke: var(--inspection-selection, var(--bg-brand));
  stroke-width: 1.6;
  stroke-dasharray: 3 2;
  transform: scale(var(--aperture-draft-factor));
  transform-box: fill-box;
}
.selection-box { fill: var(--inspection-selection, var(--bg-brand)); fill-opacity: .1; stroke: var(--inspection-selection, var(--bg-brand)); stroke-width: 1; stroke-dasharray: 5 3; vector-effect: non-scaling-stroke; pointer-events: none; }
.inspection-state { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; padding: 24px; background: var(--surface-well); color: var(--text-secondary); font-size: 12px; text-align: center; }
.inspection-state.compact { inset: 12px auto auto 38px; flex-direction: row; gap: 8px; padding: 9px 12px; border: 1px solid var(--surface-line); border-radius: var(--radius-control); background: var(--surface-raised); box-shadow: var(--shadow-card); pointer-events: none; }
.inspection-state.compact.has-error { flex-wrap: wrap; max-width: calc(100% - 64px); color: var(--status-warning-default); pointer-events: auto; }
.inspection-state.is-complete { color: var(--interaction-ink); }
.inspection-status-enter-active { transition: opacity 180ms var(--ease-out); }
.inspection-status-leave-active { transition: opacity 120ms ease; pointer-events: none; }
.inspection-status-enter-from, .inspection-status-leave-to { opacity: 0; }
.inspection-state button { padding: 7px 16px; border: 1px solid var(--surface-line); border-radius: var(--radius-control); background: var(--surface-raised); }
.error-detail { max-width: 520px; max-height: 120px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 11px; }
.inspection-legend { position: absolute; left: 12px; right: 12px; bottom: 10px; display: flex; flex-wrap: wrap; gap: 5px 12px; pointer-events: none; }
.inspection-legend > span { display: inline-flex; align-items: center; gap: 5px; padding: 4px 7px; border-radius: var(--radius-inner); background: var(--surface-raised); font-size: 11px; color: var(--text-secondary); }
.legend-dot { display: inline-block; width: 7px; height: 7px; border-radius: 2px; flex: none; }
.legend-dot.original { background: var(--inspection-original, #638caf); }
.legend-dot.opening { background: var(--inspection-opening, var(--bg-brand)); }
.legend-dot.filtered { background: var(--inspection-filtered, #d9913d); }
.legend-dot.closed { background: var(--inspection-closed, #c56e75); }
.legend-dot.manual-open { background: var(--inspection-manual-open, #5b8eb9); }
.legend-dot.local-scale { box-sizing: border-box; border: 1px dashed var(--interaction-ink); }
.legend-dot.overlap { background: var(--status-error-default); }
.decision-controls button.open.active { color: var(--inspection-manual-open, #5b8eb9); }
.decision-controls button.closed.active { color: var(--inspection-closed-stroke, #b95760); }
.inspection-sidebar {
  display: flex;
  flex: 0 0 var(--inspection-sidebar-width);
  flex-direction: column;
  box-sizing: border-box;
  min-width: 0;
  min-height: 0;
  border-inline-start: 1px solid var(--surface-line);
  background: var(--surface-raised);
  color: var(--text-secondary);
  font-size: 12px;
}
.inspection-sidebar-heading {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: space-between;
  min-height: 42px;
  padding-inline: 14px 10px;
  border-bottom: 1px solid var(--surface-line);
}
.inspection-sidebar-heading h3 { margin: 0; color: var(--text-default); font-size: 13px; font-weight: 600; }
.inspection .inspection-sidebar-toggle, .inspection .inspection-sidebar-close { display: none; }
.inspection-sidebar-body {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 12px;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
  padding: 12px 10px 14px 14px;
}
.inspection-sidebar-body > * { flex: none; min-width: 0; }
.inspection-sidebar-summary { display: grid; gap: 7px; }
.inspection-counts {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  margin: 0;
  padding: 9px 10px;
  gap: 8px 12px;
  border-radius: var(--radius-control);
  corner-shape: var(--corner-shape);
  background: var(--surface-well);
}
.inspection-counts dt { font-size: 11px; overflow-wrap: anywhere; }
.inspection-counts dd { margin: 2px 0 0; color: var(--text-default); font-size: 17px; line-height: 1.25; font-weight: 600; }
.inspection-sidebar :is(dt, p, button) { overflow-wrap: anywhere; }
.inspection-sidebar :is(dd, strong, .inspection-selection-count) { font-variant-numeric: tabular-nums; }
.inspection-sidebar .inspection-tool-button { text-align: start; white-space: normal; }
.inspection-sidebar .filtered-toggle,
.inspection-sidebar .inspection-size-trigger,
.inspection-sidebar .details-button { width: 100%; min-height: 31px; justify-content: flex-start; gap: 8px; padding: 4px 8px; }
.inspection-sidebar .inspection-size-trigger { min-height: 34px; border: 1px solid var(--surface-line); background: var(--surface-well); }
.filtered-toggle > strong { margin-inline-start: auto; color: var(--text-default); font-weight: 600; }
.filtered-toggle[aria-pressed="false"] .legend-dot { background: transparent; box-shadow: inset 0 0 0 1px var(--inspection-filtered, #d9913d); }
.inspection-disclosure { margin-inline-start: auto; transition: rotate var(--motion-fast) var(--ease-out); }
.inspection-tool-button[aria-expanded="true"] .inspection-disclosure { rotate: 180deg; }
.inspection-size-panel { padding: 9px 2px 0; }
.inspection-size-panel .inspection-size-metric { justify-self: start; }
.inspection-selection-prompt { display: flex; align-items: center; gap: 9px; padding: 8px 7px; }
.inspection-selection-prompt svg { flex: none; color: var(--interaction-ink); }
.inspection-selection-prompt p { margin: 0; line-height: 1.55; }
.inspection-selected-tools { display: grid; gap: 8px; padding-block-start: 8px; border-top: 1px solid var(--surface-line); }
.inspection-selection { display: flex; align-items: center; justify-content: space-between; gap: 8px; color: var(--text-default); font-weight: 600; }
.inspection-selection-count { min-width: 0; overflow-wrap: anywhere; }
.inspection-selected-tools .decision-controls { min-width: 0; }
.inspection-selected-tools .decision-controls button { flex: 1; min-width: 0; padding: 4px 5px; white-space: normal; line-height: 1.3; }
.inspection-pad-details { display: grid; gap: 4px; padding: 6px 2px; font-size: 11px; font-variant-numeric: tabular-nums; }
.inspection-scale-panel { padding: 9px 0 0; border-top: 1px solid var(--surface-line); }
.inspection-scale-panel .inspection-edit-actions { justify-content: space-between; }
.inspection-scale-range:disabled { cursor: default; opacity: .45; }
.inspection-details-tools { padding-top: 3px; border-top: 1px solid var(--surface-line); }
.details-button.has-warning span::after { content: ""; display: inline-block; width: 5px; height: 5px; margin-inline-start: 6px; border-radius: 50%; vertical-align: middle; background: var(--status-warning-default); }
.inspection-details-panel { padding: 6px 4px 0; }
.inspection-detail-counts { display: grid; gap: 4px; margin: 0; font-size: 11px; }
.inspection-detail-counts > div { display: flex; justify-content: space-between; gap: 8px; }
.inspection-detail-counts dd { flex: none; margin: 0; font-weight: 600; }
.inspection-edit-panel .inspection-invalid { color: var(--status-warning-default); }
@container stencil-inspection (max-width: 680px) {
  .inspection .inspection-sidebar-toggle, .inspection .inspection-sidebar-close { display: inline-flex; }
  .inspection-sidebar-toggle { position: relative; }
  .inspection-sidebar-toggle.has-selection[aria-expanded="false"]::after {
    content: "";
    position: absolute;
    inset: 3px 3px auto auto;
    width: 6px;
    height: 6px;
    border: 1px solid var(--surface-raised);
    border-radius: 50%;
    background: var(--interaction-ink);
  }
  /* Overlay the canvas so revealing controls never changes its fit or zoom. */
  .inspection-sidebar {
    position: absolute;
    z-index: 1;
    inset-block: 0;
    inset-inline-end: 0;
    width: min(var(--inspection-sidebar-width), 90cqw);
    visibility: hidden;
    pointer-events: none;
    opacity: 0;
    translate: 8px 0;
    transition: opacity var(--motion-fast) var(--ease-out), translate var(--motion-fast) var(--ease-out);
    box-shadow: var(--shadow-card);
  }
  .inspection-sidebar.is-open { visibility: visible; pointer-events: auto; opacity: 1; translate: none; }
}
@container stencil-inspection (max-width: 520px) {
  .inspection-toolbar { --inspection-gutter: 10px; --inspection-tool-size: 26px; gap: 6px; }
  .inspection-mode-label { display: none; }
  .inspection-mode-short { display: inline; }
  .inspection-segments button { padding-inline: 7px; }
  .inspection-view-tools { gap: 4px; }
  .zoom-tools span { min-width: 36px; }
}
@container stencil-inspection (max-width: 390px) {
  .inspection-toolbar { flex-wrap: wrap; }
}
</style>
