<script setup lang="ts">
import { computed, defineAsyncComponent, ref, watch } from 'vue';
import { ElSwitch } from 'element-plus';
import { invoke } from '@tauri-apps/api/core';
import { useI18n } from 'vue-i18n';
import { DEFAULT, useConfigStore } from '../stores/config';
import { effectiveInsertHeight, type ComponentReliefMergeResult, type ComponentReliefRegion } from '../lib/component-relief';
import { buildScadParams } from '../lib/model-params';
import InlineHelp from './InlineHelp.vue';
import MotionCollapse from './MotionCollapse.vue';
import SlidingIndicator from './SlidingIndicator.vue';
import ComponentReliefPreview from './ComponentReliefPreview.vue';

const ComponentReliefEditor = defineAsyncComponent(() => import('./ComponentReliefEditor.vue'));
const store = useConfigStore();
const { t } = useI18n();
const c = computed(() => store.config);
const ejectHoleEnabled = computed({
  get: () => c.value.ejectSlotWidth > 0,
  set: (enabled: boolean) => { c.value.ejectSlotWidth = enabled ? DEFAULT.ejectSlotWidth : 0; },
});
const editorOpen = ref(false);
const editorLoaded = ref(false);
const regions = computed(() => c.value.componentReliefRegions[c.value.jigPrintSide]);
const undersidePads = computed(() => c.value.jigPrintSide === 'top' ? c.value.stencilPadsBottom : c.value.stencilPadsTop);
const trayHeight = computed(() => effectiveInsertHeight(c.value));
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
});
</script>

<template>
  <section v-if="c.appMode === 'jig' && c.pcbOutlinePoints.length >= 3" class="relief-section" :aria-label="t('relief.title')">
    <div class="section-heading">
      <InlineHelp id="component-relief-help" :label="t('relief.title')" :text="`${t('relief.enableHint')} ${t('relief.regionAllowanceHint')}`">
        <span class="section-title">{{ t('relief.title') }}</span>
      </InlineHelp>
      <el-switch v-model="c.componentReliefEnabled" :aria-label="t('relief.enabled')" />
    </div>
    <p class="enable-label">{{ t('relief.enabled') }}</p>
    <MotionCollapse :open="c.componentReliefEnabled">
      <div class="relief-settings">
        <div class="side-heading">
          <span class="field-label">{{ t('relief.printSide') }}</span>
          <span class="underside-label">{{ t(c.jigPrintSide === 'top' ? 'relief.undersideBottom' : 'relief.undersideTop') }}</span>
        </div>
        <div class="side-picker" role="group" :aria-label="t('relief.printSide')">
          <SlidingIndicator />
          <button v-for="side in (['top', 'bottom'] as const)" :key="side" type="button"
            class="side-button" :class="{ active: c.jigPrintSide === side }" :aria-pressed="c.jigPrintSide === side"
            @click="c.jigPrintSide = side">
            <svg class="side-icon" viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
              <path class="side-icon-top" d="m3 7 7-4 7 4-7 4z" />
              <path class="side-icon-bottom" d="m3 12 7 4 7-4" />
            </svg>
            <span>{{ t(`relief.${side}`) }}</span>
          </button>
        </div>
        <ComponentReliefPreview :regions="regions" :outline="c.pcbOutlinePoints" :holes="c.pcbOutlineHoles"
          :print-side="c.jigPrintSide" :width="c.pcbSizeX" :height="c.pcbSizeY"
          :default-depth="c.componentReliefDepth" @edit="openEditor" />
        <div v-if="regions.length" class="tray-readout">
          <InlineHelp v-if="trayHeight > c.insertHeight" id="component-relief-height-help"
            :label="t('relief.trayHeight', { height: trayHeight.toFixed(1) })" :text="t('relief.heightHint')">
            <span>{{ t('relief.trayHeight', { height: trayHeight.toFixed(1) }) }}</span>
          </InlineHelp>
          <span v-else>{{ t('relief.trayHeight', { height: trayHeight.toFixed(1) }) }}</span>
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
.section-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.section-heading :deep(.inline-help) { min-width: 0; }
.section-heading :deep(.el-switch) { flex-shrink: 0; }
.section-title { color: var(--text-default); font-size: var(--body-md-font-size); font-weight: 600; }
.enable-label { margin: 1px 0 0; color: var(--text-secondary); font-size: var(--body-sm-font-size); line-height: 1.5; }
.relief-settings { display: flex; flex-direction: column; gap: 10px; padding-top: 15px; }
.side-heading { display: flex; align-items: baseline; justify-content: space-between; flex-wrap: wrap; gap: 4px 10px; }
.field-label { color: var(--text-secondary); font-size: var(--body-sm-font-size); }
.side-picker { --selection-radius: var(--radius-inner); --selection-shadow: none; position: relative; isolation: isolate; display: flex; gap: 3px; padding: 4px; border: 1px solid var(--surface-line); border-radius: var(--radius-control); corner-shape: var(--corner-shape); background: var(--surface-well); }
.side-button { position: relative; z-index: 1; display: flex; align-items: center; justify-content: center; gap: 7px; flex: 1; min-width: 0; min-height: 32px; padding: 6px 9px; border: 0; border-radius: var(--radius-inner); background: transparent; color: var(--text-secondary); font: inherit; font-size: var(--body-sm-font-size); cursor: pointer; transition: var(--control-transition); }
.side-button.active { color: var(--interaction-ink); font-weight: 600; }
.side-button:hover:not(.active) { color: var(--text-default); background: var(--bg-overlay-l1); }
.side-icon { flex-shrink: 0; fill: none; stroke: currentColor; stroke-width: 1.4; stroke-linecap: round; stroke-linejoin: round; }
.side-icon path { transform-origin: center; transition: transform var(--motion-panel) var(--ease-out), opacity var(--motion-fast) var(--ease-out); }
.side-button:not(.active) .side-icon { opacity: .6; }
.side-button.active .side-icon-top { transform: translateY(-1px); }
.side-button.active .side-icon-bottom { transform: translateY(1px); }
.underside-label { color: var(--text-tertiary); font-size: 10px; line-height: 1.6; }
.side-button:focus-visible { outline: 2px solid var(--interaction-border); outline-offset: 2px; }
.tray-readout { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding-inline: 2px; color: var(--text-secondary); font-size: var(--body-sm-font-size); font-variant-numeric: tabular-nums; }
.tray-readout :deep(.inline-help) { flex: 1; }
.tray-readout :deep(.help-heading) { justify-content: space-between; }
</style>
