<script setup lang="ts">
import { computed, useId } from 'vue';
import { useI18n } from 'vue-i18n';
import { reliefDepthRange, reliefRegionDepth, type ComponentReliefRegion, type JigPrintSide } from '../lib/component-relief';
import { fitReliefView, reliefEditorBounds } from '../lib/component-relief-editor';

const props = defineProps<{
  regions: ComponentReliefRegion[];
  outline: Array<[number, number]>;
  holes: Array<Array<[number, number]>>;
  printSide: JigPrintSide;
  width: number;
  height: number;
  defaultDepth: number;
}>();
const emit = defineEmits<{ edit: [] }>();
const { t, n } = useI18n();
const id = useId();
const clipId = `${id}-relief-preview`;
const bounds = computed(() => reliefEditorBounds(props.outline, props.width, props.height));
const viewBox = computed(() => {
  const view = fitReliefView(bounds.value, props.printSide);
  return `${view.x} ${view.y} ${view.width} ${view.height}`;
});
const path = (ring: readonly (readonly [number, number])[]) => ring.length >= 3
  ? `M${ring.map(([x, y]) => `${x},${y}`).join('L')}Z` : '';
const boardPath = computed(() => {
  const b = bounds.value;
  const ring = props.outline.length >= 3 ? props.outline
    : [[b.minX, b.minY], [b.maxX, b.minY], [b.maxX, b.maxY], [b.minX, b.maxY]] as Array<[number, number]>;
  return path(ring) + props.holes.map(path).join('');
});
const range = computed(() => reliefDepthRange(props.regions, props.defaultDepth));
const throughCount = computed(() => props.regions.filter(region => region.through === true).length);
const depthLabel = computed(() => !range.value ? '' : range.value.min === range.value.max
  ? `${n(range.value.min)} mm` : t('relief.depthRange', { min: n(range.value.min), max: n(range.value.max) }));
const opacity = (region: ComponentReliefRegion) => {
  if (region.through) return .72;
  const depth = reliefRegionDepth(region, props.defaultDepth);
  const max = range.value?.max ?? depth;
  return .24 + .24 * depth / max;
};
</script>

<template>
  <button type="button" class="relief-preview" :aria-label="t('relief.previewHint')" @click="emit('edit')">
    <span class="preview-heading"><span>{{ t('relief.previewTitle') }}</span><span class="region-count">{{ t('relief.regionCount', { n: regions.length }) }}</span></span>
    <svg class="preview-canvas" :viewBox="viewBox" preserveAspectRatio="xMidYMid meet" role="img" :aria-labelledby="`${id}-title`">
      <title :id="`${id}-title`">{{ t('relief.previewTitle') }}</title>
      <defs><clipPath :id="clipId"><path :d="boardPath" clip-rule="evenodd" /></clipPath></defs>
      <g :transform="`scale(1, ${printSide === 'top' ? -1 : 1})`">
        <path :d="boardPath" class="preview-board" />
        <g :clip-path="`url(#${clipId})`">
          <g v-for="region in regions" :key="region.id" class="preview-region" :class="{ 'is-through': region.through }" :fill-opacity="opacity(region)">
            <ellipse v-if="region.shape === 'circle'" :cx="region.x" :cy="region.y" :rx="region.width / 2" :ry="region.height / 2" />
            <path v-else-if="region.shape === 'polygon'" :d="path(region.points ?? [])" />
            <rect v-else :x="region.x - region.width / 2" :y="region.y - region.height / 2" :width="region.width" :height="region.height" />
          </g>
        </g>
      </g>
    </svg>
    <span v-if="regions.length" class="preview-legend" aria-hidden="true">
      <span><i class="support-swatch" />{{ t('relief.supportLegend') }}</span>
      <span v-if="range"><i class="relief-swatch" />{{ t('relief.blind') }} <span class="depth-range">{{ depthLabel }}</span></span>
      <span v-if="throughCount"><i class="through-swatch" />{{ t('relief.throughCount', { count: throughCount }) }}</span>
    </span>
    <span v-else class="preview-empty">{{ t('relief.previewEmpty') }}</span>
    <span class="preview-footer"><span>{{ t('relief.previewHint') }}</span><svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="m6 4 4 4-4 4" /></svg></span>
  </button>
</template>

<style scoped>
.relief-preview { --button-press-scale: .995; display: flex; flex-direction: column; width: 100%; margin: 2px 0 0; padding: 12px 14px 0; overflow: hidden; border: 1px solid var(--surface-line); border-radius: var(--radius-popover); corner-shape: var(--corner-shape); background: var(--surface-raised); color: var(--text-secondary); text-align: left; font: inherit; cursor: pointer; transition: var(--control-transition); }
.relief-preview:hover { border-color: color-mix(in srgb, var(--interaction-border) 42%, var(--surface-line)); background: var(--surface-raised); box-shadow: var(--shadow-card-hover); }
.relief-preview:focus-visible { outline: 2px solid var(--interaction-border); outline-offset: 2px; }
.preview-heading, .preview-footer { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: var(--body-sm-font-size); line-height: 1.5; }
.preview-heading > :first-child { font-weight: 500; }
.region-count { padding: 2px 7px; border-radius: var(--radius-full); background: var(--surface-well); color: var(--text-tertiary); font-size: 10px; font-variant-numeric: tabular-nums; }
.preview-canvas { display: block; width: 100%; height: 132px; margin: 4px 0; pointer-events: none; }
.preview-canvas path, .preview-canvas rect, .preview-canvas ellipse { vector-effect: non-scaling-stroke; }
.preview-board { fill: var(--surface-well); fill-rule: evenodd; stroke: var(--inspection-board-stroke, var(--text-tertiary)); stroke-width: .9; stroke-opacity: .65; }
.preview-region { fill: var(--bg-brand); stroke: var(--interaction-ink); stroke-width: .8; stroke-linejoin: round; transition: fill-opacity var(--motion-fast) var(--ease-out); }
.preview-region.is-through { stroke-width: 1.15; stroke-dasharray: 3 2; }
.preview-legend { display: flex; align-items: center; justify-content: center; flex-wrap: wrap; gap: 4px 10px; padding: 0 0 10px; font-size: 10px; line-height: 1.5; color: var(--text-secondary); }
.preview-legend > span { display: inline-flex; align-items: center; gap: 4px; }
.preview-legend i { width: 8px; height: 6px; border: 1px solid var(--surface-line); border-radius: 2px; }
.support-swatch { background: var(--surface-well); }
.preview-legend .relief-swatch { border-color: var(--interaction-border); background: color-mix(in srgb, var(--bg-brand) 42%, transparent); }
.preview-legend .through-swatch { border: 1px dashed var(--interaction-ink); background: color-mix(in srgb, var(--bg-brand) 72%, transparent); }
.preview-legend .depth-range { color: var(--text-tertiary); font-family: var(--font-family-metric); font-variant-numeric: tabular-nums; }
.preview-empty { padding-bottom: 10px; text-align: center; color: var(--text-tertiary); font-size: 10px; }
.preview-footer { padding: 10px 0; border-top: 1px solid var(--surface-line); color: var(--interaction-ink); }
.preview-footer svg { fill: none; stroke: currentColor; stroke-width: 1.4; stroke-linecap: round; stroke-linejoin: round; transition: translate var(--motion-panel) var(--ease-out); }
@media (hover: hover) and (pointer: fine) {
  .relief-preview:hover .preview-footer svg { translate: 3px 0; }
}
</style>
