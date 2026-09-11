<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useConfigStore } from "../stores/config";

const store = useConfigStore();
const { t } = useI18n();
const c = computed(() => store.config);

// 厚度预设
const THICKNESS_PRESETS = [
  { label: "树脂", value: 0.15, hint: "0.15mm · 精度高,锡膏量适中" },
  { label: "标准", value: 0.2, hint: "0.20mm · 金属钢网常规厚度" },
  { label: "FDM", value: 0.3, hint: "0.30mm · FDM 适用,建议配焊盘缩小" },
];

const thicknessHint = computed(() => {
  const t = c.value.stencilThickness;
  if (t < 0.25) return "建议树脂打印机;锡膏量适中";
  if (t <= 0.35) return "FDM 适用;建议配合焊盘缩小 10~20%";
  return "钢网偏厚;锡膏量偏多,建议增大焊盘缩小比例";
});

const totalThickness = computed(() =>
  (c.value.pcbThickness + c.value.stencilThickness).toFixed(2)
);

const topPadCount = computed(() => c.value.stencilPadsTop.length);
const bottomPadCount = computed(() => c.value.stencilPadsBottom.length);
const isDoubleSided = computed(() => topPadCount.value > 0 && bottomPadCount.value > 0);

// 取放缺口:四向点亮开关(与夹具共用配置字段;钢网侧为平底梯形形状)
type NotchSide = 'up' | 'down' | 'left' | 'right';
const NOTCH_SIDES: NotchSide[] = ['up', 'down', 'left', 'right'];
function toggleNotchSide(s: NotchSide) {
  const cur = c.value.pryNotchSides;
  c.value.pryNotchSides = cur.includes(s)
    ? cur.filter((x) => x !== s)
    : [...cur, s];
}

// 高级参数默认折叠:常规流程(Gerber → 导出)用默认值即可
const showAdvanced = ref(false);
</script>

<template>
  <div class="stencil-form">
    <!-- 钢网参数 -->
    <div class="section-label">{{ t('stencil.params') }}</div>

    <!-- PCB 板厚(基础参数,影响卡槽深度与总厚度) -->
    <div class="field">
      <label class="field-label">{{ t('config.pcbThickness') }}</label>
      <el-input-number
        v-model="c.pcbThickness"
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
        <button
          class="shape-btn"
          :class="{ active: c.stencilFrameShape === 'outline' }"
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
      <label class="field-label">{{ t('stencil.thickness') }}</label>
      <div class="preset-row">
        <button
          v-for="p in THICKNESS_PRESETS"
          :key="p.label"
          class="preset-btn"
          :class="{ active: Math.abs(c.stencilThickness - p.value) < 0.001 }"
          @click="store.config.stencilThickness = p.value"
        >
          <span class="preset-name">{{ p.label }}</span>
          <span class="preset-val">{{ p.value }}mm</span>
        </button>
        <button
          class="preset-btn"
          :class="{ active: !THICKNESS_PRESETS.some((p) => Math.abs(c.stencilThickness - p.value) < 0.001) }"
          @click="store.config.stencilThickness = 0.4"
        >
          <span class="preset-name">自定义</span>
        </button>
      </div>
      <el-input-number
        v-model="c.stencilThickness"
        :min="0.05"
        :max="1.0"
        :step="0.05"
        :precision="2"
        size="small"
        style="width: 100%; margin-top: 8px"
      />
      <div class="auto-hint">
        <svg viewBox="0 0 16 16" width="14" height="14" class="hint-icon">
          <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.2" />
          <path d="M5 8.2l2 2 4-4.4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        <span>{{ thicknessHint }}</span>
      </div>
      <div class="auto-hint">
        <svg viewBox="0 0 16 16" width="14" height="14" class="hint-icon">
          <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.2" />
          <path d="M5 8.2l2 2 4-4.4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        <span>总厚度 = {{ c.pcbThickness }} + {{ c.stencilThickness }} = <strong>{{ totalThickness }}mm</strong></span>
      </div>
    </div>

    <!-- 焊盘缩小 -->
    <div class="field">
      <label class="field-label">{{ t('stencil.padShrink') }}</label>
      <div class="slider-row">
        <el-slider
          v-model="c.padShrink"
          :min="0"
          :max="50"
          :step="1"
          show-input
          :format-tooltip="(v: number) => v + '%'"
        />
      </div>
    </div>

    <!-- 钢网信息卡片(合并提示) -->
    <div class="field">
      <div class="info-card">
        <div class="info-row">
          <svg viewBox="0 0 16 16" width="14" height="14" class="hint-icon">
            <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.2" />
            <path d="M5 8.2l2 2 4-4.4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
          <span>{{ t('stencil.padShrinkHint') }}</span>
        </div>
        <div class="info-row">
          <svg viewBox="0 0 16 16" width="14" height="14" class="hint-icon ok">
            <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.2" />
            <path d="M5 8.2l2 2 4-4.4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
          <span>{{ t('stencil.padCountTop', { n: topPadCount }) }}</span>
        </div>
        <div v-if="bottomPadCount > 0" class="info-row">
          <svg viewBox="0 0 16 16" width="14" height="14" class="hint-icon ok">
            <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.2" />
            <path d="M5 8.2l2 2 4-4.4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
          <span>{{ t('stencil.padCountBottom', { n: bottomPadCount }) }}</span>
        </div>
        <div v-if="isDoubleSided" class="info-row">
          <svg viewBox="0 0 16 16" width="14" height="14" class="hint-icon">
            <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.2" />
            <path d="M8 5v6M5 8h6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
          </svg>
          <span>{{ t('stencil.doubleSidedHint') }}</span>
        </div>
      </div>
    </div>

    <!-- 取放口(平底梯形:两侧斜坡过渡,底部贴齐 PCB 边缘) -->
    <div class="section-label">{{ t('config.pryNotch') }}</div>
    <div class="field">
      <div class="notch-picker">
        <button
          v-for="s in NOTCH_SIDES"
          :key="s"
          class="notch-btn"
          :class="[`notch-${s}`, { active: c.pryNotchSides.includes(s) }]"
          :title="t(`config.pryNotch${s.charAt(0).toUpperCase() + s.slice(1)}`)"
          @click="toggleNotchSide(s)"
        >
          <svg viewBox="0 0 16 16" width="12" height="12">
            <path
              v-if="s === 'up'" d="M8 3l4 5H4z"
              :fill="c.pryNotchSides.includes(s) ? 'currentColor' : 'none'"
              stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"
            />
            <path
              v-else-if="s === 'down'" d="M8 13l4-5H4z"
              :fill="c.pryNotchSides.includes(s) ? 'currentColor' : 'none'"
              stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"
            />
            <path
              v-else-if="s === 'left'" d="M3 8l5-4v8z"
              :fill="c.pryNotchSides.includes(s) ? 'currentColor' : 'none'"
              stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"
            />
            <path
              v-else d="M13 8l-5-4v8z"
              :fill="c.pryNotchSides.includes(s) ? 'currentColor' : 'none'"
              stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"
            />
          </svg>
        </button>
        <div class="notch-center">
          <svg viewBox="0 0 16 16" width="16" height="16">
            <rect x="3.5" y="3.5" width="9" height="9" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.2" />
          </svg>
        </div>
      </div>
    </div>
    <div class="field">
      <label class="field-label">
        {{ t('config.pryNotchSize') }}
        <span class="field-value">{{ Math.round(c.pryNotchScale * 100) }}%</span>
      </label>
      <el-slider
        v-model="c.pryNotchScale"
        :min="0.5"
        :max="1.5"
        :step="0.05"
        :disabled="c.pryNotchSides.length === 0"
      />
    </div>

    <!-- 高级参数(默认折叠) -->
    <button class="advanced-toggle" @click="showAdvanced = !showAdvanced">
      <span>{{ t('stencil.advanced') }}</span>
      <svg class="chevron" :class="{ 'is-open': showAdvanced }" viewBox="0 0 16 16" width="14" height="14">
        <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </button>

    <div v-show="showAdvanced" class="advanced-body">
      <div class="field-row">
        <div class="field">
          <label class="field-label">{{ t('stencil.frameWidth') }}</label>
          <el-input-number
            v-model="c.stencilFrameWidth"
            :min="3"
            :max="30"
            :step="0.5"
            :precision="1"
            size="small"
            style="width: 100%"
          />
        </div>
        <div class="field">
          <label class="field-label">{{ t('stencil.cornerRadius') }}</label>
          <el-input-number
            v-model="c.stencilCornerRadius"
            :min="0"
            :max="20"
            :step="0.5"
            :precision="1"
            size="small"
            style="width: 100%"
          />
        </div>
        <div class="field">
          <label class="field-label">{{ t('stencil.pocketClearance') }}</label>
          <el-input-number
            v-model="c.pocketClearance"
            :min="0"
            :max="2"
            :step="0.05"
            :precision="2"
            size="small"
            style="width: 100%"
          />
        </div>
      </div>

      <!-- 焊盘后处理 -->
      <div class="section-label">{{ t('stencil.postProcess') }}</div>

      <!-- 密脚错排 -->
      <div class="field">
        <el-checkbox v-model="c.stencilStagger">{{ t('stencil.stagger') }}</el-checkbox>
        <template v-if="c.stencilStagger">
          <div class="field-row">
            <div class="field">
              <label class="field-label">{{ t('stencil.staggerGap') }}</label>
              <el-input-number
                v-model="c.stencilStaggerGap"
                :min="0.3"
                :max="2"
                :step="0.05"
                :precision="2"
                size="small"
                style="width: 100%"
              />
            </div>
            <div class="field">
              <label class="field-label">{{ t('stencil.staggerOffset') }}</label>
              <el-input-number
                v-model="c.stencilStaggerOffset"
                :min="0.05"
                :max="0.5"
                :step="0.05"
                :precision="2"
                size="small"
                style="width: 100%"
              />
            </div>
          </div>
        </template>
        <div class="auto-hint">
          <svg viewBox="0 0 16 16" width="14" height="14" class="hint-icon">
            <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.2" />
            <path d="M5 8.2l2 2 4-4.4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
          <span>{{ t('stencil.staggerHint') }}</span>
        </div>
      </div>

      <!-- 测试点过滤 -->
      <div class="field">
        <el-checkbox v-model="c.stencilFilterTestPoints">{{ t('stencil.filterTestPoints') }}</el-checkbox>
        <template v-if="c.stencilFilterTestPoints">
          <div class="field-row">
            <div class="field">
              <label class="field-label">{{ t('stencil.testPointMaxDia') }}</label>
              <el-input-number
                v-model="c.stencilTestPointMaxDia"
                :min="0.5"
                :max="3"
                :step="0.1"
                :precision="1"
                size="small"
                style="width: 100%"
              />
            </div>
            <div class="field">
              <label class="field-label">{{ t('stencil.testPointIsolation') }}</label>
              <el-input-number
                v-model="c.stencilTestPointIsolation"
                :min="0.5"
                :max="5"
                :step="0.1"
                :precision="1"
                size="small"
                style="width: 100%"
              />
            </div>
          </div>
        </template>
        <div class="auto-hint">
          <svg viewBox="0 0 16 16" width="14" height="14" class="hint-icon">
            <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.2" />
            <path d="M5 8.2l2 2 4-4.4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
          <span>{{ t('stencil.filterTestPointsHint') }}</span>
        </div>
      </div>

      <!-- 大孔开网格 -->
      <div class="field">
        <el-checkbox v-model="c.stencilGrid">{{ t('stencil.grid') }}</el-checkbox>
        <template v-if="c.stencilGrid">
          <div class="field-row">
            <div class="field">
              <label class="field-label">{{ t('stencil.gridSize') }}</label>
              <el-input-number
                v-model="c.stencilGridSize"
                :min="1"
                :max="10"
                :step="0.5"
                :precision="1"
                size="small"
                style="width: 100%"
              />
            </div>
            <div class="field">
              <label class="field-label">{{ t('stencil.gridBar') }}</label>
              <el-input-number
                v-model="c.stencilGridBar"
                :min="0.3"
                :max="2"
                :step="0.1"
                :precision="1"
                size="small"
                style="width: 100%"
              />
            </div>
          </div>
        </template>
        <div class="auto-hint">
          <svg viewBox="0 0 16 16" width="14" height="14" class="hint-icon">
            <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.2" />
            <path d="M5 8.2l2 2 4-4.4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
          <span>{{ t('stencil.gridHint') }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.stencil-form { padding: 16px; }

.section-label {
  font-size: 11px;
  font-weight: var(--font-weight-strong);
  color: var(--text-tertiary);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  margin: 20px 0 12px 0;
}
.section-label:first-child { margin-top: 0; }

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
  border-radius: var(--radius-6);
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 18px;
}
/* 合并信息卡片:多条提示共享一个背景框,行间细线分隔 */
.info-card {
  display: flex;
  flex-direction: column;
  margin: 8px 0 0 0;
  padding: 0 12px;
  background: var(--bg-brand-popup);
  border-radius: var(--radius-6);
}
.info-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px 0;
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 18px;
}
.info-row + .info-row {
  border-top: 1px solid var(--el-border-color-light, rgba(115, 115, 115, 0.12));
}
.auto-hint .hint-icon,
.info-row .hint-icon {
  color: var(--bg-brand);
  flex-shrink: 0;
  margin-top: 2px;
}
.auto-hint .hint-icon.ok,
.info-row .hint-icon.ok { color: var(--brand-500); }
.auto-hint strong {
  color: var(--text-brand);
  font-weight: var(--font-weight-strong);
  font-family: var(--font-family-metric);
}

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
  border-radius: var(--radius-6);
  background: var(--bg-secondary, transparent);
  cursor: pointer;
  transition: all 0.12s ease;
}
.preset-btn:hover {
  border-color: var(--brand-500);
}
.preset-btn.active {
  border-color: var(--brand-500);
  background: var(--brand-50, #E8F1EC);
}
.preset-name { font-size: 12px; font-weight: 600; color: var(--text-primary); }
.preset-val { font-size: 11px; color: var(--text-tertiary); margin-top: 2px; }

.slider-row { padding: 0 4px; }

/* 外框形状切换(跟随板形 / 矩形) */
.shape-row { display: flex; gap: 6px; }
.shape-btn {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 9px 4px;
  border: 1px solid var(--border-neutral-l2);
  border-radius: var(--radius-6);
  background: var(--bg-secondary, transparent);
  color: var(--text-secondary);
  font-size: 12px;
  font-weight: var(--font-weight-medium);
  cursor: pointer;
  transition: all 0.12s ease;
}
.shape-btn:hover { border-color: var(--brand-500); }
.shape-btn.active {
  border-color: #3E7D62;
  background: #E8F1EC;
  color: #3E7D62;
}

/* 取放口方向选择器(与 ConfigForm 同款视觉) */
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
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--border-neutral-l2);
  border-radius: var(--radius-6);
  background: var(--bg-secondary, transparent);
  color: var(--text-tertiary);
  cursor: pointer;
  transition: all 0.12s ease;
}
.notch-btn:hover {
  border-color: var(--border-neutral-l3);
  color: var(--text-secondary);
}
.notch-btn.active {
  border-color: #3E7D62;
  background: #E8F1EC;
  color: #3E7D62;
}
.notch-btn.notch-up { top: 0; left: 50%; transform: translateX(-50%); }
.notch-btn.notch-down { bottom: 0; left: 50%; transform: translateX(-50%); }
.notch-btn.notch-left { left: 0; top: 50%; transform: translateY(-50%); }
.notch-btn.notch-right { right: 0; top: 50%; transform: translateY(-50%); }
.notch-center {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  color: var(--text-tertiary);
  opacity: 0.6;
}

.field-value {
  float: right;
  color: var(--text-tertiary);
  font-weight: var(--font-weight-regular);
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
