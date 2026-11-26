<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useConfigStore } from "../stores/config";
import PanelScopePicker from "./PanelScopePicker.vue";
import MotionCollapse from "./MotionCollapse.vue";
import { focusParameterControl } from "../lib/focus-parameter-control";
import { APERTURE_SCALE_MIN, APERTURE_SCALE_ORIGINAL, defaultApertureScaleFromShrink } from "../lib/pad-overrides";
import InlineHelp from "./InlineHelp.vue";
import SlidingIndicator from "./SlidingIndicator.vue";
import PryNotchPicker from "./PryNotchPicker.vue";

const store = useConfigStore();
const { locale, t } = useI18n();
const c = computed(() => store.config);

// 厚度预设
const THICKNESS_PRESETS = [
  { label: "stencil.presetResin", value: 0.15 },
  { label: "stencil.presetStandard", value: 0.2 },
  { label: "stencil.presetFdm", value: 0.3 },
];
const manualThickness = ref<number>();
const selectedThickness = computed(() => {
  const value = c.value.stencilThickness;
  if (manualThickness.value === value) return undefined;
  return THICKNESS_PRESETS.find(preset => Math.abs(value - preset.value) < 0.001)?.value;
});

// Undo and applied configurations can replace the thickness independently of this control.
watch(() => c.value.stencilThickness, value => {
  if (value !== manualThickness.value) manualThickness.value = undefined;
});

function selectThickness(value: number) {
  manualThickness.value = undefined;
  c.value.stencilThickness = value;
}

type NumberKey =
  | 'pcbThickness' | 'stencilThickness' | 'padShrink' | 'stencilFrameWidth' | 'stencilCornerRadius'
  | 'pocketClearance' | 'stencilStaggerGap' | 'stencilStaggerOffset' | 'stencilTestPointMaxDia'
  | 'stencilTestPointIsolation' | 'stencilGridSize' | 'stencilGridBar';
function updateNumber(key: NumberKey, value: number | null | undefined) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value === c.value[key]) return;
  if (key === 'stencilThickness') manualThickness.value = value;
  c.value[key] = value;
}

const thicknessHint = computed(() => {
  const thickness = c.value.stencilThickness;
  if (thickness < 0.25) return t('stencil.thinHint');
  if (thickness <= 0.35) return t('stencil.fdmHint');
  return t('stencil.thickHint');
});

const totalThickness = computed(() =>
  (c.value.pcbThickness + c.value.stencilThickness).toFixed(2)
);

const defaultApertureScale = computed(() => defaultApertureScaleFromShrink(c.value.padShrink));
const apertureScaleFormat = computed(() => new Intl.NumberFormat(locale.value, { style: 'percent', maximumFractionDigits: 2 }));
const percentText = (value: number) => apertureScaleFormat.value.format(value / APERTURE_SCALE_ORIGINAL);
function updateDefaultApertureScale(value: number | number[] | null | undefined) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return;
  const scale = Math.min(APERTURE_SCALE_ORIGINAL, Math.max(APERTURE_SCALE_MIN, value));
  updateNumber('padShrink', APERTURE_SCALE_ORIGINAL - scale);
}

const apertureOverrideCount = computed(() => {
  let count = 0;
  for (const pads of [c.value.stencilPadsTop, c.value.stencilPadsBottom]) {
    for (const pad of pads) if (pad.apertureScale !== undefined) count++;
  }
  return count;
});

const topPadCount = computed(() => c.value.stencilPadsTop.length);
const bottomPadCount = computed(() => c.value.stencilPadsBottom.length);
const isDoubleSided = computed(() => topPadCount.value > 0 && bottomPadCount.value > 0);

// 高级参数默认折叠:常规流程(Gerber → 导出)用默认值即可
const showAdvanced = defineModel<boolean>('advancedOpen', { default: false });
</script>

<template>
  <div class="stencil-form">
    <!-- 钢网参数 -->
    <div class="section-label">{{ t('stencil.params') }}</div>

    <!-- 拼版口径(仅导入拼版 Gerber 时出现) -->
    <PanelScopePicker />

    <!-- PCB 板厚(基础参数,影响卡槽深度与总厚度) -->
    <div class="field">
      <label for="stencil-pcb-thickness" class="field-label">{{ t('config.pcbThickness') }}</label>
      <el-input-number id="stencil-pcb-thickness"
        :model-value="c.pcbThickness"
        :value-on-clear="c.pcbThickness"
        @update:model-value="updateNumber('pcbThickness', $event)"
        :min="0.4"
        :max="3.2"
        :step="0.2"
        :precision="2"
        size="default"
        style="width: 100%"
      />
    </div>

    <!-- 外框形状:跟随板形 / 矩形 -->
    <div class="field">
      <label class="field-label">{{ t('stencil.frameShape') }}</label>
      <div class="shape-row">
        <SlidingIndicator />
        <button
          class="shape-btn"
          :class="{ active: c.stencilFrameShape === 'outline' }"
          :aria-pressed="c.stencilFrameShape === 'outline'"
          @click="c.stencilFrameShape = 'outline'"
        >
          <svg viewBox="0 0 28 20" width="28" height="20">
            <path d="M6 2h10l6 5v11l-8 2-6-4-4 2V7z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" transform="scale(0.85) translate(2,1)" />
          </svg>
          <span>{{ t('stencil.frameOutline') }}</span>
        </button>
        <button
          class="shape-btn"
          :class="{ active: c.stencilFrameShape === 'rect' }"
          :aria-pressed="c.stencilFrameShape === 'rect'"
          @click="c.stencilFrameShape = 'rect'"
        >
          <svg viewBox="0 0 28 20" width="28" height="20">
            <rect x="4" y="3" width="20" height="14" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.5" />
          </svg>
          <span>{{ t('stencil.frameRect') }}</span>
        </button>
      </div>
    </div>

    <!-- 钢网层厚度 -->
    <div class="field">
      <label for="stencil-thickness" class="field-label">{{ t('stencil.thickness') }}</label>
      <div class="preset-row" role="group" :aria-label="t('stencil.thickness')">
        <button
          v-for="p in THICKNESS_PRESETS"
          :key="p.label"
          class="preset-btn"
          :class="{ active: selectedThickness === p.value }"
          :aria-pressed="selectedThickness === p.value"
          @click="selectThickness(p.value)"
        >
          <span class="preset-name">{{ t(p.label) }}</span>
          <span class="preset-val"><span>{{ p.value }}</span><small>mm</small></span>
        </button>
      </div>
      <el-input-number
        id="stencil-thickness"
        :model-value="c.stencilThickness"
        :value-on-clear="c.stencilThickness"
        :min="0.05"
        :max="1.0"
        :step="0.05"
        :precision="2"
        size="small"
        style="width: 100%; margin-top: 8px"
        @update:model-value="updateNumber('stencilThickness', $event)"
      />
      <div class="thickness-summary">
        <div class="thickness-readout">
          <span class="thickness-metric">
            <span>{{ t('stencil.totalThickness') }}</span>
            <strong class="summary-number">{{ totalThickness }} <small>mm</small></strong>
          </span>
          <span class="thickness-breakdown">({{ c.pcbThickness }} + {{ c.stencilThickness }})</span>
        </div>
        <p class="summary-note">{{ thicknessHint }}</p>
      </div>
    </div>

    <div class="field">
      <InlineHelp id="stencil-default-scale-help" topic="padShrink" :label="t('stencil.apertureDefaultScale')">
        <label for="stencil-default-scale" class="field-label" @click.prevent="focusParameterControl">{{ t('stencil.apertureDefaultScale') }}</label>
        <template #trailing>
          <span class="aperture-default-value" aria-hidden="true">{{ percentText(defaultApertureScale) }}</span>
        </template>
        <template #control>
          <div class="aperture-default-controls">
            <el-slider id="stencil-default-scale" :aria-label="t('stencil.apertureDefaultScale')"
              :model-value="defaultApertureScale"
              :min="APERTURE_SCALE_MIN" :max="APERTURE_SCALE_ORIGINAL" :step="1"
              :format-tooltip="percentText" :format-value-text="percentText"
              @update:model-value="updateDefaultApertureScale"
            />
            <div class="aperture-default-endpoints" aria-hidden="true">
              <span>{{ percentText(APERTURE_SCALE_MIN) }}</span>
              <span>{{ t('inspection.scaleOriginal', { value: percentText(APERTURE_SCALE_ORIGINAL) }) }}</span>
            </div>
          </div>
          <p v-if="apertureOverrideCount" class="summary-note aperture-default-note">
            {{ t('stencil.apertureOverrideCount', { n: apertureOverrideCount }, apertureOverrideCount) }}
          </p>
        </template>
      </InlineHelp>
      <div v-if="topPadCount || bottomPadCount" class="pad-summary">
        <dl class="pad-counts">
          <div v-if="topPadCount" class="pad-count">
            <dt>{{ t('stencil.padCountTop') }}</dt>
            <dd class="summary-number">{{ topPadCount }}</dd>
          </div>
          <div v-if="bottomPadCount" class="pad-count">
            <dt>{{ t('stencil.padCountBottom') }}</dt>
            <dd class="summary-number">{{ bottomPadCount }}</dd>
          </div>
        </dl>
        <p v-if="isDoubleSided" class="summary-note flip-note">
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
            <path d="M2.5 5h10.75m-2.5-2.5L13.25 5l-2.5 2.5M13.5 11H2.75m2.5-2.5L2.75 11l2.5 2.5" />
          </svg>
          <span>{{ t('stencil.doubleSidedHint') }}</span>
        </p>
      </div>
    </div>

    <!-- 取放口(平底梯形:两侧斜坡过渡,底部贴齐 PCB 边缘) -->
    <InlineHelp id="stencil-pry-notch-help" topic="pryNotch" class="notch-help" :label="t('config.pryNotch')">
      <span class="notch-heading">{{ t('config.pryNotch') }}</span>
      <template #control>
        <PryNotchPicker variant="stencil" />
      </template>
    </InlineHelp>

    <!-- 高级参数(默认折叠) -->
    <button class="advanced-toggle" :aria-expanded="showAdvanced" @click="showAdvanced = !showAdvanced">
      <span>{{ t('stencil.advanced') }}</span>
      <svg class="chevron" :class="{ 'is-open': showAdvanced }" viewBox="0 0 16 16" width="14" height="14">
        <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </button>

    <MotionCollapse :open="showAdvanced"><div class="advanced-body">
      <div class="field-row">
        <div class="field">
          <label for="stencil-frame-width" class="field-label">{{ t('stencil.frameWidth') }}</label>
          <el-input-number id="stencil-frame-width"
            :model-value="c.stencilFrameWidth" :value-on-clear="c.stencilFrameWidth"
            @update:model-value="updateNumber('stencilFrameWidth', $event)"
            :min="3"
            :max="30"
            :step="0.5"
            :precision="1"
            size="small"
            style="width: 100%"
          />
        </div>
        <div class="field">
          <label for="stencil-corner-radius" class="field-label">{{ t('stencil.cornerRadius') }}</label>
          <el-input-number id="stencil-corner-radius"
            :model-value="c.stencilCornerRadius" :value-on-clear="c.stencilCornerRadius"
            @update:model-value="updateNumber('stencilCornerRadius', $event)"
            :min="0"
            :max="20"
            :step="0.5"
            :precision="1"
            size="small"
            style="width: 100%"
          />
        </div>
      </div>
      <div class="field">
        <InlineHelp id="stencil-pocketClearanceHint" topic="pocket" :label="t('stencil.pocketClearance')" :text="t('stencil.pocketClearanceHint')">
          <label for="stencil-pocket-clearance" class="field-label">{{ t('stencil.pocketClearance') }}</label>
          <template #control>
            <el-input-number id="stencil-pocket-clearance"
              :model-value="c.pocketClearance" :value-on-clear="c.pocketClearance"
              @update:model-value="updateNumber('pocketClearance', $event)"
              :min="0"
              :max="2"
              :step="0.05"
              :precision="2"
              size="small"
              style="width: 100%"
            />
          </template>
        </InlineHelp>
      </div>

      <!-- 焊盘后处理 -->
      <div class="section-label">{{ t('stencil.postProcess') }}</div>

      <!-- 密脚错排 -->
      <div class="field">
        <InlineHelp id="stencil-staggerHint" topic="stagger" :label="t('stencil.stagger')"><el-checkbox v-model="c.stencilStagger">{{ t('stencil.stagger') }}</el-checkbox></InlineHelp>
        <MotionCollapse :open="c.stencilStagger">
          <div class="field-row">
            <div class="field">
              <label for="stencil-stagger-gap" class="field-label">{{ t('stencil.staggerGap') }}</label>
              <el-input-number id="stencil-stagger-gap"
                :model-value="c.stencilStaggerGap" :value-on-clear="c.stencilStaggerGap"
                @update:model-value="updateNumber('stencilStaggerGap', $event)"
                :min="0.3"
                :max="2"
                :step="0.05"
                :precision="2"
                size="small"
                style="width: 100%"
              />
            </div>
            <div class="field">
              <label for="stencil-stagger-offset" class="field-label">{{ t('stencil.staggerOffset') }}</label>
              <el-input-number id="stencil-stagger-offset"
                :model-value="c.stencilStaggerOffset" :value-on-clear="c.stencilStaggerOffset"
                @update:model-value="updateNumber('stencilStaggerOffset', $event)"
                :min="0.05"
                :max="0.5"
                :step="0.05"
                :precision="2"
                size="small"
                style="width: 100%"
              />
            </div>
          </div>
        </MotionCollapse>
      </div>

      <!-- 测试点过滤 -->
      <div class="field">
        <InlineHelp id="stencil-test-point-filter-help" topic="testPointFilter"
          :label="t('stencil.filterTestPoints')" :text="t('stencil.filterTestPointsHint')">
          <el-checkbox v-model="c.stencilFilterTestPoints">{{ t('stencil.filterTestPoints') }}</el-checkbox>
          <template #control>
            <MotionCollapse :open="c.stencilFilterTestPoints">
              <div class="field-row">
                <div class="field">
                  <label for="stencil-test-point-max-dia" class="field-label">{{ t('stencil.testPointMaxDia') }}</label>
                  <el-input-number id="stencil-test-point-max-dia"
                    :model-value="c.stencilTestPointMaxDia" :value-on-clear="c.stencilTestPointMaxDia"
                    @update:model-value="updateNumber('stencilTestPointMaxDia', $event)"
                    :min="0.5"
                    :max="3"
                    :step="0.1"
                    :precision="1"
                    size="small"
                    style="width: 100%"
                  />
                </div>
                <div class="field">
                  <label for="stencil-test-point-isolation" class="field-label">{{ t('stencil.testPointIsolation') }}</label>
                  <el-input-number id="stencil-test-point-isolation"
                    :model-value="c.stencilTestPointIsolation" :value-on-clear="c.stencilTestPointIsolation"
                    @update:model-value="updateNumber('stencilTestPointIsolation', $event)"
                    :min="0.5"
                    :max="5"
                    :step="0.1"
                    :precision="1"
                    size="small"
                    style="width: 100%"
                  />
                </div>
              </div>
              <div class="auto-hint">
                <svg viewBox="0 0 16 16" width="14" height="14" class="hint-icon">
                  <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.2" />
                  <path d="M5 8.2l2 2 4-4.4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
                <span>{{ t('stencil.filterTestPointsReview') }}</span>
              </div>
            </MotionCollapse>
          </template>
        </InlineHelp>
      </div>

      <!-- 大孔开网格 -->
      <div class="field">
        <InlineHelp id="stencil-gridHint" topic="grid" :label="t('stencil.grid')"><el-checkbox v-model="c.stencilGrid">{{ t('stencil.grid') }}</el-checkbox></InlineHelp>
        <MotionCollapse :open="c.stencilGrid">
          <div class="field-row">
            <div class="field">
              <label for="stencil-grid-size" class="field-label">{{ t('stencil.gridSize') }}</label>
              <el-input-number id="stencil-grid-size"
                :model-value="c.stencilGridSize" :value-on-clear="c.stencilGridSize"
                @update:model-value="updateNumber('stencilGridSize', $event)"
                :min="1"
                :max="10"
                :step="0.5"
                :precision="1"
                size="small"
                style="width: 100%"
              />
            </div>
            <div class="field">
              <label for="stencil-grid-bar" class="field-label">{{ t('stencil.gridBar') }}</label>
              <el-input-number id="stencil-grid-bar"
                :model-value="c.stencilGridBar" :value-on-clear="c.stencilGridBar"
                @update:model-value="updateNumber('stencilGridBar', $event)"
                :min="0.3"
                :max="2"
                :step="0.1"
                :precision="1"
                size="small"
                style="width: 100%"
              />
            </div>
          </div>
        </MotionCollapse>
      </div>
    </div></MotionCollapse>
  </div>
</template>

<style scoped>
.stencil-form { padding: 16px; }

.section-label, .notch-heading {
  font-size: var(--heading-2xs-font-size);
  line-height: var(--body-md-line-height);
  font-weight: var(--font-weight-strong);
  color: var(--text-secondary);
  letter-spacing: 0;
}
.section-label { margin: 20px 0 12px; }
.section-label:first-child { margin-top: 0; }
.notch-help { margin-top: 20px; }
.notch-help :deep(.help-heading) { margin-bottom: 6px; }
.notch-help :deep(.help-heading)::after { content: ''; flex: 1; height: 1px; background: var(--surface-line); }

.field-row { display: flex; gap: 12px; }
.field-row > .field { flex: 1; }

.field { margin-bottom: 12px; }

.field-label {
  display: block;
  font-size: 12px;
  font-weight: var(--font-weight-medium);
  color: var(--text-secondary);
  line-height: 18px;
  margin-bottom: 4px;
}

.auto-hint {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin: 8px 0 0 0;
  padding: 8px 12px;
  background: var(--bg-brand-popup);
  border-radius: var(--radius-control); corner-shape: var(--corner-shape);
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 18px;
  overflow-wrap: anywhere;
}
.auto-hint > span { min-width: 0; }
.auto-hint .hint-icon {
  color: var(--interaction-ink);
  flex-shrink: 0;
  margin-top: 2px;
}

.thickness-summary,
.pad-summary {
  margin-top: 8px;
  color: var(--text-secondary);
  font-size: var(--body-md-font-size);
  line-height: var(--body-md-line-height);
  overflow-wrap: anywhere;
}
.thickness-readout,
.thickness-metric,
.pad-counts,
.pad-count {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 2px 6px;
}
.thickness-readout {
  justify-content: space-between;
  column-gap: 12px;
}
.summary-number,
.thickness-breakdown {
  font-family: var(--font-family-metric);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.summary-number {
  color: var(--text-default);
  font-weight: var(--font-weight-strong);
}
.summary-number small,
.thickness-breakdown,
.summary-note {
  font-size: var(--body-sm-font-size);
  font-weight: var(--font-weight-default);
  line-height: var(--body-sm-line-height);
}
.summary-number small { color: var(--text-secondary); }
.thickness-breakdown { color: var(--text-tertiary); }
.summary-note { margin: 3px 0 0; }
.pad-summary { padding-top: 7px; border-top: 1px solid var(--surface-line); }
.pad-counts { margin: 0; column-gap: 18px; }
.pad-count dd { margin: 0; }
.flip-note { display: flex; align-items: flex-start; gap: 6px; }
.flip-note svg { flex: none; margin-top: 1px; color: var(--text-brand); }

/* 钢网层厚度预设按钮 */
.preset-row { display: flex; gap: 6px; flex-wrap: wrap; }
.preset-btn {
  flex: 1;
  min-width: 60px;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 8px 4px;
  border: 1px solid var(--border-neutral-l2);
  border-radius: var(--radius-control); corner-shape: var(--corner-shape);
  background: var(--bg-secondary, transparent);
  cursor: pointer;
  transition: var(--control-transition);
}
.preset-btn:hover {
  border-color: var(--brand-500);
}
.preset-btn.active {
  border-color: var(--brand-500);
  background: var(--brand-50, #E8F1EC);
}
.preset-name { font-size: 12px; font-weight: 600; color: var(--text-default); }
.preset-val { display: inline-flex; align-items: baseline; gap: 3px; font-size: var(--body-sm-font-size); line-height: var(--body-sm-line-height); color: var(--text-secondary); margin-top: 2px; font-variant-numeric: tabular-nums; }
.preset-val small { font-size: inherit; color: var(--text-tertiary); }

.aperture-default-controls { padding-inline: 9px; }
.aperture-default-value {
  min-width: 5ch;
  padding: 2px 7px;
  border-radius: var(--radius-inner);
  background: var(--control-selection-surface);
  color: var(--text-default);
  font-size: var(--body-sm-font-size);
  font-weight: var(--font-weight-strong);
  line-height: var(--body-md-line-height);
  font-variant-numeric: tabular-nums;
  text-align: center;
}
.aperture-default-endpoints {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 1px 6px;
  color: var(--text-secondary);
  font-size: var(--body-sm-font-size);
  line-height: var(--body-sm-line-height);
  font-variant-numeric: tabular-nums;
}
.aperture-default-note { margin-block-start: 6px; color: var(--text-secondary); overflow-wrap: anywhere; }

/* 外框形状切换(跟随板形 / 矩形) */
.shape-row { --selection-background: var(--control-selection-surface); --selection-border: var(--bg-brand); --selection-shadow: none; --selection-radius: var(--radius-control); position: relative; isolation: isolate; display: flex; gap: 6px; }
.shape-row .shape-btn {
  position: relative;
  z-index: 1;
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 9px 4px;
  border: 1px solid transparent;
  border-radius: var(--radius-control); corner-shape: var(--corner-shape);
  background: transparent;
  color: var(--text-secondary);
  font-size: 12px;
  font-weight: var(--font-weight-medium);
  cursor: pointer;
  transition: var(--control-transition);
}
.shape-btn:not(.active) { border-color: var(--border-neutral-l2); }
.shape-btn:hover:not(.active) { border-color: var(--brand-500); background: var(--surface-well); }
.shape-row .shape-btn.active {
  background: transparent;
  border-color: transparent;
  color: var(--text-brand);
}

/* 高级参数折叠(与 ConfigForm 同款) */
.advanced-toggle {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 7px 12px;
  border: 1px dashed var(--border-neutral-l2);
  border-radius: var(--radius-control); corner-shape: var(--corner-shape);
  background: transparent;
  color: var(--text-tertiary);
  font-size: 12px;
  font-weight: var(--font-weight-medium);
  cursor: pointer;
  transition: var(--control-transition);
  margin: 4px 0 8px 0;
}
.advanced-toggle:hover {
  color: var(--text-secondary);
  border-color: var(--border-neutral-l3);
}
.advanced-toggle .chevron {
  transition: transform var(--motion-panel) var(--ease-out);
}
.advanced-toggle .chevron.is-open {
  transform: rotate(180deg);
}

.advanced-body {
  padding-top: 4px;
}
</style>
