<script setup lang="ts">
import { computed, defineAsyncComponent, ref, useId, watch } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { useI18n } from 'vue-i18n';
import { DEFAULT, useConfigStore } from '../stores/config';
import { effectiveInsertHeight, type ComponentReliefMergeResult, type ComponentReliefRegion, type JigPrintSide } from '../lib/component-relief';
import { buildScadParams } from '../lib/model-params';
import InlineHelp from './InlineHelp.vue';
import MotionCollapse from './MotionCollapse.vue';
import SlidingIndicator from './SlidingIndicator.vue';
import ComponentReliefPreview from './ComponentReliefPreview.vue';

const ComponentReliefEditor = defineAsyncComponent(() => import('./ComponentReliefEditor.vue'));
const store = useConfigStore();
const { t } = useI18n();
const entryId = useId();
const c = computed(() => store.config);
const ejectHoleEnabled = computed({
  get: () => c.value.ejectSlotWidth > 0,
  set: (enabled: boolean) => { c.value.ejectSlotWidth = enabled ? DEFAULT.ejectSlotWidth : 0; },
});
const editorOpen = ref(false);
const editorLoaded = ref(false);
const regions = computed(() => c.value.componentReliefRegions[c.value.jigPrintSide]);
const entryStatus = computed(() => !c.value.componentReliefEnabled ? 'off' : regions.value.length ? 'ready' : 'pending');
const entryStatusLabel = { off: 'relief.entryOff', ready: 'relief.entryOn', pending: 'relief.entryPending' } as const;
const undersidePads = computed(() => c.value.jigPrintSide === 'top' ? c.value.stencilPadsBottom : c.value.stencilPadsTop);
const trayHeight = computed(() => effectiveInsertHeight(c.value));
const trayHeightCaption = computed(() => t('relief.trayHeight', { height: trayHeight.value.toFixed(2).replace(/0$/, '') }));
let revealFrom: HTMLButtonElement | undefined;

function toggleRelief(event: MouseEvent) {
  const enable = !c.value.componentReliefEnabled;
  revealFrom = enable ? event.currentTarget as HTMLButtonElement : undefined;
  c.value.componentReliefEnabled = enable;
}

function choosePrintSide(side: JigPrintSide) {
  revealFrom = undefined;
  c.value.jigPrintSide = side;
}

function revealEditorEntry(panel: Element) {
  const trigger = revealFrom;
  revealFrom = undefined;
  if (!trigger?.isConnected || !c.value.componentReliefEnabled) return;
  const sidebar = panel.closest<HTMLElement>('.app-sidebar');
  const entry = panel.querySelector('[data-relief-editor-entry]');
  if (!sidebar || !entry) return;
  const top = sidebar.getBoundingClientRect().top + sidebar.clientTop;
  const bottom = top + sidebar.clientHeight;
  const triggerBounds = trigger.getBoundingClientRect();
  if (triggerBounds.bottom <= top || triggerBounds.top >= bottom) return;
  const overflow = entry.getBoundingClientRect().bottom - bottom;
  if (overflow <= 1) return;
  sidebar.scrollBy({ top: overflow + 12, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
}

function openEditor() {
  editorLoaded.value = true;
  editorOpen.value = true;
}
function reliefParams(proposed: ComponentReliefRegion[]) {
  // These 2D operations need only the tray geometry, never the paste-pad arrays.
  return buildScadParams({ ...c.value, stencilPadsTop: [], stencilPadsBottom: [],
    componentReliefRegions: { ...c.value.componentReliefRegions, [c.value.jigPrintSide]: proposed } });
}
function validateRegions(proposed: ComponentReliefRegion[]): Promise<{ valid: boolean; error?: string }> {
  return invoke('validate_component_relief', { params: reliefParams(proposed) });
}
function mergeRegions(proposed: ComponentReliefRegion[], gap: number, selectedIds: string[]): Promise<ComponentReliefMergeResult> {
  return invoke('merge_component_relief', { params: reliefParams(proposed), gap, selectedIds });
}
watch(() => [c.value.componentReliefEnabled, c.value.pcbOutlinePoints, c.value.appMode], () => {
  editorOpen.value = false;
  if (!c.value.componentReliefEnabled || c.value.appMode !== 'jig') revealFrom = undefined;
});
</script>

<template>
  <section v-if="c.appMode === 'jig' && c.pcbOutlinePoints.length >= 3" class="relief-section" :class="{ 'is-enabled': c.componentReliefEnabled }" :aria-label="t('relief.title')">
    <InlineHelp id="component-relief-help" topic="relief" :label="t('relief.title')">
      <span class="section-title">{{ t('relief.title') }}</span>
      <template #trailing><span class="entry-state" :class="`state-${entryStatus}`" aria-live="polite">{{ t(entryStatusLabel[entryStatus]) }}</span></template>
    </InlineHelp>
    <button type="button" class="relief-entry" role="switch" :aria-checked="c.componentReliefEnabled"
      :aria-label="t('relief.title')" :aria-describedby="`${entryId}-hint`" :aria-controls="`${entryId}-settings`"
      @click="toggleRelief">
      <span class="entry-art" aria-hidden="true">
        <svg viewBox="0 0 32 32" width="32" height="32">
          <!-- Side section: the package hangs below the PCB, inside the tray pocket. -->
          <path class="entry-tray" d="M2.5 17H9v7h14v-7h6.5v11h-27z" />
          <g class="entry-assembly">
            <rect class="entry-board" x="3" y="7" width="26" height="3.5" rx="1.3" />
            <path d="M11.5 10.5v2h2m7-2v2h-2" />
            <rect class="entry-package" x="12.5" y="11" width="7" height="5.5" rx="1" />
          </g>
        </svg>
      </span>
      <span class="entry-copy">
        <span class="entry-title">{{ t('relief.enabled') }}</span>
        <span :id="`${entryId}-hint`" class="entry-hint">{{ t('relief.entryHint') }}</span>
      </span>
      <span class="entry-switch" aria-hidden="true"><span class="entry-thumb">
        <svg viewBox="0 0 12 12" width="12" height="12"><path d="m3 6 2 2 4-4" /></svg>
      </span></span>
    </button>
    <MotionCollapse :id="`${entryId}-settings`" :open="c.componentReliefEnabled" @shown="revealEditorEntry">
      <div class="relief-settings">
        <div class="side-heading">
          <span :id="`${entryId}-print-side`" class="field-label">{{ t('relief.printSide') }}</span>
          <span class="underside-label" aria-live="polite">{{ t(c.jigPrintSide === 'top' ? 'relief.undersideBottom' : 'relief.undersideTop') }}</span>
        </div>
        <div class="side-picker" role="group" :aria-labelledby="`${entryId}-print-side`">
          <SlidingIndicator />
          <button v-for="side in (['top', 'bottom'] as const)" :key="side" type="button"
            class="side-button" :class="{ active: c.jigPrintSide === side }" :aria-pressed="c.jigPrintSide === side"
            @click="choosePrintSide(side)">
            <svg class="side-icon" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
              <g v-if="side === 'top'">
                <path class="side-board" d="M3 12.5h18v3H3z" />
                <rect class="side-package" x="8.5" y="6.5" width="7" height="5" rx="1.2" />
                <path d="M6.5 12.5v-3h2m9 3v-3h-2" />
              </g>
              <g v-else>
                <path class="side-board" d="M3 8.5h18v3H3z" />
                <path class="side-package" d="M6 11.5h4.5v5H6zM14 11.5h3.5v3.5H14z" />
              </g>
            </svg>
            <span>{{ t(`relief.${side}`) }}</span>
          </button>
        </div>
        <ComponentReliefPreview data-relief-editor-entry :regions="regions" :outline="c.pcbOutlinePoints" :holes="c.pcbOutlineHoles"
          :print-side="c.jigPrintSide" :width="c.pcbSizeX" :height="c.pcbSizeY"
          :default-depth="c.componentReliefDepth" @edit="openEditor" />
        <div v-if="regions.length" class="tray-readout">
          <InlineHelp v-if="trayHeight > c.insertHeight" id="component-relief-height-help" topic="height"
            :label="trayHeightCaption">
            <span>{{ trayHeightCaption }}</span>
          </InlineHelp>
          <span v-else>{{ trayHeightCaption }}</span>
        </div>
      </div>
    </MotionCollapse>
    <ComponentReliefEditor v-if="editorLoaded" v-model="editorOpen" v-model:eject-hole-enabled="ejectHoleEnabled" :regions="regions"
      :outline="c.pcbOutlinePoints" :holes="c.pcbOutlineHoles" :pads="undersidePads" :print-side="c.jigPrintSide"
      :width="c.pcbSizeX" :height="c.pcbSizeY" :depth="c.componentReliefDepth"
      :validate-regions="validateRegions" :merge-regions="mergeRegions"
      :can-undo="store.canUndo" :can-redo="store.canRedo" :undo="store.undo" :redo="store.redo"
      @update:depth="store.setComponentReliefDefaultDepth"
      @update:regions="store.setComponentReliefRegions" @interaction-start="store.beginParameterInteraction"
      @interaction-end="store.endParameterInteraction" />
  </section>
</template>

<style scoped>
.relief-section { padding: 18px 0; border-top: 1px solid var(--surface-line); }
.section-title { color: var(--text-default); font-size: var(--body-md-font-size); font-weight: 600; }
.entry-state { color: var(--text-tertiary); font-size: 10px; line-height: 1.6; transition: color var(--motion-fast) var(--ease-out); }
.entry-state.state-pending { color: var(--text-secondary); }
.entry-state.state-ready { color: var(--interaction-ink); }
.relief-entry { --button-press-scale: .99; display: flex; align-items: center; gap: 11px; width: 100%; min-height: 76px; margin-top: 9px; padding: 13px 12px; border: 1px solid color-mix(in srgb, var(--interaction-border) 28%, var(--surface-line)); border-radius: var(--radius-popover); corner-shape: var(--corner-shape); background: color-mix(in srgb, var(--interaction-border) 4%, var(--surface-raised)); color: var(--text-default); font: inherit; text-align: start; cursor: pointer; transition: var(--control-transition); }
.relief-entry:focus-visible { outline: 2px solid var(--interaction-border); outline-offset: -1px; }
.entry-art { display: grid; place-items: center; flex: 0 0 40px; width: 40px; height: 44px; border-radius: var(--radius-control); background: color-mix(in srgb, var(--interaction-border) 9%, var(--surface-raised)); color: var(--interaction-ink); }
.entry-art svg { overflow: visible; fill: none; stroke: currentColor; stroke-width: 1.3; stroke-linecap: round; stroke-linejoin: round; }
.entry-board { fill: var(--surface-raised); }
.entry-package, .side-package { fill: currentColor; }
.entry-assembly { transition: transform var(--motion-selection) var(--ease-settle); }
.entry-tray { fill: color-mix(in srgb, currentColor 12%, transparent); opacity: .72; }
.entry-copy { display: flex; flex: 1; flex-direction: column; min-width: 0; gap: 4px; overflow-wrap: anywhere; }
.entry-title { font-size: var(--body-sm-font-size); font-weight: 600; line-height: 1.5; }
.entry-hint { color: var(--text-secondary); font-size: 10px; line-height: 1.6; }
.entry-switch { display: flex; align-items: center; flex: 0 0 38px; width: 38px; height: 24px; padding: 3px; box-sizing: border-box; border: 1px solid color-mix(in srgb, var(--text-tertiary) 35%, var(--surface-line)); border-radius: var(--radius-full); background: var(--surface-well); transition: background-color var(--motion-panel) var(--ease-out), border-color var(--motion-fast) var(--ease-out); }
.entry-thumb { display: grid; place-items: center; width: 16px; height: 16px; border-radius: 50%; background: var(--text-tertiary); color: var(--surface-raised); transition: transform var(--motion-selection) var(--ease-selection), background-color var(--motion-fast) var(--ease-out); }
.entry-thumb svg { fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; opacity: 0; transition: opacity var(--motion-fast) var(--ease-out); }
.is-enabled .relief-entry { border-color: color-mix(in srgb, var(--interaction-border) 58%, var(--surface-line)); background: color-mix(in srgb, var(--interaction-border) 8%, var(--surface-raised)); }
.is-enabled .entry-assembly { transform: translateY(6px); }
.is-enabled .entry-switch { border-color: var(--interaction-border); background: var(--interaction-border); }
.is-enabled .entry-thumb { transform: translateX(14px); background: var(--surface-raised); color: var(--interaction-ink); }
.is-enabled .entry-thumb svg { opacity: 1; }
@media (hover: hover) and (pointer: fine) {
  .relief-entry:hover { border-color: var(--interaction-border); background: color-mix(in srgb, var(--interaction-border) 10%, var(--surface-raised)); }
}
.relief-settings { display: flex; flex-direction: column; gap: 10px; padding-top: 15px; }
.side-heading { display: flex; align-items: baseline; justify-content: space-between; flex-wrap: wrap; gap: 4px 10px; }
.field-label { color: var(--text-default); font-size: var(--body-sm-font-size); font-weight: 600; }
.side-picker { --selection-radius: var(--radius-inner); --selection-shadow: none; position: relative; isolation: isolate; display: flex; gap: 3px; padding: 4px; border: 1px solid var(--surface-line); border-radius: var(--radius-control); corner-shape: var(--corner-shape); background: var(--surface-well); }
.side-button { position: relative; z-index: 1; display: flex; align-items: center; justify-content: center; gap: 7px; flex: 1; min-width: 0; min-height: 32px; padding: 6px 9px; border: 0; border-radius: var(--radius-inner); corner-shape: var(--corner-shape); background: transparent; color: var(--text-secondary); font: inherit; font-size: var(--body-sm-font-size); cursor: pointer; transition: var(--control-transition); }
.side-button.active { color: var(--interaction-ink); font-weight: 600; }
.side-button:hover:not(.active) { color: var(--text-default); background: var(--bg-overlay-l1); }
.side-icon { flex: 0 0 auto; fill: none; stroke: currentColor; stroke-width: 1.45; stroke-linecap: round; stroke-linejoin: round;
  transform: perspective(80px) rotateY(180deg); opacity: .76;
  transition: transform var(--motion-selection) cubic-bezier(.3, .1, .2, 1.1), opacity var(--motion-fast) var(--ease-out); }
.side-board { fill: color-mix(in srgb, currentColor 14%, transparent); }
.side-button.active .side-icon { transform: perspective(80px) rotateY(0deg); opacity: 1; }
@media (prefers-reduced-motion: reduce) {
  .side-icon, .side-button.active .side-icon { transform: none; }
  .entry-assembly { transition: none; }
  .entry-thumb { transition-property: background-color; }
  .side-picker :deep(.sliding-indicator.is-sliding) { transition-property: opacity, background-color, border-color; }
}
.underside-label { color: var(--text-secondary); font-size: var(--body-sm-font-size); line-height: 1.6; }
.side-button:focus-visible { outline: 2px solid var(--interaction-border); outline-offset: -2px; }
.tray-readout { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding-inline: 2px; color: var(--text-secondary); font-size: var(--body-sm-font-size); font-variant-numeric: tabular-nums; }
.tray-readout :deep(.inline-help) { flex: 1; }
.tray-readout :deep(.help-heading) { justify-content: space-between; }
</style>
