<script setup lang="ts">
import { computed, onBeforeMount, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useConfigStore, windowHalf, effectivePlatterMargin, stencilClampFloor, STRUCTURE_PRESETS } from "../stores/config";

const store = useConfigStore();
const { t } = useI18n();
const c = computed(() => store.config);
const warnings = computed(() => store.warnings);
const windowSize = computed(() => (windowHalf(store.config) * 2).toFixed(1));

// 组件 setup 之前先钳制异常值 —— 防止 ElementPlus InputNumber 在 setup 阶段抛
// "min should not be greater than max" 阻断整个应用挂载:
//   1. 加载旧工程 / localStorage 持久化的脏数据(用户曾经手动改过 jigSize < 60 等);
//   2. ElementPlus 的 watch 在 InputNumber 内部用 throw 报告错(uncaught),而非 return,会让
//      整个 setup 失败 → 整个页面白屏。
// 解决:在 setup 之前把所有数值钳到合法范围,InputNumber 后续只接收合法值。
// 夹具边长硬下限(5mm 取整):钢网外缘须落在周圈螺丝孔内侧且不碰孔壁,
// A/B 盖与底板同尺寸,绝不能小于该值
const jigMin = computed(() => Math.ceil(stencilClampFloor(store.config) / 5) * 5);

onBeforeMount(() => {
  const cfg = store.config;
  // windowGap ≥ 0(下界钳制由 store watch 完成)
  cfg.windowGap = Math.max(0, cfg.windowGap ?? 0.5);
  // jigSize ≥ 夹紧下限(提前钳制持久化的旧值,防止低于动态 min 触发 InputNumber 渲染错误)
  cfg.jigSize = Math.max(60, jigMin.value, cfg.jigSize || 60);
});

// 实际生效凸台外扩量 = max(stencilLip, 钢网要求的最小外扩量)
//   与 Python get_polys / plater_radius 同式:
//   凸台 = PCB 槽 + stencilLip;钢网反向钳制下凸台还得继续外扩到 frame_half
//   (A/B 框压在凸台四周的边缘 → 凸台托住钢网外缘,钢网不悬空)
const effectiveMargin = computed(() => effectivePlatterMargin(c.value));

// 双向滑块:绑 platterWidth(凸台宽度),向右拖 = 凸台变大、唇宽变小(符合直觉)
//   滑块范围 [pcbMax, stencilSize]:左端=凸台最小(=板子边长,唇宽最大),
//   右端=凸台最大(=钢网外缘,唇宽=0)
//   与 store watch 中 lipMax 同源:lMax = (stencilSize - pcbMax)/2
const pcbMaxSide = computed(() => Math.max(c.value.pcbSizeX, c.value.pcbSizeY));
const platterMinBound = computed(() => pcbMaxSide.value);
const platterMaxBound = computed(() => c.value.stencilSize);
const platterSliderValue = computed(() => c.value.platterWidth ?? pcbMaxSide.value);
function onPlatterSliderChange(v: number | number[]) {
  const pw = Array.isArray(v) ? v[0] : v;
  // 由 platterWidth 反推 lip(保持 sum = stencilSize)
  const clamped = Math.max(platterMinBound.value, Math.min(platterMaxBound.value, Number(pw) || 0));
  c.value.platterWidth = clamped;
  c.value.stencilLip = Math.max(0, (c.value.stencilSize - clamped) / 2);
}

// 夹具边长输入下限:与 store computeJigSize 同源(两个独立约束取大):
//   A · 2*win + 28(窗口+螺丝带+外缘)
//   B · stencil + 20(结构边 ≥10mm/边)
// 手动改小到装不下窗口时部件会被挖空(空 STL,模型不显示) —— 在输入框拦住
// 已存储值低于动态下界时抬到下界(如加载旧工程/钢网变大后):
//   值域与输入框一致,不留"显示 A 实际 B"的裂缝
//   注意:store 内的 watch[pcb/stencil/lip] 已经在 immediate 时执行同向钳制,
//   这里只做"输入框强制约束"——v-model 范围(防止用户绕过)

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

// 结构预设:一键套用(仅螺丝 + 结构高度,派生值由 store watch 联动)
const appliedPreset = ref<string | null>(null);
function applyPreset(id: string) {
  store.applyPreset(id);
  appliedPreset.value = id;
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

    <!-- 结构预设:一键套用常用螺丝 + 结构高度组合 -->
    <div class="section-label">{{ t('config.preset') }}</div>
    <div class="preset-group">
      <button
        v-for="p in STRUCTURE_PRESETS"
        :key="p.id"
        class="preset-btn"
        :class="{ active: appliedPreset === p.id }"
        @click="applyPreset(p.id)"
      >{{ t(p.label) }}</button>
    </div>
    <div class="auto-hint preset-hint">
      <svg viewBox="0 0 16 16" width="14" height="14" class="hint-icon">
        <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.2" />
        <path d="M5 8.2l2 2 4-4.4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
      <span>{{ t('config.presetHint') }}</span>
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
      <!-- 托盘几何:凸台/圆角/退件槽 -->
      <div class="section-label">{{ t('config.trayGeometry') }}</div>
      <div class="field-row field-row-3">
        <div class="field">
          <label class="field-label">{{ t('config.insertHeight') }}</label>
          <el-input-number v-model="c.insertHeight" :min="4" :max="20" :step="0.5" :precision="1" size="small" style="width: 100%" />
        </div>
        <div class="field">
          <label class="field-label">{{ t('config.platterCorner') }}</label>
          <el-input-number v-model="c.platterCornerRadius" :min="0" :max="10" :step="0.5" :precision="1" size="small" style="width: 100%" />
        </div>
        <div class="field">
          <label class="field-label">{{ t('config.outerCorner') }}</label>
          <el-input-number v-model="c.outerCornerRadius" :min="0" :max="10" :step="0.5" :precision="1" size="small" style="width: 100%" />
        </div>
      </div>
      <div class="field">
        <label class="field-label">{{ t('config.ejectSlot') }}</label>
        <el-input-number v-model="c.ejectSlotWidth" :min="0" :max="40" :step="1" :precision="0" size="small" style="width: 100%" />
      </div>

      <!-- 凸台 ↔ 唇宽(双向滑块):独立卡片突出,整行独占 -->
      <div class="section-label">{{ t('config.platterLipGroup') }}</div>
      <div class="platter-lip-card">
        <div class="platter-lip-slider">
          <label class="field-label">
            <span class="lbl-l">{{ t('config.stencilLip') }}</span>
            <span class="lbl-title">→</span>
            <span class="lbl-r">{{ t('config.platterWidth') }}</span>
          </label>
          <el-slider
            :model-value="platterSliderValue"
            @update:model-value="onPlatterSliderChange"
            :min="platterMinBound"
            :max="platterMaxBound"
            :step="0.1"
            :show-tooltip="true"
            :format-tooltip="(v: number) => `${t('config.platterWidth')} = ${v.toFixed(1)}mm`"
            :disabled="platterMaxBound <= platterMinBound"
          />
          <div class="slider-readout">
            <span class="rd-l">
              <span class="rd-k">{{ t('config.stencilLip') }}</span>
              <span class="rd-v">{{ c.stencilLip.toFixed(1) }} mm</span>
            </span>
            <span class="rd-eq">2 × {{ c.stencilLip.toFixed(1) }} + {{ c.platterWidth.toFixed(1) }} =</span>
            <span class="rd-r">
              <span class="rd-v">{{ c.stencilSize.toFixed(0) }} mm</span>
              <span class="rd-k">{{ t('config.stencilSizeShort') }}</span>
            </span>
          </div>
        </div>
        <div v-if="effectiveMargin > (c.stencilLip ?? 0) + 0.01" class="auto-hint">
          <svg viewBox="0 0 16 16" width="14" height="14" class="hint-icon">
            <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.2" />
            <path d="M8 7v4M8 5.5v.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
          </svg>
          <span>{{ t('config.platterHint', { m: effectiveMargin.toFixed(1) }) }}</span>
        </div>
      </div>

      <!-- 装配间隙 -->
      <div class="section-label">{{ t('config.assemblyGap') }}</div>
      <div class="field-row">
        <div class="field">
          <label class="field-label">{{ t('config.windowGap') }}</label>
          <el-input-number v-model="c.windowGap" :min="0" :max="5" :step="0.1" :precision="2" size="small" style="width: 100%" />
        </div>
        <div class="field">
          <label class="field-label">{{ t('config.pocketClearance') }}</label>
          <el-input-number v-model="c.pcbPocketClearance" :min="0" :max="2" :step="0.05" :precision="2" size="small" style="width: 100%" />
        </div>
      </div>

      <!-- 夹具外形 -->
      <div class="section-label">{{ t('config.jigShape') }}</div>
      <div class="field">
        <label class="field-label">{{ t('config.jigSide') }}</label>
        <el-input-number
          v-model="c.jigSize"
          :min="jigMin"
          :max="500"
          :step="5"
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

      <!-- 螺母沉槽(B 面底座) -->
      <div class="section-label">{{ t('config.hexNutPocket') }}</div>
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

/* 结构预设按钮组:横向三段式,active 高亮 */
.preset-group {
  display: flex;
  gap: 8px;
  margin-bottom: 12px;
}

.preset-btn {
  flex: 1;
  padding: 7px 8px;
  border: 1px solid var(--border-neutral-l2);
  border-radius: var(--radius-6);
  background: var(--bg-secondary, transparent);
  color: var(--text-secondary);
  font-size: 12px;
  font-weight: var(--font-weight-medium);
  cursor: pointer;
  transition: border-color 0.12s ease, color 0.12s ease, background-color 0.12s ease;
}

.preset-btn:hover {
  border-color: var(--border-neutral-l3);
  color: var(--text-default);
}

.preset-btn.active {
  border-color: #3E7D62;
  background: #E8F1EC;
  color: #3E7D62;
}

/* 双向滑块卡片:凸台宽 ⇄ 唇宽 —— 独立卡片突出,整行独占 */
.platter-lip-card {
  border: 1px solid var(--border-neutral-l2);
  border-radius: var(--radius-8);
  background: var(--bg-overlay-l1);
  padding: 14px 14px 10px 14px;
  margin-bottom: 12px;
}

.platter-lip-slider .field-label {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  margin-bottom: 2px;
}

.platter-lip-slider .lbl-l,
.platter-lip-slider .lbl-r {
  font-size: 12px;
  font-weight: var(--font-weight-medium);
  color: var(--text-primary);
}

.platter-lip-slider .lbl-title {
  font-size: 14px;
  color: var(--text-tertiary);
  margin: 0 8px;
  font-weight: var(--font-weight-medium);
}

.platter-lip-slider :deep(.el-slider) {
  margin: 10px 6px 4px 6px;
}

.platter-lip-slider :deep(.el-slider__runway) {
  background: linear-gradient(
    to right,
    rgba(62, 125, 98, 0.06) 0%,
    rgba(62, 125, 98, 0.22) 100%
  );
}

.platter-lip-card .auto-hint {
  margin: 8px 0 0 0;
  padding: 6px 10px;
  font-size: 11px;
}

.slider-readout {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 4px 2px 4px;
  font-size: 12px;
  color: var(--text-secondary);
  font-family: var(--font-family-metric);
  gap: 4px;
}

.slider-readout .rd-l,
.slider-readout .rd-r {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  min-width: 64px;
}

.slider-readout .rd-l {
  align-items: flex-start;
}

.slider-readout .rd-r {
  align-items: flex-end;
}

.slider-readout .rd-k {
  font-size: 11px;
  color: var(--text-tertiary);
  font-family: var(--font-family-default);
}

.slider-readout .rd-v {
  font-size: 13px;
  font-weight: var(--font-weight-medium);
  color: var(--text-primary);
}

.slider-readout .rd-eq {
  flex: 1;
  text-align: center;
  font-size: 11px;
  color: var(--text-tertiary);
  font-style: italic;
  font-family: var(--font-family-metric);
  white-space: nowrap;
}
</style>
