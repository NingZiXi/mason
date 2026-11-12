<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { useI18n } from 'vue-i18n';
import { useConfigStore } from '../stores/config';
import { useUiStore } from '../stores/ui';
import { buildScadParams, scadPartHash } from '../lib/model-params';
import { GenerationTasks } from '../lib/generation-tasks';
import { inspectionBounds, polygonPath, type StencilInspection } from '../lib/stencil-inspection';
import { useStencilInspection } from '../composables/useStencilInspection';
import type { ApertureOverride } from '../lib/pad-overrides';
import { createInspectionInteraction } from '../lib/inspection-interaction';
import { mergeSelection, prepareSelectionPads } from '../lib/inspection-selection';
import { useFirstUseTour } from '../composables/useFirstUseTour';
import { useCompletionFeedback } from '../composables/useCompletionFeedback';
import SlidingIndicator from './SlidingIndicator.vue';
import ActionStatusIcon from './ActionStatusIcon.vue';

const OnboardingTour = defineAsyncComponent(() => import('./OnboardingTour.vue'));

const props = defineProps<{ active: boolean; side: 'top' | 'bottom' }>();
const { t, locale } = useI18n();
const store = useConfigStore();
const ui = useUiStore();
const inspectionEl = ref<HTMLElement | null>(null);
const tasks = new GenerationTasks(invoke);
const enabled = computed(() => props.active);
const { completed: checkCompleted, complete: completeCheck, reset: resetCheck } = useCompletionFeedback();
const request = computed(() => {
  if (!props.active || !store.pythonDetected) return null;
  const params = buildScadParams(store.config);
  // The other side cannot affect this inspection or its cache key.
  if (props.side === 'top') params.stencil_pads_bottom = [];
  else params.stencil_pads_top = [];
  const part = `stencil_${props.side}`;
  return { key: scadPartHash(params, part), part, params };
});
const { data: latest, resolvedKey, loading, error, retry } = useStencilInspection(enabled, request,
  (snapshot, signal) => tasks.run<StencilInspection>('inspect_stencil', { params: snapshot.params, part: snapshot.part }, 'preview', signal));
// Keep the same board visible during a recalculation; actions use only a fresh
// engine result. A board/side change clears this snapshot synchronously.
const data = shallowRef<StencilInspection | null>(null);
const mode = ref<'original' | 'openings' | 'compare'>('original');
const isEditing = computed(() => mode.value === 'original');
const showFiltered = ref(true);
const selectedIds = shallowRef<number[]>([]);
const decisionEl = ref<HTMLDivElement | null>(null);
const selectedPads = computed(() => {
  const ids = new Set(selectedIds.value);
  return data.value?.pads.filter(pad => ids.has(pad.sourceIndex)) ?? [];
});
const singlePad = computed(() => selectedPads.value.length === 1 ? selectedPads.value[0] : null);
const selectedFilter = computed(() => singlePad.value
  ? data.value?.filtered.find(pad => pad.sourceIndex === singlePad.value!.sourceIndex) : null);
const manualPads = computed(() => data.value?.pads.filter(pad => pad.decision !== 'auto') ?? []);
const editable = computed(() => isEditing.value && !!latest.value && !loading.value && !error.value && !store.historyBusy);
const commonDecision = computed(() => {
  const pads = props.side === 'top' ? store.config.stencilPadsTop : store.config.stencilPadsBottom;
  const values = new Set(selectedIds.value.map(index => pads[index]?.apertureOverride ?? 'auto'));
  return values.size === 1 ? [...values][0] : null;
});
const selectedPath = computed(() => selectedPads.value.map(pad => polygonPath(pad.polygons)).join(' '));
const selectionPads = computed(() => prepareSelectionPads(data.value?.pads ?? []));
const paths = computed(() => data.value ? {
  outline: polygonPath(data.value.outline), original: polygonPath(data.value.original),
  openings: polygonPath(data.value.openings), filtered: data.value.filtered.map(pad => polygonPath(pad.polygons)),
  pads: data.value.pads.map(pad => ({ ...pad, path: polygonPath(pad.polygons) })),
} : null);
function decide(value: 'auto' | ApertureOverride) {
  if (!selectedIds.value.length || !editable.value) return;
  store.setApertureOverrides(props.side, selectedIds.value, value === 'auto' ? undefined : value);
}
async function selectWithKeyboard(index: number, event: KeyboardEvent) {
  if (!isEditing.value) return;
  selectedIds.value = mergeSelection(selectedIds.value, [index], event.ctrlKey || event.metaKey ? 'toggle' : event.shiftKey ? 'add' : 'replace');
  await nextTick();
  decisionEl.value?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
}
const svgEl = ref<SVGSVGElement | null>(null);
const marqueeEl = ref<SVGRectElement | null>(null);
const gestureKind = ref<'pan' | 'select' | null>(null);
const zoom = ref(1);
const interaction = createInspectionInteraction({
  svg: () => svgEl.value, marquee: () => marqueeEl.value,
  canSelect: () => props.active && isEditing.value && !!data.value,
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
  () => store.config.pcbOutlinePoints], ([value]) => {
  if (!value || resolvedKey.value !== request.value?.key) return;
  const key = `${value.side}:${JSON.stringify(value.outline)}`;
  const updated = !!data.value && key === geometryKey && displayedRequestKey !== request.value?.key;
  data.value = value;
  const validIds = new Set(value.pads.map(pad => pad.sourceIndex));
  selectedIds.value = selectedIds.value.filter(id => validIds.has(id));
  if (key !== geometryKey) { geometryKey = key; fit(); }
  displayedRequestKey = request.value?.key ?? '';
  if (updated && props.active && !error.value) completeCheck();
});
watch([() => props.side, () => props.side === 'top' ? store.config.stencilPadsTop : store.config.stencilPadsBottom,
  () => store.config.pcbOutlinePoints], () => {
  interaction.finish(); data.value = null; selectedIds.value = []; geometryKey = ''; displayedRequestKey = ''; resetCheck();
}, { flush: 'sync' });
function fit() {
  if (data.value) interaction.fit(inspectionBounds(data.value));
}
function canvasKey(event: KeyboardEvent) {
  if (!isEditing.value) return;
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
    event.preventDefault(); selectedIds.value = data.value?.pads.map(pad => pad.sourceIndex) ?? [];
  } else if (event.key === 'Escape') {
    interaction.finish(); selectedIds.value = [];
  }
}
watch(mode, () => interaction.finish(), { flush: 'sync' });
watch([enabled, () => request.value?.key, error], resetCheck);
watch(enabled, () => { interaction.finish(); interaction.refresh(); });
watch(svgEl, () => interaction.refresh());
const tourReady = computed(() => props.active && !!latest.value && !!svgEl.value
  && store.pythonDetected && !loading.value && !error.value);
const { open: tourOpen, start: replayTour, close: finishTour } = useFirstUseTour({
  ready: () => tourReady.value,
  seen: () => ui.inspectionOnboardingSeen,
  prepare: () => { interaction.finish(); mode.value = 'original'; },
  dismiss: () => ui.dismissInspectionOnboarding(),
});
onBeforeUnmount(() => { interaction.dispose(); tasks.cancel(['preview']); });
</script>

<template>
  <div ref="inspectionEl" class="inspection">
    <div class="inspection-toolbar">
      <div class="inspection-segments" role="group" :aria-label="t('inspection.displayMode')">
        <SlidingIndicator />
        <button v-for="item in (['original', 'openings', 'compare'] as const)" :key="item" :class="{ active: mode === item }"
          :aria-pressed="mode === item" @click="mode = item">{{ t(`inspection.${item}`) }}<span v-if="item === 'original'" class="edit-badge">{{ t('inspection.editBadge') }}</span></button>
      </div>
      <button class="filtered-toggle" :class="{ active: showFiltered, 'is-concealed': mode === 'openings' }"
        :inert="mode === 'openings'" :aria-hidden="mode === 'openings'" :aria-pressed="showFiltered" @click="showFiltered = !showFiltered">
        <span class="legend-dot filtered" />{{ t('inspection.filtered') }}<span class="count">{{ data?.summary.filteredPads ?? '—' }}</span>
      </button>
      <button v-if="manualPads.length" class="reset-decisions" :class="{ 'is-concealed': !isEditing }" :inert="!isEditing" :aria-hidden="!isEditing"
        :disabled="!editable" @click="store.resetApertureOverrides(side)">
        {{ t('inspection.resetSide') }}<span class="count">{{ manualPads.length }}</span>
      </button>
      <div class="zoom-tools">
        <button :aria-label="t('inspection.zoomOut')" :title="t('inspection.zoomOut')" @click="interaction.zoomBy(1 / 1.35)">−</button>
        <span>{{ Math.round(zoom * 100) }}%</span>
        <button :aria-label="t('inspection.zoomIn')" :title="t('inspection.zoomIn')" @click="interaction.zoomBy(1.35)">+</button>
        <button class="fit-button" @click="fit">{{ t('inspection.fit') }}</button>
        <button class="tour-button" :disabled="!tourReady" :title="t('inspection.tour.replay')"
          :aria-label="t('inspection.tour.replay')" aria-haspopup="dialog" :aria-expanded="tourOpen" @click="replayTour">
          <svg viewBox="0 0 20 20" width="16" height="16" fill="none" aria-hidden="true">
            <circle cx="10" cy="10" r="7.25" stroke="currentColor" stroke-width="1.3" />
            <path d="M7.9 7.6a2.1 2.1 0 1 1 3.5 1.55C10.45 9.8 10 10.05 10 11.1" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
            <circle cx="10" cy="13.5" r=".8" fill="currentColor" />
          </svg>
        </button>
      </div>
    </div>
    <div class="inspection-context">
    <div class="selection-toolbar context-pane" :class="{ 'is-active': isEditing }" :inert="!isEditing" :aria-hidden="!isEditing">
      <div class="selection-label">
        <strong>{{ selectedIds.length ? t('inspection.selectedCount', { n: selectedIds.length }) : t('inspection.selectPrompt') }}</strong>
        <span v-if="singlePad" class="selection-size">#{{ singlePad.sourceIndex + 1 }} · {{ singlePad.width.toFixed(2) }} × {{ singlePad.height.toFixed(2) }} mm</span>
        <span v-else-if="!selectedIds.length">{{ t('inspection.selectHint') }}</span>
        <span v-else>{{ t(commonDecision ? `inspection.decision_${commonDecision}` : 'inspection.mixedDecisions') }}</span>
        <details v-if="selectedFilter && commonDecision === 'auto'" :key="`${side}:${selectedFilter.sourceIndex}:${selectedFilter.reason}`" class="selection-reason">
          <summary :aria-label="t('inspection.filterReason')">?</summary>
          <p>{{ t(`inspection.reason_${selectedFilter.reason}`) }}</p>
        </details>
      </div>
      <div ref="decisionEl" class="decision-controls" role="group" :aria-label="t('inspection.decision')">
        <SlidingIndicator />
        <button v-for="choice in (['open', 'closed', 'auto'] as const)" :key="choice" :class="[choice, { active: selectedIds.length && commonDecision === choice }]"
          :disabled="!selectedIds.length || !editable" :aria-pressed="!!selectedIds.length && commonDecision === choice"
          @click="decide(choice)">{{ t(choice === 'auto' ? 'inspection.restoreAuto' : `inspection.decision_${choice}`) }}</button>
      </div>
      <button class="clear-selection" :disabled="!selectedIds.length" @click="selectedIds = []">{{ t('inspection.clearSelection') }}</button>
    </div>
    <div class="readonly-notice context-pane" :class="{ 'is-active': !isEditing }" :inert="isEditing" :aria-hidden="isEditing">
      <span class="readonly-badge">{{ t('inspection.readonly') }}</span>{{ t('inspection.readonlyHint') }}
    </div>
    </div>
    <div class="inspection-canvas" :class="{ panning: gestureKind === 'pan', selecting: gestureKind === 'select', editing: isEditing }">
      <svg v-if="data && paths" ref="svgEl" viewBox="-10 -10 20 20" :aria-label="t('inspection.title')" tabindex="0"
        @wheel.prevent="interaction.wheel" @pointerdown="interaction.down" @pointermove="interaction.move" @pointerup="interaction.finish"
        @pointercancel="interaction.finish" @lostpointercapture="interaction.finish" @contextmenu.prevent @keydown="canvasKey">
        <g v-memo="[paths, mode, showFiltered, locale]">
        <path :d="paths.outline" class="pcb-outline" />
        <g class="inspection-layer" :class="{ 'is-visible': mode !== 'openings' }" aria-hidden="true">
          <path :d="paths.original" class="original-mask" :class="{ overlay: mode === 'compare' }" />
        </g>
        <g class="inspection-layer" :class="{ 'is-visible': mode !== 'original' }" aria-hidden="true">
          <path :d="paths.openings" class="opening-mask" />
        </g>
        <g class="inspection-layer" :class="{ 'is-visible': showFiltered && mode !== 'openings' }" aria-hidden="true">
          <path v-for="(path, index) in paths.filtered" :key="index" :d="path" class="filtered-mask"
            />
        </g>
        <g class="inspection-layer" :class="{ 'is-visible': mode !== 'openings' }" aria-hidden="true">
          <template v-for="pad in paths.pads" :key="`manual-${pad.sourceIndex}`">
            <path v-if="pad.decision !== 'auto'" :d="pad.path" class="manual-mask" :class="pad.decision" />
          </template>
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
        <path v-if="isEditing && selectedPath" :d="selectedPath" class="selected-pad" />
        <rect ref="marqueeEl" class="selection-box" style="display: none" />
      </svg>
      <Transition name="inspection-status">
      <div v-if="loading || error || !store.pythonDetected || checkCompleted" class="inspection-state"
        :key="error ? 'error' : !store.pythonDetected ? 'unavailable' : 'progress'"
        :class="{ compact: data && (loading || checkCompleted) && store.pythonDetected && !error, 'is-complete': checkCompleted && !loading }" role="status">
        <template v-if="loading || checkCompleted">
          <ActionStatusIcon :state="loading ? 'busy' : 'success'" :size="data ? 14 : 22" />
          <span>{{ t(loading ? 'inspection.loading' : 'preview.refreshed') }}</span>
        </template>
        <template v-else-if="error"><strong>{{ t('inspection.failed') }}</strong><span class="error-detail">{{ error }}</span><button @click="retry">{{ t('inspection.retry') }}</button></template>
        <template v-else>{{ t('preview.noPythonPreview') }}</template>
      </div>
      </Transition>
      <div v-if="data" class="inspection-legend" aria-hidden="true">
        <span v-if="mode !== 'openings'"><i class="legend-dot original" />{{ t('inspection.original') }}</span>
        <span v-if="mode !== 'original'"><i class="legend-dot opening" />{{ t('inspection.openings') }}</span>
        <span v-if="showFiltered && mode !== 'openings'"><i class="legend-dot filtered" />{{ t('inspection.filtered') }}</span>
        <span v-if="mode !== 'openings' && manualPads.some(pad => pad.decision === 'closed')"><i class="legend-dot closed" />{{ t('inspection.manualClosed') }}</span>
        <span v-if="mode !== 'openings' && manualPads.some(pad => pad.decision === 'open')"><i class="legend-dot manual-open" />{{ t('inspection.manualOpen') }}</span>
      </div>
    </div>
    <div class="inspection-footer" aria-live="polite">
      <div v-if="data" class="inspection-counts">
        <span>{{ t('inspection.sourceCount') }} <strong>{{ data.summary.sourcePads }}</strong></span>
        <span>{{ t('inspection.openingCount') }} <strong>{{ data.summary.openings }}</strong></span>
        <span :class="{ warning: data.summary.filteredPads > 0 }">{{ t('inspection.filtered') }} <strong>{{ data.summary.filteredPads }}</strong></span>
        <span v-if="manualPads.length">{{ t('inspection.manualCount') }} <strong>{{ manualPads.length }}</strong></span>
        <span v-if="data.summary.invalidPads" class="warning">{{ t('inspection.invalid', { n: data.summary.invalidPads }) }}</span>
      </div>
      <span class="inspection-help">{{ t(isEditing ? 'inspection.gestures' : 'inspection.viewGestures') }}</span>
      <span v-if="data" class="inspection-orientation">{{ t(data.mirrored ? 'inspection.topOrientation' : 'inspection.bottomOrientation') }} · {{ t('inspection.countHint') }}</span>
    </div>
    <OnboardingTour v-if="tourOpen && inspectionEl" mode="stencil" context="inspection" :root="inspectionEl" @close="finishTour" />
  </div>
</template>

<style scoped>
.inspection { position: absolute; inset: 0 0 0 var(--preview-inset, 0px); display: flex; flex-direction: column; min-width: 0; min-height: 0; overflow-y: auto; overscroll-behavior: contain; container: stencil-inspection / size; background: var(--surface-raised); }
/* Leave the 24px sidebar handle its own space, plus a 16px gap. */
.inspection-toolbar { display: flex; flex-shrink: 0; align-items: center; gap: 14px; flex-wrap: wrap; padding: 12px 20px 12px 40px; border-bottom: 1px solid var(--surface-line); }
.inspection button { font-family: inherit; font-size: 12px; color: var(--text-secondary); cursor: pointer; transition: var(--control-transition); }
.zoom-tools button { --button-press-scale: .92; }
.decision-controls button { --button-press-scale: .97; }
.inspection button:disabled { opacity: .45; cursor: default; }
.inspection-segments { --selection-radius: var(--radius-inner); --selection-background: var(--surface-selected); position: relative; isolation: isolate; display: inline-flex; padding: 3px; gap: 2px; border: 1px solid var(--surface-line); border-radius: var(--radius-control); background: var(--surface-well); }
.inspection-segments button { position: relative; z-index: 1; padding: 6px 12px; border: 0; border-radius: var(--radius-inner); background: transparent; }
.inspection-segments button:hover:not(.active) { color: var(--text-default); background: var(--bg-overlay-l1); }
.inspection-segments button.active { color: var(--interaction-ink, var(--bg-brand)); }
.edit-badge { display: inline-block; margin-left: 6px; padding: 1px 4px; border-radius: 4px; font-size: 9px; background: color-mix(in srgb, var(--bg-brand) 10%, transparent); color: var(--interaction-ink, var(--bg-brand)); }
/* Both contexts share one measured row, so changing modes cannot resize the
   SVG viewport or shift a board the user has already positioned. */
.inspection-context { position: relative; z-index: 2; display: grid; flex-shrink: 0; }
.context-pane { grid-area: 1 / 1; opacity: 0; visibility: hidden; pointer-events: none; transform: translateY(3px); transition: opacity 140ms ease, transform 180ms var(--ease-out), visibility 180ms; }
.context-pane.is-active { opacity: 1; visibility: visible; pointer-events: auto; transform: translateY(0); transition: opacity 180ms var(--ease-out), transform 200ms var(--ease-out), visibility 0ms; }
.inspection-toolbar .is-concealed { opacity: 0; visibility: hidden; pointer-events: none; }
.selection-toolbar { display: flex; align-items: center; flex-wrap: wrap; gap: 10px 16px; min-height: 58px; box-sizing: border-box; padding: 10px 20px; border-bottom: 1px solid var(--surface-line); background: var(--surface-raised); }
.selection-label { display: flex; align-items: center; flex-wrap: wrap; gap: 5px 12px; margin-right: auto; color: var(--text-tertiary); font-size: 11px; }
.selection-label strong { color: var(--text-default); font-size: 12px; font-weight: 500; }
.selection-size { font-family: var(--font-family-mono); font-size: 10px; }
.selection-reason { position: relative; color: var(--text-secondary); font-size: 11px; line-height: 1.5; }
.selection-reason summary { display: grid; place-items: center; width: 19px; height: 19px; box-sizing: border-box; border: 1px solid var(--surface-line); border-radius: 50%; cursor: pointer; list-style: none; }
.selection-reason summary::-webkit-details-marker { display: none; }
.selection-reason p { position: absolute; z-index: 3; top: 23px; left: 0; width: 240px; max-width: 60vw; margin: 0; padding: 12px; border: 1px solid var(--surface-line); border-radius: var(--radius-control); background: var(--surface-raised); box-shadow: var(--shadow-card); }
.clear-selection { background: transparent; border: none; padding: 5px 0; }
.readonly-notice { display: flex; align-items: center; gap: 10px; box-sizing: border-box; min-height: 58px; padding: 10px 20px; border-bottom: 1px solid var(--surface-line); color: var(--text-tertiary); font-size: 11px; }
.readonly-badge { flex-shrink: 0; border: 1px solid var(--surface-line); background: var(--surface-well); padding: 3px 7px; border-radius: var(--radius-inner); color: var(--text-secondary); font-size: 10px; }
.filtered-toggle { display: inline-flex; align-items: center; gap: 6px; padding: 7px 10px; border: 1px solid transparent; border-radius: var(--radius-control); background: transparent; }
.filtered-toggle.active { border-color: color-mix(in srgb, var(--status-warning-default) 24%, transparent); background: var(--status-warning-surface-l1); }
.count { font-family: var(--font-family-mono); font-size: 11px; }
.reset-decisions { display: inline-flex; align-items: center; gap: 7px; padding: 7px 10px; border: 1px solid var(--surface-line); border-radius: var(--radius-control); background: var(--surface-raised); }
.reset-decisions:hover:enabled { background: var(--surface-well); }
.zoom-tools { display: flex; align-items: center; gap: 3px; margin-left: auto; }
.zoom-tools button { border: 1px solid var(--surface-line); border-radius: var(--radius-inner); background: var(--surface-raised); width: 28px; height: 28px; font-size: 17px; }
.zoom-tools button:hover, .inspection-state button:hover { background: var(--surface-well); }
.zoom-tools span { min-width: 48px; text-align: center; font-family: var(--font-family-mono); font-size: 11px; color: var(--text-secondary); }
.zoom-tools .fit-button { width: auto; padding: 0 10px; margin-left: 7px; font-size: 11px; }
.zoom-tools .tour-button { display: grid; place-items: center; margin-left: 5px; border: 0; border-radius: 50%; background: transparent; color: var(--text-tertiary); }
.zoom-tools .tour-button:hover:enabled { color: var(--interaction-ink, var(--bg-brand)); background: var(--surface-selected); }
.inspection-canvas { position: relative; flex: 1; min-height: 0; overflow: hidden; background-color: var(--surface-well); background-image: radial-gradient(var(--surface-line) .8px, transparent .8px); background-size: 20px 20px; }
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
.pcb-outline { fill: var(--inspection-board-fill, var(--surface-raised)); stroke: var(--inspection-board-stroke, var(--text-tertiary)); stroke-opacity: .6; stroke-width: 1; }
.original-mask { fill: var(--inspection-original, #638caf); fill-opacity: 1; stroke-opacity: 0; transition: fill-opacity 180ms var(--ease-out), stroke-opacity 180ms var(--ease-out); }
.original-mask.overlay { fill-opacity: .3; stroke: var(--inspection-original, #638caf); stroke-opacity: .65; stroke-width: .6; }
.opening-mask { fill: var(--inspection-opening, var(--bg-brand)); }
.filtered-mask { fill: var(--inspection-filtered, #d9913d); fill-opacity: .7; stroke: var(--inspection-filtered-stroke, #b97924); stroke-width: 1.2; }
.manual-mask, .filtered-mask, .selected-pad { pointer-events: none; }
.manual-mask.closed { fill: var(--inspection-closed, #c56e75); fill-opacity: .55; stroke: var(--inspection-closed-stroke, #b95760); stroke-width: 1.2; }
.manual-mask.open { fill: none; stroke: var(--inspection-manual-open, #5b8eb9); stroke-width: 1.8; }
.pad-hit { fill: transparent; cursor: pointer; stroke: transparent; stroke-width: 0; pointer-events: fill; }
.pad-hit:hover, .pad-hit:focus-visible { fill: var(--inspection-selection, var(--bg-brand)); fill-opacity: .2; stroke: var(--inspection-selection, var(--bg-brand)); stroke-width: 1.2; }
.pad-hit:focus { outline: none; }
.selected-pad { fill: none; stroke: var(--inspection-selection, var(--bg-brand)); stroke-width: 2; }
.selection-box { fill: var(--inspection-selection, var(--bg-brand)); fill-opacity: .1; stroke: var(--inspection-selection, var(--bg-brand)); stroke-width: 1; stroke-dasharray: 5 3; vector-effect: non-scaling-stroke; pointer-events: none; }
.inspection-state { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; padding: 24px; background: var(--surface-well); color: var(--text-secondary); font-size: 12px; text-align: center; }
.inspection-state.compact { inset: 14px auto auto 16px; flex-direction: row; gap: 8px; padding: 9px 12px; border: 1px solid var(--surface-line); border-radius: var(--radius-control); background: var(--surface-raised); box-shadow: var(--shadow-card); pointer-events: none; }
.inspection-state.is-complete { color: var(--interaction-ink); }
.inspection-status-enter-active { transition: opacity 180ms var(--ease-out); }
.inspection-status-leave-active { transition: opacity 120ms ease; pointer-events: none; }
.inspection-status-enter-from, .inspection-status-leave-to { opacity: 0; }
.inspection-state button { padding: 7px 16px; border: 1px solid var(--surface-line); border-radius: var(--radius-control); background: var(--surface-raised); }
.error-detail { max-width: 520px; max-height: 120px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 11px; }
.inspection-legend { position: absolute; left: 18px; bottom: 16px; display: flex; flex-wrap: wrap; gap: 14px; padding: 9px 12px; border: 1px solid var(--surface-line); border-radius: var(--radius-control); background: var(--surface-raised); pointer-events: none; }
.inspection-legend > span { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--text-secondary); }
.legend-dot { display: inline-block; width: 7px; height: 7px; border-radius: 2px; flex-shrink: 0; }
.legend-dot.original { background: var(--inspection-original, #638caf); }
.legend-dot.opening { background: var(--inspection-opening, var(--bg-brand)); }
.legend-dot.filtered { background: var(--inspection-filtered, #d9913d); }
.legend-dot.closed { background: var(--inspection-closed, #c56e75); }
.legend-dot.manual-open { background: var(--inspection-manual-open, #5b8eb9); }
.decision-controls { --selection-radius: var(--radius-inner); position: relative; isolation: isolate; display: flex; gap: 3px; padding: 3px; background: var(--surface-well); border: 1px solid var(--surface-line); border-radius: var(--radius-control); }
.decision-controls button { position: relative; z-index: 1; flex: 1; white-space: nowrap; padding: 6px 14px; border: 0; border-radius: var(--radius-inner); background: transparent; }
.decision-controls button:hover:enabled:not(.active) { background: var(--bg-overlay-l1); }
.decision-controls button.active { color: var(--text-default); }
.decision-controls button.open.active { color: var(--inspection-manual-open, #5b8eb9); }
.decision-controls button.closed.active { color: var(--inspection-closed-stroke, #b95760); }
.inspection-footer { display: flex; flex-shrink: 0; flex-wrap: wrap; gap: 8px 16px; padding: 12px 20px; border-top: 1px solid var(--surface-line); color: var(--text-tertiary); font-size: 11px; overflow-wrap: anywhere; }
.inspection-counts { display: flex; flex-wrap: wrap; gap: 16px; }
.inspection-counts strong { margin-left: 4px; color: var(--text-default); font-family: var(--font-family-mono); font-size: 12px; font-weight: 500; }
.inspection-counts .warning, .inspection-counts .warning strong { color: var(--status-warning-default); }
.inspection-help { margin-left: auto; }
.inspection-orientation { width: 100%; font-size: 10px; line-height: 1.6; }
@container stencil-inspection (max-width: 700px) {
  .inspection-toolbar { padding: 10px 12px 10px 40px; gap: 8px; }
  .selection-toolbar, .readonly-notice { padding: 10px 12px; }
  .selection-label { flex-basis: 100%; }
  .inspection-legend { left: 10px; right: 10px; bottom: 10px; gap: 8px 12px; }
}
@container stencil-inspection (max-height: 480px) {
  .inspection-toolbar { padding-block: 8px; gap: 8px; }
  .selection-toolbar, .readonly-notice { min-height: 48px; padding-block: 8px; }
  .inspection-footer { padding-block: 8px; gap: 5px 12px; }
  /* Keep a usable drawing area; the inspection itself can scroll when the
     translated controls need more rows than this short viewport can hold. */
  .inspection-canvas { flex: 1 0 160px; }
}
</style>
