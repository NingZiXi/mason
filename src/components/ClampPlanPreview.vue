<script setup lang="ts">
import { computed, useId } from 'vue';
import { useI18n } from 'vue-i18n';
import { useConfigStore } from '../stores/config';
import { clampPlan, pcbPlanPath } from '../lib/clamp-plan';

const store = useConfigStore();
const { t } = useI18n();
const id = useId();
const maskId = `${id}-grip`;
const plan = computed(() => clampPlan(store.config));
// Cached independently: moving the lip slider never rebuilds imported vertices.
const pcbPath = computed(() => pcbPlanPath(store.config.pcbOutlinePoints,
  store.config.pcbOutlineHoles, store.config.pcbSizeX, store.config.pcbSizeY));
const grip = computed(() => Math.abs(plan.value.gripX - plan.value.gripY) < .01
  ? plan.value.gripX.toFixed(1)
  : `X ${plan.value.gripX.toFixed(1)} / Y ${plan.value.gripY.toFixed(1)}`);
</script>

<template>
  <figure class="clamp-plan">
    <figcaption class="plan-heading">
      <span>{{ t('clampPlan.title') }}</span>
      <span class="plan-view-label">{{ t('clampPlan.topView') }}</span>
    </figcaption>
    <svg class="plan-canvas" viewBox="0 0 320 176" role="img" :aria-labelledby="`${id}-title ${id}-description`">
      <title :id="`${id}-title`">{{ t('clampPlan.title') }}</title>
      <desc :id="`${id}-description`">{{ t('clampPlan.description', { x: plan.gripX.toFixed(1), y: plan.gripY.toFixed(1) }) }}</desc>
      <defs>
        <mask :id="maskId" maskUnits="userSpaceOnUse" x="-160" y="-88" width="320" height="176" style="mask-type: luminance">
          <rect v-bind="plan.sheet" fill="white" />
          <rect v-bind="plan.window" fill="black" />
        </mask>
      </defs>
      <g transform="translate(160 88)">
        <path d="M-146 0H146M0-80V80" class="plan-axis" />
        <rect v-bind="plan.sheet" class="plan-sheet" />
        <rect v-bind="plan.sheet" class="plan-grip" :mask="`url(#${maskId})`" />
        <rect v-bind="plan.window" class="plan-window" />
        <rect v-bind="plan.platter" class="plan-platter" />
        <path :d="pcbPath" :transform="`scale(${plan.scale} ${-plan.scale})`" class="plan-pcb" fill-rule="evenodd" />
      </g>
    </svg>
    <div class="plan-legend" aria-hidden="true">
      <span><i class="legend-grip" />{{ t('clampPlan.grip') }}</span>
      <span><i class="legend-platter" />{{ t('clampPlan.platter') }}</span>
      <span><i class="legend-sheet" />{{ t('clampPlan.sheet') }}</span>
      <span><i class="legend-pcb" />PCB</span>
    </div>
    <div class="plan-grip-value">
      <span>{{ t('clampPlan.gripWidth') }}</span><strong>{{ grip }}<small class="plan-unit">mm</small></strong>
    </div>
  </figure>
</template>

<style scoped>
.clamp-plan { --grip-fill: rgba(210, 155, 62, .38); --grip-ink: #996d2d; --pcb-fill: #d2dfe9; --pcb-ink: #718fa7; margin: 0 0 12px; padding: 10px 12px 0; border: 1px solid var(--surface-line); border-radius: var(--radius-control); corner-shape: var(--corner-shape); background: var(--surface-raised); }
.plan-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; font-size: var(--body-sm-font-size); line-height: var(--body-sm-line-height); font-weight: var(--font-weight-medium); color: var(--text-secondary); }
.plan-view-label { flex-shrink: 0; color: var(--text-tertiary); font-weight: var(--font-weight-default); }
.plan-canvas { display: block; width: 100%; max-height: 176px; overflow: hidden; }
.plan-canvas rect, .plan-canvas path { vector-effect: non-scaling-stroke; }
.plan-axis { stroke: var(--surface-line); stroke-dasharray: 2 5; fill: none; }
.plan-sheet { fill: var(--surface-well); stroke: var(--text-tertiary); stroke-width: 1; }
.plan-grip { fill: var(--grip-fill); stroke: none; }
.plan-window { fill: none; stroke: var(--grip-ink); stroke-opacity: .42; stroke-width: .8; }
.plan-platter { fill: none; stroke: var(--text-brand); stroke-width: 1.1; stroke-dasharray: 4 3; }
.plan-pcb { fill: var(--pcb-fill); stroke: var(--pcb-ink); stroke-width: 1; }
.plan-legend { display: flex; justify-content: center; flex-wrap: wrap; gap: 4px 12px; padding: 2px 0 10px; color: var(--text-secondary); font-size: var(--body-sm-font-size); line-height: var(--body-sm-line-height); }
.plan-legend span { display: inline-flex; align-items: center; gap: 5px; }
.plan-legend i { width: 10px; height: 7px; border-radius: 2px; box-sizing: border-box; }
.legend-grip { background: var(--grip-fill); border: 1px solid color-mix(in srgb, var(--grip-ink) 35%, transparent); }
.legend-platter { border: 1px dashed var(--text-brand); }
.legend-sheet { border: 1px solid var(--text-tertiary); }
.legend-pcb { background: var(--pcb-fill); border: 1px solid var(--pcb-ink); }
.plan-grip-value { display: flex; align-items: baseline; justify-content: space-between; flex-wrap: wrap; gap: 4px 10px; padding: 9px 0; border-top: 1px solid var(--surface-line); font-size: var(--body-sm-font-size); line-height: var(--body-sm-line-height); color: var(--text-secondary); }
.plan-grip-value strong { display: inline-flex; align-items: baseline; gap: 4px; color: var(--grip-ink); font-family: var(--font-family-metric); font-size: var(--heading-xs-font-size); font-weight: var(--font-weight-strong); font-variant-numeric: tabular-nums; white-space: nowrap; }
.plan-unit { color: var(--text-tertiary); font-size: var(--body-sm-font-size); font-weight: var(--font-weight-default); }
:global(html.dark) .clamp-plan { --grip-fill: rgba(215, 169, 87, .28); --grip-ink: #d7b77d; --pcb-fill: #344b60; --pcb-ink: #8fa9bf; }
</style>
