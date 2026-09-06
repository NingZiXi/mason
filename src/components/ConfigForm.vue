<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useConfigStore, windowHalf } from "../stores/config";

const store = useConfigStore();
const { t } = useI18n();
const c = computed(() => store.config);
const warnings = computed(() => store.warnings);
const windowSize = computed(() => (windowHalf(store.config) * 2).toFixed(1));

// 实际生效台阶宽 = max(手动值, 钢网所需最小台阶)
// (凸台必须装得下钢网并外留 2mm 支撑唇 —— 与 Python get_polys / windowHalfXY 同式)
const effectiveMargin = computed(() => {
  const c = store.config;
  const slotHX = c.pcbSizeX / 2 + c.pcbPocketClearance;
  const slotHY = c.pcbSizeY / 2 + c.pcbPocketClearance;
  const slotHalfMax = Math.max(slotHX, slotHY);
  return Math.max(c.platterMargin, c.stencilSize / 2 - slotHalfMax + 2.0);
});

// 台阶宽输入下限 = 钢网所需最小台阶(0.5 步进取整):
// 低于此值不生效(被扩张兜底),干脆不允许输入,避免"输入了却没反应"
const minMargin = computed(() => {
  const c = store.config;
  const slotHX = c.pcbSizeX / 2 + c.pcbPocketClearance;
  const slotHY = c.pcbSizeY / 2 + c.pcbPocketClearance;
  const floor = c.stencilSize / 2 - Math.max(slotHX, slotHY) + 2.0;
  return Math.max(1, Math.ceil(floor * 2) / 2);
});

// 台阶宽上限必须 ≥ 下限:大钢网(如 150mm)会把最小台阶顶到 50+,
// 若 max 固定 20 会造成 min>max,Element Plus 抛异常并打断 Vue 渲染管线,
// 之后整个表单的更新(含高级区开合)全部失效
const maxMargin = computed(() => Math.max(20, minMargin.value));

// 夹具边长输入下限:窗口 + 周圈孔带 + 外缘(20mm 步进)。
// 手动改小到装不下窗口时部件会被挖空(空 STL,模型不显示) —— 在输入框拦住
const minJigSize = computed(() => {
  const c = store.config;
  const win = windowHalf(c);
  return Math.max(60, Math.ceil((2 * (win + 24)) / 20) * 20);
});

// 已存储值低于动态下限时抬到下限(如加载旧工程/钢网变大后):
// 值域与输入框一致,不留"显示 A 实际 B"的裂缝
watch(minMargin, (m) => {
  if (store.config.platterMargin < m) store.config.platterMargin = m;
});
watch(minJigSize, (j) => {
  if (store.config.jigSize < j) store.config.jigSize = j;
});

// 取放缺口:四向点亮开关(可任意组合,全灭 = 关闭)
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

function resetAll() {
  store.reset();
}
</script>

<template>
  <div class="config-form">
    <!-- 参数校验:非阻塞警告 -->
    <div v-if="warnings.length > 0" class="warnings-card">
      <div class="warnings-head">
        <svg viewBox="0 0 16 16" width="14" height="14" class="warn-icon">
          <path d="M8 2L1 14h14L8 2zM8 6v4M8 12v.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        <span>{{ t('config.warnings.title') }}</span>
      </div>
      <ul class="warnings-list">
        <li v-for="(w, i) in warnings" :key="i">{{ t(w.key, w.params ?? {}) }}</li>
      </ul>
    </div>

    <!-- PCB(基本:拖入 Gerber 自动填,板厚需用户确认) -->
    <div class="section-label">{{ t('config.pcb') }}</div>
    <div class="field-row">
      <div class="field">
        <label class="field-label">{{ t('config.length') }}</label>
        <el-input-number
          v-model="c.pcbSizeX"
          :min="5"
          :max="300"
          :step="0.5"
          :precision="1"
          size="default"
          style="width: 100%"
        />
      </div>
      <div class="field">
        <label class="field-label">{{ t('config.width') }}</label>
        <el-input-number
          v-model="c.pcbSizeY"
          :min="5"
          :max="300"
          :step="0.5"
          :precision="1"
          size="default"
          style="width: 100%"
        />
      </div>
    </div>
    <div class="field">
      <label class="field-label">{{ t('config.thickness') }}</label>
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
    <!-- 导入提示:长宽已从板框自动识别,板厚是物理属性须人工确认 -->
    <div v-if="c.gerberFilename" class="auto-hint">
      <svg viewBox="0 0 16 16" width="14" height="14" class="hint-icon">
        <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.2" />
        <path d="M5 8.2l2 2 4-4.4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
      <span>{{ t('config.gerberApplied', { f: c.gerberFilename }) }}</span>
    </div>

    <!-- 钢网(基本:按板子自动推荐,可改成实际购买的钢网尺寸) -->
    <div class="section-label">{{ t('config.stencil') }}</div>
    <div class="field">
      <label class="field-label">{{ t('config.stencilSize') }}</label>
      <el-input-number
        v-model="c.stencilSize"
        :min="10"
        :max="290"
        :step="5"
        :precision="0"
        size="default"
        style="width: 100%"
      />
    </div>
    <div class="field">
      <label class="field-label">{{ t('config.pryNotch') }}</label>
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
    <div class="auto-hint">
      <svg viewBox="0 0 16 16" width="14" height="14" class="hint-icon">
        <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.2" />
        <path d="M5 8.2l2 2 4-4.4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
      <span>{{ t('config.jigAuto', { j: c.jigSize }) }}</span>
    </div>

    <!-- 高级参数(默认折叠) -->
    <button class="advanced-toggle" @click="showAdvanced = !showAdvanced">
      <span>{{ t('config.advanced') }}</span>
      <svg class="chevron" :class="{ 'is-open': showAdvanced }" viewBox="0 0 16 16" width="14" height="14">
        <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </button>

    <div v-show="showAdvanced" class="advanced-body">
      <!-- 托盘 -->
      <div class="section-label">{{ t('config.tray') }}</div>
      <div class="auto-hint">
        <svg viewBox="0 0 16 16" width="14" height="14" class="hint-icon">
          <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.2" />
          <path d="M5 8.2l2 2 4-4.4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        <span>{{ t('config.trayHint') }}</span>
      </div>
      <div class="field-row field-row-3">
        <div class="field">
          <label class="field-label">{{ t('config.insertHeight') }}</label>
          <el-input-number v-model="c.insertHeight" :min="4" :max="20" :step="0.5" :precision="1" size="small" style="width: 100%" />
        </div>
        <div class="field">
          <label class="field-label">{{ t('config.platterMargin') }}</label>
          <el-input-number v-model="c.platterMargin" :min="minMargin" :max="maxMargin" :step="0.5" :precision="1" size="small" style="width: 100%" />
        </div>
        <div class="field">
          <label class="field-label">{{ t('config.platterCorner') }}</label>
          <el-input-number v-model="c.platterCornerRadius" :min="0" :max="10" :step="0.5" :precision="1" size="small" style="width: 100%" />
        </div>
      </div>
      <div class="field">
        <label class="field-label">{{ t('config.pocketClearance') }}</label>
        <el-input-number v-model="c.pcbPocketClearance" :min="0" :max="2" :step="0.05" :precision="2" size="small" style="width: 100%" />
      </div>
      <div v-if="effectiveMargin > c.platterMargin + 0.01" class="auto-hint">
        <svg viewBox="0 0 16 16" width="14" height="14" class="hint-icon">
          <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.2" />
          <path d="M8 7v4M8 5.5v.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
        </svg>
        <span>{{ t('config.platterHint', { m: effectiveMargin.toFixed(1) }) }}</span>
      </div>
      <div class="field-row field-row-3">
        <div class="field">
          <label class="field-label">{{ t('config.ejectSlot') }}</label>
          <el-input-number v-model="c.ejectSlotWidth" :min="0" :max="40" :step="1" :precision="0" size="small" style="width: 100%" />
        </div>
        <div class="field">
          <label class="field-label">{{ t('config.outerCorner') }}</label>
          <el-input-number v-model="c.outerCornerRadius" :min="0" :max="10" :step="0.5" :precision="1" size="small" style="width: 100%" />
        </div>
      </div>

      <!-- 夹具 -->
      <div class="section-label">{{ t('config.jig') }}</div>
      <div class="field">
        <label class="field-label">{{ t('config.jigSide') }}</label>
        <el-input-number
          v-model="c.jigSize"
          :min="minJigSize"
          :max="500"
          :step="20"
          size="default"
          style="width: 100%"
        />
      </div>
      <div class="auto-hint">
        <svg viewBox="0 0 16 16" width="14" height="14" class="hint-icon">
          <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.2" />
          <path d="M5 8.2l2 2 4-4.4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        <span>{{ t('config.jigHint', { w: windowSize, j: c.jigSize }) }}</span>
      </div>

      <!-- 重置(只重置高级参数,基础区保留) -->
      <button class="reset-btn" @click="resetAll">{{ t('config.reset') }}</button>
    </div>
  </div>
</template>

<style scoped>
.config-form {
  padding: 16px;
}

/* 参数警告卡 */
.warnings-card {
  border: 1px solid rgba(226, 121, 0, 0.35);
  background: var(--status-warning-surface-l1);
  border-radius: var(--radius-8);
  padding: 10px 12px;
  margin-bottom: 4px;
}

.warnings-head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  font-weight: var(--font-weight-strong);
  color: var(--status-warning-default);
  margin-bottom: 6px;
}

.warnings-list {
  margin: 0;
  padding: 0 0 0 2px;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.warnings-list li {
  font-size: 11px;
  line-height: 16px;
  color: var(--text-secondary);
  padding-left: 14px;
  position: relative;
}

.warnings-list li::before {
  content: "";
  position: absolute;
  left: 2px;
  top: 6px;
  width: 4px;
  height: 4px;
  border-radius: var(--radius-full);
  background: var(--status-warning-default);
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

.field-row-3 > .field {
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

.auto-hint {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin: 0 0 12px 0;
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

.auto-hint strong {
  color: var(--text-brand);
  font-weight: var(--font-weight-strong);
  font-family: var(--font-family-metric);
}

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

.reset-btn {
  width: 100%;
  padding: 8px 12px;
  border: 1px solid var(--border-neutral-l1);
  border-radius: var(--radius-6);
  background: var(--bg-base-default);
  color: var(--text-secondary);
  font-size: 12px;
  font-weight: var(--font-weight-medium);
  cursor: pointer;
  transition: background-color 0.12s ease, border-color 0.12s ease;
  margin-top: 8px;
}

.reset-btn:hover {
  background: var(--bg-overlay-l1);
  border-color: var(--border-neutral-l2);
  color: var(--text-default);
}
</style>
