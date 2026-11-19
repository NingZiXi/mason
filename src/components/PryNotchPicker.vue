<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useConfigStore } from '../stores/config';
import { focusParameterControl } from '../lib/focus-parameter-control';
import { vAppTooltip } from '../directives/app-tooltip';

const props = defineProps<{ variant: 'jig' | 'stencil' }>();
const { t } = useI18n();
const store = useConfigStore();
const config = computed(() => store.config);
const sliderId = computed(() => `${props.variant}-notch-size`);
const sides = [
  { id: 'up', label: 'config.pryNotchUp', angle: 0 },
  { id: 'down', label: 'config.pryNotchDown', angle: 180 },
  { id: 'left', label: 'config.pryNotchLeft', angle: -90 },
  { id: 'right', label: 'config.pryNotchRight', angle: 90 },
] as const;
type Side = (typeof sides)[number]['id'];

function toggleSide(side: Side) {
  const selected = config.value.pryNotchSides;
  config.value.pryNotchSides = selected.includes(side)
    ? selected.filter(value => value !== side)
    : [...selected, side];
}

const percentText = (value: number) => `${Math.round(value * 100)}%`;
const cutShape = computed(() => {
  const half = 4.5 * config.value.pryNotchScale;
  // This is a plan symbol. The two recesses flare toward opposite sides of the slot edge.
  const flare = props.variant === 'jig' ? 1.3 : -1.3;
  const outer = half + flare;
  const inner = half - flare;
  return `${22 - outer},5.5 ${22 + outer},5.5 ${22 + inner},11.5 ${22 - inner},11.5`;
});
</script>

<template>
  <div class="field notch-field">
    <div class="notch-picker" role="group" :aria-label="t('config.pryNotch')">
      <button v-for="side in sides" :key="side.id" type="button" class="notch-btn"
        :class="[`notch-${side.id}`, { active: config.pryNotchSides.includes(side.id) }]"
        v-app-tooltip="t(side.label)" :aria-label="t(side.label)"
        :aria-pressed="config.pryNotchSides.includes(side.id)" @click="toggleSide(side.id)">
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
          <path d="M8 3l4 5H4z" :transform="`rotate(${side.angle} 8 8)`"
            :fill="config.pryNotchSides.includes(side.id) ? 'currentColor' : 'none'"
            stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" />
        </svg>
      </button>
      <svg class="notch-plan" viewBox="0 0 44 44" width="44" height="44" aria-hidden="true" focusable="false">
        <rect class="notch-frame" x="1.5" y="1.5" width="41" height="41" rx="7" />
        <rect class="notch-board" x="11.5" y="11.5" width="21" height="21" rx="2.5" />
        <g v-for="side in sides" :key="side.id" :transform="`rotate(${side.angle} 22 22)`">
          <polygon class="notch-cut" :class="{ 'is-active': config.pryNotchSides.includes(side.id) }"
            :data-side="side.id" :points="cutShape" />
        </g>
      </svg>
    </div>
  </div>
  <div class="field notch-field">
    <label :for="sliderId" class="field-label notch-size-label" @click.prevent="focusParameterControl">
      {{ t('config.pryNotchSize') }}
      <span class="notch-size-value" aria-hidden="true">{{ percentText(config.pryNotchScale) }}</span>
    </label>
    <el-slider :id="sliderId" :aria-label="t('config.pryNotchSize')" v-model="config.pryNotchScale"
      :min="0.5" :max="1.5" :step="0.05" :disabled="config.pryNotchSides.length === 0"
      :format-tooltip="percentText" :format-value-text="percentText" />
  </div>
</template>

<style scoped>
.notch-field { margin-bottom: 12px; }
.notch-picker {
  position: relative;
  width: 116px;
  height: 116px;
  margin: 4px auto;
}
.notch-btn {
  position: absolute;
  width: 34px;
  height: 34px;
  display: grid;
  place-items: center;
  border: 1px solid var(--border-neutral-l2);
  border-radius: var(--radius-control); corner-shape: var(--corner-shape);
  background: var(--bg-secondary, transparent);
  color: var(--text-tertiary);
  cursor: pointer;
  transition: var(--control-transition);
}
.notch-btn:hover {
  border-color: var(--border-neutral-l3);
  color: var(--text-secondary);
}
.notch-btn.active {
  border-color: var(--interaction-border);
  background: var(--control-selection-surface);
  color: var(--text-brand);
}
.notch-up { top: 0; left: 50%; transform: translateX(-50%); }
.notch-down { bottom: 0; left: 50%; transform: translateX(-50%); }
.notch-left { left: 0; top: 50%; transform: translateY(-50%); }
.notch-right { right: 0; top: 50%; transform: translateY(-50%); }
.notch-plan {
  position: absolute;
  inset: 50% auto auto 50%;
  transform: translate(-50%, -50%);
  pointer-events: none;
}
.notch-frame { fill: var(--surface-well); stroke: var(--border-neutral-l3); }
.notch-board { fill: var(--surface-raised); stroke: var(--text-tertiary); }
.notch-cut {
  stroke: var(--interaction-ink);
  stroke-linejoin: round;
  fill: var(--control-selection-surface);
  opacity: 0;
  transform: scale(.86);
  transform-box: fill-box;
  transform-origin: center;
  transition: opacity var(--motion-fast) var(--ease-out), transform var(--motion-fast) var(--ease-out);
}
.notch-cut.is-active { opacity: 1; transform: scale(1); }
.notch-size-label {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: 2px 10px;
  color: var(--text-secondary);
  font-size: 12px;
  font-weight: var(--font-weight-medium);
  line-height: 18px;
  margin-bottom: 4px;
}
.notch-field:focus-within > .notch-size-label { color: var(--text-default); }
.notch-size-value {
  color: var(--text-tertiary);
  font-weight: var(--font-weight-default);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
</style>
