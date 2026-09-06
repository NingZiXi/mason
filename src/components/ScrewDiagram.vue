<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useConfigStore, windowHalf, windowHalfXY, SCREW_SPECS } from "../stores/config";

const { t } = useI18n();
const store = useConfigStore();
const c = computed(() => store.config);

const padding = 16;

const diagramSize = computed(() => {
  const W = store.config.jigSize;
  const H = store.config.jigSize;
  const scale = 320 / Math.max(W, H);
  return {
    width: W * scale + 2 * padding,
    height: H * scale + 2 * padding,
    scale,
  };
});

function toSvg(x: number, y: number): { cx: number; cy: number } {
  const { scale } = diagramSize.value;
  const half = store.config.jigSize / 2;
  return { cx: padding + (half + x) * scale, cy: padding + (half + y) * scale };
}

const screws = computed(() =>
  store.screwPositions.map(([x, y]) => ({ ...toSvg(x, y), r: 4 }))
);

const cornerScrews = computed(() => {
  const win = windowHalf(c.value);
  const s = Math.max(c.value.jigSize / 2 - 7, win + 3.5);
  return [[s, s], [s, -s], [-s, s], [-s, -s]].map(([x, y]) => ({
    ...toSvg(x, y),
    r: 6.5,
  }));
});

const rect = computed(() => {
  const { scale } = diagramSize.value;
  return {
    x: padding,
    y: padding,
    w: store.config.jigSize * scale,
    h: store.config.jigSize * scale,
  };
});

const windowRect = computed(() => {
  const { scale } = diagramSize.value;
  const { hx, hy } = windowHalfXY(c.value);
  const J = store.config.jigSize;
  return {
    x: padding + ((J - hx * 2) * scale) / 2,
    y: padding + ((J - hy * 2) * scale) / 2,
    w: hx * 2 * scale,
    h: hy * 2 * scale,
  };
});

const screwCount = computed(() => screws.value.length + cornerScrews.value.length);
const windowSize = computed(() => {
  const { hx, hy } = windowHalfXY(c.value);
  return `${(hx * 2).toFixed(1)}×${(hy * 2).toFixed(1)}`;
});

const SCREW_SPEC_OPTIONS = computed(() =>
  (Object.keys(SCREW_SPECS) as Array<keyof typeof SCREW_SPECS>).map((k) => ({
    value: k,
    label: t("config.screwSpecOption", {
      spec: k,
      d: SCREW_SPECS[k].holeD,
      n: SCREW_SPECS[k].nutAcross,
    }),
  }))
);

// 高级参数默认折叠:常规流程用默认值即可
const showAdvanced = ref(false);
</script>

<template>
  <div class="screw-diagram">
    <!-- 俯视图 -->
    <div class="diagram-wrapper">
      <svg
        :width="diagramSize.width"
        :height="diagramSize.height"
        :viewBox="`0 0 ${diagramSize.width} ${diagramSize.height}`"
        class="diagram-svg"
      >
        <rect
          :x="rect.x"
          :y="rect.y"
          :width="rect.w"
          :height="rect.h"
          rx="10"
          fill="none"
          stroke="var(--border-neutral-l3)"
          stroke-width="2"
        />
        <rect
          :x="windowRect.x"
          :y="windowRect.y"
          :width="windowRect.w"
          :height="windowRect.h"
          rx="8"
          fill="rgba(62,125,98,0.12)"
          stroke="var(--bg-brand)"
          stroke-width="1.5"
          stroke-dasharray="4,3"
        />
        <g>
          <circle
            v-for="(s, i) in screws"
            :key="i"
            :cx="s.cx"
            :cy="s.cy"
            :r="s.r"
            fill="var(--bg-brand)"
            stroke="var(--bg-base-default)"
            stroke-width="1"
          />
        </g>
        <g>
          <circle
            v-for="(s, i) in cornerScrews"
            :key="'c' + i"
            :cx="s.cx"
            :cy="s.cy"
            :r="s.r"
            fill="var(--brand-500)"
            stroke="var(--bg-base-default)"
            stroke-width="1.5"
          />
        </g>
      </svg>
    </div>

    <div class="auto-hint">
      <svg viewBox="0 0 16 16" width="14" height="14" class="hint-icon ok">
        <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.2" />
        <path d="M5 8.2l2 2 4-4.4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
      <span>
        <strong>{{ t('screwDiagram.count', { n: screwCount, s: c.screwSpec }) }}</strong>
        {{ t('screwDiagram.jigSize', { x: c.jigSize, y: c.jigSize }) }}
        · {{ t('screwDiagram.windowSize', { s: windowSize }) }}
      </span>
    </div>

    <!-- 周圈螺丝(基础) -->
    <div class="section-label">{{ t('config.screwPerimeter') }}</div>

    <div class="field">
      <label class="field-label">
        {{ t('config.spacing') }}
        <span class="field-value">{{ c.screwSpacing === 0 ? t('config.off') : `${c.screwSpacing}mm` }}</span>
      </label>
      <div class="slider-row">
        <el-slider
          v-model="c.screwSpacing"
          :min="0"
          :max="60"
          :step="5"
          :format-tooltip="(v: number) => v === 0 ? t('config.off') : `${v}mm`"
        />
      </div>
    </div>

    <div class="field">
      <label class="field-label">{{ t('config.screwSpec') }}</label>
      <el-select v-model="c.screwSpec" style="width: 100%">
        <el-option
          v-for="opt in SCREW_SPEC_OPTIONS"
          :key="opt.value"
          :label="opt.label"
          :value="opt.value"
        />
      </el-select>
      <div class="auto-hint">
        <svg viewBox="0 0 16 16" width="14" height="14" class="hint-icon">
          <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.2" />
          <path d="M5 8.2l2 2 4-4.4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        <span>{{ t('config.screwSpecHint') }}</span>
      </div>
    </div>

    <!-- 高级参数(默认折叠) -->
    <button class="advanced-toggle" @click="showAdvanced = !showAdvanced">
      <span>{{ t('config.advanced') }}</span>
      <svg class="chevron" :class="{ 'is-open': showAdvanced }" viewBox="0 0 16 16" width="14" height="14">
        <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </button>

    <div v-show="showAdvanced" class="advanced-body">
      <div class="field-row">
        <div class="field">
          <label class="field-label">{{ t('config.periScrewD') }}</label>
          <el-input-number
            v-model="c.periScrewD"
            :min="2" :max="6" :step="0.5" :precision="1"
            size="small" style="width: 100%"
          />
        </div>
        <div class="field">
          <label class="field-label">{{ t('config.cornerScrewD') }}</label>
          <el-input-number
            v-model="c.cornerScrewD"
            :min="3" :max="8" :step="0.5" :precision="1"
            size="small" style="width: 100%"
          />
        </div>
      </div>

      <div class="field checkbox-field">
        <el-checkbox v-model="c.useHexNut" size="default">
          <span class="checkbox-label">{{ t('config.useHexNut') }}</span>
        </el-checkbox>
      </div>
      <div v-if="c.useHexNut" class="field-row">
        <div class="field">
          <label class="field-label">{{ t('config.nutAcrossFlats') }}</label>
          <el-input-number
            v-model="c.nutAcrossFlats"
            :min="3" :max="15" :step="0.1" :precision="2"
            size="small" style="width: 100%"
          />
        </div>
        <div class="field">
          <label class="field-label">{{ t('config.nutHeight') }}</label>
          <el-input-number
            v-model="c.nutHeight"
            :min="1.5" :max="6" :step="0.1" :precision="2"
            size="small" style="width: 100%"
          />
        </div>
      </div>
      <div v-if="c.useHexNut" class="auto-hint">
        <svg viewBox="0 0 16 16" width="14" height="14" class="hint-icon">
          <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.2" />
          <path d="M5 8.2l2 2 4-4.4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        <span>{{ t('config.useHexNutHint') }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.screw-diagram {
  padding: 16px;
  display: flex;
  flex-direction: column;
}

.diagram-wrapper {
  display: flex;
  justify-content: center;
  padding: 0 0 12px 0;
}

.diagram-svg {
  max-width: 100%;
  height: auto;
  background: var(--brand-grey-50);
  border-radius: var(--radius-6);
  padding: 8px;
}

.section-label {
  font-size: 11px;
  font-weight: var(--font-weight-strong);
  color: var(--text-tertiary);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  margin: 20px 0 12px 0;
}

.section-label:first-child {
  margin-top: 0;
}

.field-row {
  display: flex;
  gap: 12px;
}

.field-row > .field {
  flex: 1;
}

.field {
  margin-bottom: 12px;
}

.field-label {
  display: block;
  font-size: 12px;
  font-weight: var(--font-weight-medium);
  color: var(--text-secondary);
  line-height: 18px;
  margin-bottom: 4px;
}

.field-value {
  float: right;
  color: var(--text-tertiary);
  font-weight: var(--font-weight-regular);
}

.checkbox-field {
  margin-bottom: 8px;
}

.checkbox-field :deep(.el-checkbox__label) {
  white-space: normal;
  line-height: 1.4;
}

.checkbox-label {
  font-size: 13px;
  font-weight: var(--font-weight-medium);
  color: var(--text-primary);
}

.auto-hint {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin: 8px 0 0 0;
  padding: 8px 12px;
  background: var(--bg-brand-popup);
  border-radius: var(--radius-6);
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 18px;
}

.auto-hint .hint-icon {
  color: var(--bg-brand);
  flex-shrink: 0;
  margin-top: 2px;
}

.auto-hint .hint-icon.ok {
  color: var(--brand-500);
}

.auto-hint strong {
  color: var(--text-brand);
  font-weight: var(--font-weight-strong);
  font-family: var(--font-family-metric);
  margin-right: 6px;
}

.slider-row {
  padding: 0 4px;
}

.advanced-toggle {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 7px 12px;
  border: 1px dashed var(--border-neutral-l2);
  border-radius: var(--radius-6);
  background: transparent;
  color: var(--text-tertiary);
  font-size: 12px;
  font-weight: var(--font-weight-medium);
  cursor: pointer;
  transition: color 0.12s ease, border-color 0.12s ease;
  margin: 4px 0 8px 0;
}

.advanced-toggle:hover {
  color: var(--text-secondary);
  border-color: var(--border-neutral-l3);
}

.advanced-toggle .chevron {
  transition: transform 0.22s cubic-bezier(0.4, 0, 0.2, 1);
}

.advanced-toggle .chevron.is-open {
  transform: rotate(180deg);
}

.advanced-body {
  padding-top: 4px;
}
</style>