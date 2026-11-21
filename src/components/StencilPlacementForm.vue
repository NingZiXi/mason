<script setup lang="ts">
import { computed, defineAsyncComponent, ref, useId } from 'vue';
import { useI18n } from 'vue-i18n';
import { useConfigStore } from '../stores/config';
import type { JigPrintSide } from '../lib/component-relief';
import { activeBoardPlacement, MAX_PLACEMENT_OFFSET, placeBoardRing, type BoardPlacement, type QuarterTurn } from '../lib/stencil-placement';
import MotionCollapse from './MotionCollapse.vue';
import SlidingIndicator from './SlidingIndicator.vue';

const StencilPhotoDialog = defineAsyncComponent(() => import('./StencilPhotoDialog.vue'));
const store = useConfigStore();
const { t } = useI18n();
const id = useId();
const c = computed(() => store.config);
const dialogOpen = ref(false);
const dialogLoaded = ref(false);
const QUARTERS: QuarterTurn[] = [0, 1, 2, 3];

const placement = computed(() => activeBoardPlacement(c.value));
const entryState = computed(() => !c.value.stencilPlacementEnabled ? 'off' : placement.value ? 'ready' : 'pending');
const entryLabel = { off: 'placement.entryOff', ready: 'placement.entryOn', pending: 'placement.entryPending' } as const;

function toggle() {
  c.value.stencilPlacementEnabled = !c.value.stencilPlacementEnabled;
}
function chooseSide(side: JigPrintSide) {
  c.value.jigPrintSide = side;
}
function edit(patch: Partial<BoardPlacement>) {
  const current = placement.value ?? { x: 0, y: 0, quarter: 0 as QuarterTurn };
  store.setStencilPlacement(c.value.jigPrintSide, { ...current, ...patch });
}
function updateOffset(axis: 'x' | 'y', value: number | null | undefined) {
  if (typeof value === 'number' && Number.isFinite(value)) edit({ [axis]: value });
}
function openDialog() {
  dialogLoaded.value = true;
  dialogOpen.value = true;
}

/** Plan view: the sheet, the jig centre and the board where the tray will hold it. */
const plan = computed(() => {
  const sx = c.value.stencilSizeX, sy = c.value.stencilSizeY;
  const scale = Math.min(220 / sx, 120 / sy);
  const p = placement.value ?? { x: 0, y: 0, quarter: 0 as QuarterTurn };
  const w = c.value.pcbSizeX / 2, h = c.value.pcbSizeY / 2;
  const outline = c.value.pcbOutlinePoints.length >= 3 ? c.value.pcbOutlinePoints
    : [[-w, -h], [w, -h], [w, h], [-w, h]] as Array<[number, number]>;
  const ring = placeBoardRing(outline, c.value.jigPrintSide, p);
  return {
    sheet: { x: -sx / 2 * scale, y: -sy / 2 * scale, width: sx * scale, height: sy * scale },
    board: `M${ring.map(([x, y]) => `${(x * scale).toFixed(2)},${(-y * scale).toFixed(2)}`).join('L')}Z`,
    marker: { x: p.x * scale, y: -p.y * scale },
  };
});
</script>

<template>
  <section v-if="c.appMode === 'jig'" class="parameter-section placement-section" :aria-label="t('placement.title')">
    <div class="placement-heading">
      <span class="section-label">{{ t('placement.title') }}</span>
      <span class="entry-state" :class="`state-${entryState}`" aria-live="polite">{{ t(entryLabel[entryState]) }}</span>
    </div>
    <button type="button" class="placement-entry" role="switch" :aria-checked="c.stencilPlacementEnabled"
      :aria-describedby="`${id}-hint`" :aria-controls="`${id}-settings`" @click="toggle">
      <span class="entry-copy">
        <span class="entry-title">{{ t('placement.enabled') }}</span>
        <span :id="`${id}-hint`" class="entry-hint">{{ t('placement.entryHint') }}</span>
      </span>
      <span class="entry-switch" aria-hidden="true"><span class="entry-thumb" /></span>
    </button>
    <MotionCollapse :id="`${id}-settings`" :open="c.stencilPlacementEnabled">
      <div class="placement-settings">
        <span :id="`${id}-side`" class="field-label">{{ t('placement.printSide') }}</span>
        <div class="side-picker" role="group" :aria-labelledby="`${id}-side`">
          <SlidingIndicator />
          <button v-for="side in (['top', 'bottom'] as const)" :key="side" type="button" class="side-button"
            :class="{ active: c.jigPrintSide === side }" :aria-pressed="c.jigPrintSide === side" @click="chooseSide(side)">
            {{ t(`relief.${side}`) }}
          </button>
        </div>

        <svg class="placement-plan" viewBox="-130 -72 260 144" role="img" :aria-label="t('placement.planLabel')">
          <rect v-bind="plan.sheet" class="plan-sheet" rx="2" />
          <path d="M-8 0H8M0-8V8" class="plan-centre" />
          <path :d="plan.board" class="plan-board" :class="{ pending: !placement }" />
          <circle v-if="placement" :cx="plan.marker.x" :cy="plan.marker.y" r="2.2" class="plan-marker" />
        </svg>

        <div class="field-row">
          <div class="field">
            <label :for="`${id}-x`" class="field-label">{{ t('placement.offsetX') }}</label>
            <el-input-number :id="`${id}-x`" :model-value="placement?.x ?? 0" :value-on-clear="placement?.x ?? 0"
              :min="-MAX_PLACEMENT_OFFSET" :max="MAX_PLACEMENT_OFFSET" :step="0.1" :precision="2" size="default" style="width: 100%"
              @update:model-value="updateOffset('x', $event)" />
          </div>
          <div class="field">
            <label :for="`${id}-y`" class="field-label">{{ t('placement.offsetY') }}</label>
            <el-input-number :id="`${id}-y`" :model-value="placement?.y ?? 0" :value-on-clear="placement?.y ?? 0"
              :min="-MAX_PLACEMENT_OFFSET" :max="MAX_PLACEMENT_OFFSET" :step="0.1" :precision="2" size="default" style="width: 100%"
              @update:model-value="updateOffset('y', $event)" />
          </div>
        </div>
        <span :id="`${id}-rotation`" class="field-label">{{ t('placement.rotation') }}</span>
        <div class="rotation-picker" role="group" :aria-labelledby="`${id}-rotation`">
          <SlidingIndicator />
          <button v-for="quarter in QUARTERS" :key="quarter" type="button" class="side-button"
            :class="{ active: (placement?.quarter ?? 0) === quarter }" :aria-pressed="(placement?.quarter ?? 0) === quarter"
            @click="edit({ quarter })">{{ quarter * 90 }}°</button>
        </div>

        <p v-if="placement?.stencilFlipped" class="placement-note">{{ t('placement.flipNote') }}</p>
        <p v-else-if="!placement" class="placement-note">{{ t('placement.pendingNote') }}</p>

        <button type="button" class="photo-button" @click="openDialog">
          <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
            <path d="M3 6.5h3l1.5-2h5L14 6.5h3v9H3z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" />
            <circle cx="10" cy="11" r="2.8" fill="none" stroke="currentColor" stroke-width="1.3" />
          </svg>
          {{ t('placement.fromPhoto') }}
        </button>
      </div>
    </MotionCollapse>
    <StencilPhotoDialog v-if="dialogLoaded" v-model="dialogOpen" />
  </section>
</template>

<style scoped>
.placement-heading { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
.placement-heading .section-label { flex: 1; }
.entry-state { flex-shrink: 0; padding: 2px 8px; border-radius: var(--radius-full); background: var(--surface-well); color: var(--text-secondary); font-size: 11px; }
.entry-state.state-ready { color: var(--text-brand); }
.entry-state.state-pending { color: var(--text-warning, #b7791f); }
.placement-entry { display: flex; align-items: center; gap: 12px; width: 100%; padding: 10px 12px; border: 1px solid var(--surface-line); border-radius: var(--radius-control); corner-shape: var(--corner-shape); background: var(--surface-raised); color: inherit; font: inherit; text-align: left; cursor: pointer; }
.placement-entry:focus-visible { outline: 2px solid var(--interaction-ink); outline-offset: 2px; }
.entry-copy { display: flex; flex: 1; flex-direction: column; gap: 2px; min-width: 0; }
.entry-title { font-size: var(--body-sm-font-size); font-weight: 600; }
.entry-hint { color: var(--text-secondary); font-size: 11px; line-height: 1.45; }
.entry-switch { position: relative; flex-shrink: 0; width: 30px; height: 18px; border-radius: 9px; background: var(--surface-line); transition: background var(--motion-fast) var(--ease-out); }
.entry-thumb { position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%; background: var(--surface-raised); box-shadow: 0 1px 2px rgba(0, 0, 0, .2); transition: transform var(--motion-fast) var(--ease-out); }
.placement-entry[aria-checked='true'] .entry-switch { background: var(--text-brand); }
.placement-entry[aria-checked='true'] .entry-thumb { transform: translateX(12px); }
.placement-settings { display: flex; flex-direction: column; gap: 8px; padding-top: 12px; }
.placement-settings > .field-label { margin-bottom: 0; }
.side-picker, .rotation-picker { position: relative; display: grid; grid-template-columns: repeat(2, 1fr); gap: 2px; padding: 2px; border-radius: var(--radius-control); background: var(--surface-well); }
.rotation-picker { grid-template-columns: repeat(4, 1fr); }
.side-button { position: relative; z-index: 1; padding: 5px 6px; border: 0; border-radius: calc(var(--radius-control) - 2px); background: transparent; color: var(--text-secondary); font: inherit; font-size: var(--body-sm-font-size); cursor: pointer; }
.side-button.active { color: var(--text-default); font-weight: 600; }
.placement-plan { display: block; width: 100%; max-height: 144px; }
.plan-sheet { fill: var(--surface-well); stroke: var(--text-tertiary); stroke-width: 1; }
.plan-centre { stroke: var(--text-tertiary); stroke-width: .8; stroke-dasharray: 2 2; fill: none; }
.plan-board { fill: var(--pcb-fill, rgba(62, 125, 98, .25)); stroke: var(--pcb-ink, #3e7d62); stroke-width: 1; }
.plan-board.pending { opacity: .45; stroke-dasharray: 3 2; }
.plan-marker { fill: var(--text-brand); }
.placement-note { margin: 0; color: var(--text-secondary); font-size: 11px; line-height: 1.5; }
.photo-button { display: inline-flex; align-items: center; justify-content: center; gap: 6px; padding: 7px 12px; border: 1px solid var(--surface-line); border-radius: var(--radius-control); background: var(--surface-raised); color: var(--text-default); font: inherit; font-size: var(--body-sm-font-size); cursor: pointer; }
.photo-button:hover { border-color: var(--interaction-ink); color: var(--interaction-ink); }
</style>
