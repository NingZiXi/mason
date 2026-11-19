<script setup lang="ts">
import { computed, onBeforeMount, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { ElSwitch } from "element-plus";
import { DEFAULT, useConfigStore, windowHalf, platterHalfXY, windowHalfXY, stencilLipMax, stencilClampFloor, STRUCTURE_PRESETS } from "../stores/config";
import PanelScopePicker from "./PanelScopePicker.vue";
import MotionCollapse from "./MotionCollapse.vue";
import { focusParameterControl } from "../lib/focus-parameter-control";
import InlineHelp from "./InlineHelp.vue";
import ClampPlanPreview from "./ClampPlanPreview.vue";
import SlidingIndicator from "./SlidingIndicator.vue";
import ComponentReliefForm from './ComponentReliefForm.vue';
import { ejectHoleLimits, resolveEjectHoleSize } from '../lib/eject-hole';
import { effectiveInsertHeight } from '../lib/component-relief';
import PryNotchPicker from "./PryNotchPicker.vue";

const store = useConfigStore();
const { t } = useI18n();
const c = computed(() => store.config);
type NumberKey =
  | 'pcbSizeX' | 'pcbSizeY' | 'pcbThickness' | 'stencilSizeX' | 'stencilSizeY' | 'insertHeight'
  | 'platterCornerRadius' | 'outerCornerRadius' | 'windowGap' | 'pcbPocketClearance' | 'postClearance'
  | 'jigSize' | 'nutAcrossFlats' | 'nutHeight' | 'nutPocketClearance';
function updateNumber(key: NumberKey, value: number | null | undefined) {
  // A temporarily blank input must not alter the model or invalidate a size review.
  if (typeof value === 'number' && Number.isFinite(value)) c.value[key] = value;
}
const actualTrayThickness = computed(() => {
  const actual = effectiveInsertHeight(c.value);
  const minimum = c.value.insertHeight;
  if (!Number.isFinite(actual) || !Number.isFinite(minimum)) return null;
  const displayed = actual.toFixed(2);
  return displayed === minimum.toFixed(2) ? null : displayed.replace(/0$/, '');
});
// The legacy numeric field remains the switch; diameter is remembered separately.
const ejectHoleEnabled = computed({
  get: () => c.value.ejectSlotWidth > 0,
  set: (enabled: boolean) => { c.value.ejectSlotWidth = enabled ? DEFAULT.ejectSlotWidth : 0; },
});
const ejectLimits = computed(() => ejectHoleLimits(c.value));
const ejectSize = computed(() => resolveEjectHoleSize(ejectLimits.value, c.value.ejectHoleDiameter));
const ejectSliderValue = computed(() => Math.max(ejectSize.value.min,
  Math.min(ejectSize.value.max, ejectSize.value.diameter || Math.min(12, ejectSize.value.max))));
function updateEjectDiameter(value: number | number[]) {
  if (!ejectHoleEnabled.value || !ejectSize.value.available || Array.isArray(value) || !Number.isFinite(value)) return;
  c.value.ejectHoleDiameter = Math.max(ejectSize.value.min, Math.min(ejectSize.value.max, Math.round(value * 2) / 2));
}
function resetEjectDiameter() { c.value.ejectHoleDiameter = 0; }
const ejectHoleNote = computed(() => {
  const size = ejectSize.value;
  if (!size.available) return t('config.ejectSlotUnavailable');
  if (!size.custom && !size.diameter) return t('config.ejectSlotAutoSmall');
  if (size.clamped) return t('config.ejectSlotLimited', { diameter: size.diameter.toFixed(1) });
  return t(size.custom ? 'config.ejectSlotManualHint' : 'config.ejectSlotAutoHint');
});
const warnings = computed(() => store.warnings);
const stencilSizeReviewed = computed(() => store.stencilSizeReviewed);
const showStencilSizeGuide = computed(() => !!c.value.gerberFilename && !stencilSizeReviewed.value);
const stencilSizeSection = ref<HTMLElement | null>(null);
const stencilSizeGuide = ref<HTMLElement | null>(null);
let guideAnimation: Animation | undefined;
let finishGuideScroll: (() => void) | undefined;
let guideSequence = 0;

function cancelStencilReveal() {
  guideSequence++;
  finishGuideScroll?.();
  guideAnimation?.cancel();
  guideAnimation = undefined;
}

async function revealStencilSize(force = false, mayFocus = () => false) {
  cancelStencilReveal();
  const sequence = guideSequence;
  const section = stencilSizeSection.value;
  const sidebar = section?.closest<HTMLElement>(".app-sidebar");
  if (!section || !sidebar || (!force && !showStencilSizeGuide.value)) return;
  // Automatic import guidance scrolls only the sidebar. An explicit edit request can also move focus.
  const top = Math.max(0, Math.min(sidebar.scrollHeight - sidebar.clientHeight,
    sidebar.scrollTop + section.getBoundingClientRect().top - sidebar.getBoundingClientRect().top - 16));
  if (Math.abs(sidebar.scrollTop - top) > 1) {
    await new Promise<void>((resolve) => {
      const finish = () => {
        sidebar.removeEventListener("scrollend", finish);
        window.clearTimeout(timeout);
        finishGuideScroll = undefined;
        resolve();
      };
      // Fallback for WebViews without scrollend support.
      const timeout = window.setTimeout(finish, 1000);
      finishGuideScroll = finish;
      sidebar.addEventListener("scrollend", finish, { once: true });
      sidebar.scrollTo({ top, behavior: "smooth" });
    });
  } else {
    sidebar.scrollTo({ top, behavior: "instant" });
  }
  const guide = stencilSizeGuide.value;
  if (sequence !== guideSequence || !guide?.isConnected || !showStencilSizeGuide.value) return;
  if (mayFocus()) section.querySelector<HTMLInputElement>("#stencil-length")?.focus({ preventScroll: true });
  const style = getComputedStyle(guide);
  const highlight = { backgroundColor: "rgba(232, 187, 62, .30)", borderColor: "rgba(198, 153, 37, .65)" };
  const clear = { backgroundColor: style.backgroundColor, borderColor: style.borderColor };
  // Two gentle amber pulses, independent of the OS animation setting.
  guideAnimation = guide.animate([clear, highlight, clear], {
    duration: 800,
    iterations: 2,
    easing: "ease-in-out",
  });
}

defineExpose({ revealStencilSize });
onBeforeUnmount(cancelStencilReveal);
// Stop an old guide animation when its target changes. Review state lives in the store.
watch(() => [c.value.gerberFilename, c.value.pcbOutlinePoints, c.value.stencilSizeX, c.value.stencilSizeY], () => {
  cancelStencilReveal();
});
const windowSize = computed(() => (windowHalf(store.config) * 2).toFixed(1));

// 组件 setup 之前先钳制异常值 —— 防止 ElementPlus InputNumber 在 setup 阶段抛
// "min should not be greater than max" 阻断整个应用挂载:
//   1. 恢复配置预设中的越界参数(用户曾经手动改过 jigSize < 60 等);
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

// 唇宽滑块(单条,四边一致):范围 [0, lipMax]
//   lipMax = min(钢网半长 - 槽半长, 钢网半宽 - 槽半宽) —— 保证凸台每轴
//   都不小于 PCB 槽,否则 PCB 边缘悬空。与 store / Python 同源。
const lipMax = computed(() => Math.max(0, Math.floor(stencilLipMax(c.value) * 10) / 10));
const lipValue = computed(() => Math.min(Math.max(0, c.value.stencilLip ?? 0), lipMax.value));
// Both segments share the available travel on the limiting axis, not the PCB area.
const lipPercentTenths = computed(() => lipMax.value > 0 ? Math.round(1000 * lipValue.value / lipMax.value) : null);
function onLipChange(v: number | number[]) {
  const n = Array.isArray(v) ? v[0] : v;
  c.value.stencilLip = Math.max(0, Math.min(lipMax.value, Number(n) || 0));
}

// 派生读数:凸台 / 窗口逐轴尺寸(矩形钢网下长宽可不等)
const platterSize = computed(() => {
  const p = platterHalfXY(c.value);
  return `${(p.hx * 2).toFixed(1)} × ${(p.hy * 2).toFixed(1)}`;
});
const windowSizeXY = computed(() => {
  const w = windowHalfXY(c.value);
  return `${(w.hx * 2).toFixed(1)} × ${(w.hy * 2).toFixed(1)}`;
});

// 夹具边长输入下限:与 store computeJigSize 同源(两个独立约束取大):
//   A · 2*win + 28(窗口+螺丝带+外缘)
//   B · stencil + 20(结构边 ≥10mm/边)
// 手动改小到装不下窗口时部件会被挖空(空 STL,模型不显示) —— 在输入框拦住
// 已存储值低于动态下界时抬到下界(如切换预设/钢网变大后):
//   值域与输入框一致,不留"显示 A 实际 B"的裂缝
//   注意:store 内的 watch[pcb/stencil/lip] 已经在 immediate 时执行同向钳制,
//   这里只做"输入框强制约束"——v-model 范围(防止用户绕过)

// 取放缺口:四向点亮开关(可任意组合,全灭 = 关闭)
// 高级参数默认折叠:常规流程(Gerber → 导出)用默认值即可
const showAdvanced = defineModel<boolean>('advancedOpen', { default: false });

function resetAll() {
  store.reset();
}

// 结构预设:一键套用(仅螺丝 + 结构高度,派生值由 store watch 联动)
const appliedPreset = computed(() => STRUCTURE_PRESETS.find((preset) =>
  Object.entries(preset.apply).every(([key, value]) => c.value[key as keyof typeof preset.apply] === value)
)?.id ?? null);
function applyPreset(id: string) {
  store.applyPreset(id);
}
</script>

<template>
  <div class="config-form">
    <!-- 拼版口径(仅导入拼版 Gerber 时出现):放在最上面,先定口径再调参数 -->
    <PanelScopePicker />

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

    <section class="parameter-section preset-section" :aria-label="t('config.preset')">
    <!-- 结构预设:一键套用常用螺丝 + 结构高度组合 -->
    <InlineHelp id="config-presetHint" topic="structure" class="section-help" :label="t('config.preset')"><span>{{ t('config.preset') }}</span></InlineHelp>
    <div class="preset-group">
      <SlidingIndicator />
      <button
        v-for="p in STRUCTURE_PRESETS"
        :key="p.id"
        class="preset-btn"
        :class="{ active: appliedPreset === p.id }"
        :aria-pressed="appliedPreset === p.id"
        @click="applyPreset(p.id)"
      >{{ t(p.label) }}</button>
    </div>

    </section>

    <section class="parameter-section pcb-section" :aria-label="t('config.pcb')">
    <!-- PCB(基本:拖入 Gerber 自动填,板厚需用户确认) -->
    <div class="section-label">{{ t('config.pcb') }}</div>
    <div class="field-row pcb-dimensions">
      <div class="field">
        <label for="jig-length" class="field-label">{{ t('config.length') }}</label>
        <el-input-number id="jig-length"
          :model-value="c.pcbSizeX"
          :value-on-clear="c.pcbSizeX"
          :min="5"
          :max="300"
          :step="0.5"
          :precision="1"
          size="default"
          style="width: 100%"
          @update:model-value="updateNumber('pcbSizeX', $event)"
        />
      </div>
      <div class="field">
        <label for="jig-width" class="field-label">{{ t('config.width') }}</label>
        <el-input-number id="jig-width"
          :model-value="c.pcbSizeY"
          :value-on-clear="c.pcbSizeY"
          :min="5"
          :max="300"
          :step="0.5"
          :precision="1"
          size="default"
          style="width: 100%"
          @update:model-value="updateNumber('pcbSizeY', $event)"
        />
      </div>
    <div class="field">
      <label for="jig-thickness" class="field-label">{{ t('config.thickness') }}</label>
      <el-input-number id="jig-thickness"
        :model-value="c.pcbThickness"
        :value-on-clear="c.pcbThickness"
        :min="0.4"
        :max="3.2"
        :step="0.2"
        :precision="2"
        size="default"
        style="width: 100%"
        @update:model-value="updateNumber('pcbThickness', $event)"
      />
    </div>
    </div>
    <!-- 导入提示需区分真实板框与焊盘估算范围。 -->
    <div v-if="c.gerberFilename" class="auto-hint" :class="{ 'is-estimated': store.gerberOutlineSource === 'pads-bounds' }">
      <svg viewBox="0 0 16 16" width="14" height="14" class="hint-icon">
        <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.2" />
        <path v-if="store.gerberOutlineSource === 'pads-bounds'" d="M8 4.5v4M8 11v.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
        <path v-else d="M5 8.2l2 2 4-4.4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
      <span>{{ t(store.gerberOutlineSource === 'pads-bounds' ? 'config.gerberEstimated' : 'config.gerberApplied', { f: store.gerberFileDetails?.outline ?? c.gerberFilename }) }}</span>
    </div>

    </section>

    <ComponentReliefForm />

    <!-- 钢网(基本:按板子自动推荐,可改成实际购买的钢网尺寸;长宽独立可矩形) -->
    <section ref="stencilSizeSection" class="parameter-section stencil-size-section" :aria-label="t('config.stencil')">
    <InlineHelp id="jig-stencil-size-help" topic="stencilSize" class="section-help" :label="t('config.stencilSize')">
      <span>{{ t('config.stencil') }}</span>
    </InlineHelp>
    <div class="field-row">
      <div class="field">
        <label for="stencil-length" class="field-label">{{ t('config.stencilSizeX') }}</label>
        <el-input-number id="stencil-length"
          :model-value="c.stencilSizeX"
          :value-on-clear="c.stencilSizeX"
          :aria-label="t('config.stencilSizeX')"
          :aria-describedby="showStencilSizeGuide ? 'stencil-size-guide' : undefined"
          :min="10"
          :max="290"
          :step="5"
          :precision="0"
          size="default"
          style="width: 100%"
          @update:model-value="updateNumber('stencilSizeX', $event)"
        />
      </div>
      <div class="field">
        <label for="stencil-width" class="field-label">{{ t('config.stencilSizeY') }}</label>
        <el-input-number id="stencil-width"
          :model-value="c.stencilSizeY"
          :value-on-clear="c.stencilSizeY"
          :aria-label="t('config.stencilSizeY')"
          :aria-describedby="showStencilSizeGuide ? 'stencil-size-guide' : undefined"
          :min="10"
          :max="290"
          :step="5"
          :precision="0"
          size="default"
          style="width: 100%"
          @update:model-value="updateNumber('stencilSizeY', $event)"
        />
      </div>
    </div>
    <MotionCollapse :open="showStencilSizeGuide">
      <div ref="stencilSizeGuide" id="stencil-size-guide" class="stencil-size-guide">
        <svg viewBox="0 0 20 20" width="17" height="17" aria-hidden="true">
          <rect x="3" y="4.5" width="14" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="1.3" />
          <path d="M6 5v3M9 5v2M12 5v3M15 5v2" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
        </svg>
        <div>
          <strong>{{ t('config.stencilSizeGuideTitle') }}</strong>
          <p>{{ t('config.stencilSizeGuide') }}</p>
          <button type="button" class="stencil-size-reviewed" @click="store.confirmStencilSizeReview()">
            <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="m3.5 8 3 3 6-6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" /></svg>
            {{ t('config.stencilSizeReviewed') }}
          </button>
        </div>
      </div>
    </MotionCollapse>
    </section>

    <section class="parameter-section lip-section" :aria-label="t('config.platterLipGroup')">
      <div class="section-label lip-section-heading">{{ t('config.platterLipGroup') }}</div>
      <div class="platter-lip-card">
        <ClampPlanPreview />
        <InlineHelp id="clamp-plan-help" topic="lip" class="platter-lip-slider" :label="t('config.platterLipGroup')" :text="t('clampPlan.help')">
          <label for="jig-stencil-lip" class="field-label lip-label" @click.prevent="focusParameterControl">{{ t('guideUi.lipWidth') }}</label>
          <template v-if="lipPercentTenths !== null" #trailing>
            <strong class="lip-current">{{ lipValue.toFixed(1) }}<small>mm</small></strong>
          </template>
          <template #control>
            <div class="lip-proportion" :class="{ unavailable: lipPercentTenths === null }">
              <el-slider id="jig-stencil-lip" :aria-label="t('config.stencilLip')"
                :model-value="lipValue"
                @update:model-value="onLipChange"
                :min="0"
                :max="Math.max(lipMax, 0.1)"
                :step="0.1"
                :show-tooltip="false"
                :disabled="lipPercentTenths === null"
                :format-value-text="(v: number) => `${v.toFixed(1)} mm`"
              />
              <template v-if="lipPercentTenths !== null">
                <div class="lip-ratio-key">
                  <span><i aria-hidden="true" />{{ t('guideUi.lip') }} <b>{{ lipPercentTenths / 10 }}%</b></span>
                  <span><i aria-hidden="true" />{{ t('guideUi.margin') }} <b>{{ (1000 - lipPercentTenths) / 10 }}%</b></span>
                </div>
                <div class="lip-budget"><span>{{ t('guideUi.width') }}</span><span>{{ lipMax.toFixed(1) }} mm</span></div>
              </template>
            </div>
            <div v-if="lipPercentTenths === null" class="auto-hint">
              <svg viewBox="0 0 16 16" width="14" height="14" class="hint-icon" aria-hidden="true">
                <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.2" />
                <path d="M8 7v4M8 5.5v.5" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
              </svg>
              <span>{{ t('config.lipNoRoom') }}</span>
            </div>
            <dl class="slider-readout">
              <div><dt>{{ t('config.platterSizeShort') }}</dt><dd>{{ platterSize }} <small>mm</small></dd></div>
              <div><dt>{{ t('config.windowSizeShort') }}</dt><dd>{{ windowSizeXY }} <small>mm</small></dd></div>
            </dl>
          </template>
        </InlineHelp>
      </div>
    </section>

    <section class="parameter-section handling-section" :aria-label="t('config.handling')">
    <div class="section-label">{{ t('config.handling') }}</div>
    <InlineHelp id="jig-pry-notch-help" topic="pryNotch" notch-variant="jig" :label="t('config.pryNotch')">
      <span class="field-label">{{ t('config.pryNotch') }}</span>
      <template #control>
        <PryNotchPicker variant="jig" />
      </template>
    </InlineHelp>
    <div class="auto-hint">
      <svg viewBox="0 0 16 16" width="14" height="14" class="hint-icon">
        <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.2" />
        <path d="M5 8.2l2 2 4-4.4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
      <span>{{ t('config.jigAuto', { j: c.jigSize }) }}</span>
    </div>

    </section>

    <!-- 高级参数(默认折叠) -->
    <button class="advanced-toggle" :aria-expanded="showAdvanced" @click="showAdvanced = !showAdvanced">
      <span>{{ t('config.advanced') }}</span>
      <svg class="chevron" :class="{ 'is-open': showAdvanced }" viewBox="0 0 16 16" width="14" height="14">
        <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </button>

    <MotionCollapse :open="showAdvanced"><div class="advanced-body">
      <!-- 托盘几何:凸台/圆角/退件槽 -->
      <div class="section-label">{{ t('config.trayGeometry') }}</div>
      <div class="field-row tray-geometry-fields">
        <div class="field">
          <label for="jig-insert-height" class="field-label">{{ t('config.insertHeight') }}</label>
          <el-input-number id="jig-insert-height" :model-value="c.insertHeight" :value-on-clear="c.insertHeight"
            :min="4" :max="20" :step="0.5" :precision="1" size="small" style="width: 100%"
            @update:model-value="updateNumber('insertHeight', $event)" />
        </div>
        <div class="field">
          <label for="jig-platter-corner" class="field-label">{{ t('config.platterCorner') }}</label>
          <el-input-number id="jig-platter-corner"
            :model-value="c.platterCornerRadius" :value-on-clear="c.platterCornerRadius"
            :min="0" :max="10" :step="0.5" :precision="1" size="small" style="width: 100%"
            @update:model-value="updateNumber('platterCornerRadius', $event)"
          />
        </div>
        <div class="field">
          <label for="jig-outer-corner" class="field-label">{{ t('config.outerCorner') }}</label>
          <el-input-number id="jig-outer-corner"
            :model-value="c.outerCornerRadius" :value-on-clear="c.outerCornerRadius"
            :min="0" :max="10" :step="0.5" :precision="1" size="small" style="width: 100%"
            @update:model-value="updateNumber('outerCornerRadius', $event)"
          />
        </div>
        <output v-if="actualTrayThickness !== null" class="tray-height-readout" for="jig-insert-height">
          {{ t('config.actualTrayThickness', { height: actualTrayThickness }) }}
        </output>
      </div>
      <div class="field eject-hole-field">
        <InlineHelp id="config-ejectSlot-help" topic="eject" :label="t('config.ejectSlot')" :text="t('config.ejectSlotHint')">
          <label for="jig-eject-slot" class="field-label">{{ t('config.ejectSlot') }}</label>
          <template #trailing><el-switch id="jig-eject-slot" v-model="ejectHoleEnabled" :aria-label="t('config.ejectSlot')" /></template>
          <template #control>
            <MotionCollapse :open="ejectHoleEnabled">
              <div class="eject-size-control">
                <div class="eject-size-heading">
                  <label for="jig-eject-diameter" @click.prevent="focusParameterControl">{{ t('config.ejectSlotDiameter') }}</label>
                  <div class="eject-size-value">
                    <strong><span>{{ ejectSize.diameter ? `Φ ${ejectSize.diameter.toFixed(1)}` : '—' }}</span><small>mm</small></strong>
                    <button type="button" class="eject-auto-button" :class="{ active: !ejectSize.custom }"
                      :aria-pressed="!ejectSize.custom" @click="resetEjectDiameter">{{ t('config.ejectSlotAuto') }}</button>
                  </div>
                </div>
                <el-slider id="jig-eject-diameter" v-if="ejectSize.max > ejectSize.min" :model-value="ejectSliderValue" :min="ejectSize.min" :max="ejectSize.max"
                  :step="0.5" :disabled="!ejectSize.available"
                  :aria-label="t('config.ejectSlotDiameter')" :show-tooltip="true"
                  :format-tooltip="(value: number) => `Φ ${value.toFixed(1)} mm`" @update:model-value="updateEjectDiameter" />
                <button v-else id="jig-eject-diameter" type="button" class="eject-auto-button eject-fixed-size" :disabled="!ejectSize.available"
                  :class="{ active: ejectSize.custom && ejectSize.diameter === ejectSize.min }"
                  :aria-pressed="ejectSize.custom && ejectSize.diameter === ejectSize.min"
                  :aria-label="`${t('config.ejectSlotDiameter')} Φ ${ejectSize.min.toFixed(1)} mm`"
                  @click="updateEjectDiameter(ejectSize.min)">Φ {{ ejectSize.min.toFixed(1) }} mm</button>
                <p v-if="ejectSize.max > ejectSize.min || !ejectSize.available || ejectSize.clamped" class="eject-hole-note"
                  :class="{ 'is-limited': ejectSize.clamped || !ejectSize.available }">{{ ejectHoleNote }}</p>
              </div>
            </MotionCollapse>
          </template>
        </InlineHelp>
      </div>

      <!-- 装配间隙 -->
      <div class="section-label">{{ t('config.assemblyGap') }}</div>
      <div class="field">
        <InlineHelp id="jig-window-gap-help" topic="windowGap" :label="t('config.windowGap')">
          <label for="jig-window-gap" class="field-label">{{ t('config.windowGap') }}</label>
          <template #control>
            <el-input-number id="jig-window-gap"
              :model-value="c.windowGap" :value-on-clear="c.windowGap"
              :min="0" :max="5" :step="0.1" :precision="2" size="small" style="width: 100%"
              @update:model-value="updateNumber('windowGap', $event)"
            />
          </template>
        </InlineHelp>
      </div>
      <div class="field">
        <InlineHelp id="config-pocketClearanceHint" topic="pocket" :label="t('config.pocketClearance')" :text="t('config.pocketClearanceHint')">
          <label for="jig-pocket-clearance" class="field-label">{{ t('config.pocketClearance') }}</label>
          <template #control>
            <el-input-number id="jig-pocket-clearance"
              :model-value="c.pcbPocketClearance" :value-on-clear="c.pcbPocketClearance"
              :min="0" :max="2" :step="0.05" :precision="2" size="small" style="width: 100%"
              @update:model-value="updateNumber('pcbPocketClearance', $event)"
            />
          </template>
        </InlineHelp>
      </div>
      <div class="field">
        <InlineHelp id="config-postClearanceHint" topic="post" :label="t('config.postClearance')" :text="t('config.postClearanceHint')">
          <label for="jig-post-clearance" class="field-label">{{ t('config.postClearance') }}</label>
          <template #control>
            <el-input-number id="jig-post-clearance"
              :model-value="c.postClearance" :value-on-clear="c.postClearance"
              :min="0" :max="1" :step="0.025" :precision="3" size="small" style="width: 100%"
              @update:model-value="updateNumber('postClearance', $event)"
            />
          </template>
        </InlineHelp>
      </div>

      <!-- 夹具外形 -->
      <div class="section-label">{{ t('config.jigShape') }}</div>
      <div class="field">
        <label for="jig-side" class="field-label">{{ t('config.jigSide') }}</label>
        <el-input-number id="jig-side"
          :model-value="c.jigSize" :value-on-clear="c.jigSize"
          @update:model-value="updateNumber('jigSize', $event)"
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
        <InlineHelp id="config-nut-pocket-help" topic="nutPocket" :label="t('config.hexNutPocket')">
          <el-checkbox v-model="c.useHexNut" size="default">
            <span class="checkbox-label">{{ t('config.useHexNut') }}</span>
          </el-checkbox>
        </InlineHelp>
      </div>
      <MotionCollapse :open="c.useHexNut">
        <div class="field-row">
          <div class="field">
            <label for="jig-nut-across-flats" class="field-label">{{ t('config.nutAcrossFlats') }}</label>
            <el-input-number id="jig-nut-across-flats"
              :model-value="c.nutAcrossFlats" :value-on-clear="c.nutAcrossFlats"
              @update:model-value="updateNumber('nutAcrossFlats', $event)"
              :min="3" :max="15" :step="0.1" :precision="2"
              size="small" style="width: 100%"
            />
          </div>
          <div class="field">
            <label for="jig-nut-height" class="field-label">{{ t('config.nutHeight') }}</label>
            <el-input-number id="jig-nut-height"
              :model-value="c.nutHeight" :value-on-clear="c.nutHeight"
              @update:model-value="updateNumber('nutHeight', $event)"
              :min="1.5" :max="6" :step="0.1" :precision="2"
              size="small" style="width: 100%"
            />
          </div>
        </div>
        <div class="field">
          <InlineHelp id="config-nutPocketClearanceHint" topic="nut" :label="t('config.nutPocketClearance')" :text="t('config.nutPocketClearanceHint')">
            <label for="jig-nut-pocket-clearance" class="field-label">{{ t('config.nutPocketClearance') }}</label>
            <template #control>
              <el-input-number id="jig-nut-pocket-clearance"
                :model-value="c.nutPocketClearance" :value-on-clear="c.nutPocketClearance"
                @update:model-value="updateNumber('nutPocketClearance', $event)"
                :min="0" :max="1" :step="0.05" :precision="2"
                size="small" style="width: 100%"
              />
            </template>
          </InlineHelp>
        </div>
      </MotionCollapse>

      <!-- 重置(只重置高级参数,基础区保留) -->
      <button class="reset-btn" @click="resetAll">{{ t('config.reset') }}</button>
    </div></MotionCollapse>
  </div>
</template>

<style scoped>
.config-form {
  padding: 16px;
  container-type: inline-size;
}

.parameter-section { min-width: 0; }
.parameter-section + .parameter-section { margin-top: 18px; padding-top: 18px; border-top: 1px solid var(--surface-line); }
.parameter-section > .section-label:first-child { margin-top: 0; }
.parameter-section > .field:last-child { margin-bottom: 0; }
.parameter-section > .auto-hint:last-child { margin-bottom: 0; }

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
  font-size: var(--heading-2xs-font-size);
  line-height: var(--body-md-line-height);
  font-weight: var(--font-weight-strong);
  color: var(--text-secondary);
  letter-spacing: 0;
  margin: 20px 0 12px 0;
}

.section-label:first-child {
  margin-top: 0;
}

.field-row {
  display: flex;
  gap: 12px;
}

.pcb-dimensions { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
.pcb-dimensions > .field:last-child { grid-column: 1 / -1; }
.field-row > .field { min-width: 0; }
@container (min-width: 380px) {
  .pcb-dimensions { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .pcb-dimensions > .field:last-child { grid-column: auto; }
}

.stencil-size-section {
  display: flow-root;
  margin-top: 0;
  border-radius: var(--radius-control);
}

.stencil-size-guide {
  --guide-ink: #946817;
  display: flex;
  align-items: flex-start;
  gap: 9px;
  padding: 10px 12px;
  margin-bottom: 12px;
  border-radius: var(--radius-control);
  background: rgba(232, 187, 62, .14);
  border: 1px solid rgba(198, 153, 37, .18);
  color: var(--text-secondary);
  font-size: 11px;
  line-height: 18px;
}
.stencil-size-guide > svg { flex-shrink: 0; margin-top: 1px; color: var(--guide-ink); }
.stencil-size-guide strong { display: block; color: var(--guide-ink); font-weight: var(--font-weight-strong); }
.stencil-size-guide p { margin: 3px 0 5px; color: var(--text-secondary); }
.stencil-size-reviewed { display: inline-flex; align-items: center; gap: 3px; padding: 3px 5px; margin-left: -5px; border: none; border-radius: 6px; background: transparent; color: var(--guide-ink); font: inherit; font-weight: var(--font-weight-medium); cursor: pointer; transition: var(--control-transition); }
.stencil-size-reviewed:hover { background: rgba(198, 153, 37, .12); }
.stencil-size-reviewed:focus-visible { outline: 2px solid var(--guide-ink); outline-offset: 2px; }
:global(html.dark) .stencil-size-guide { --guide-ink: #e4bd66; }

.field-row > .field {
  flex: 1;
}

.field {
  margin-bottom: 12px;
}

.tray-geometry-fields { flex-wrap: wrap; row-gap: 6px; margin-bottom: 12px; }
.tray-geometry-fields > .field { margin-bottom: 0; }
@container (max-width: 300px) {
  /* Keep the 24px step buttons; reclaim only the space beside them. */
  .tray-geometry-fields :deep(.el-input-number--small .el-input__wrapper) { padding-inline: 27px; }
}
.tray-height-readout {
  flex: 0 0 100%;
  color: var(--text-secondary);
  font-size: var(--body-sm-font-size);
  line-height: var(--body-md-line-height);
  font-variant-numeric: tabular-nums;
  overflow-wrap: anywhere;
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
  color: var(--text-default);
}

.field-label {
  display: block;
  font-size: 12px;
  font-weight: var(--font-weight-medium);
  color: var(--text-secondary);
  line-height: 18px;
  margin-bottom: 4px;
}

.eject-size-control { padding: 9px 2px 1px; }
.eject-size-heading { display: flex; align-items: center; justify-content: space-between; gap: 10px; color: var(--text-secondary); font-size: 11px; }
.eject-size-value { display: flex; align-items: center; gap: 10px; }
.eject-size-value strong { display: inline-flex; align-items: baseline; gap: 4px; color: var(--interaction-ink); font-family: var(--font-family-metric); font-size: 14px; font-weight: var(--font-weight-strong); font-variant-numeric: tabular-nums; }
.eject-size-value small { color: var(--text-tertiary); font-size: 10px; font-weight: var(--font-weight-default); }
.eject-auto-button { padding: 3px 8px; border: 1px solid var(--surface-line); border-radius: 999px; background: transparent; color: var(--text-tertiary); font: inherit; font-size: 10px; cursor: pointer; transition: var(--control-transition); }
.eject-auto-button.active, .eject-auto-button:hover { border-color: var(--interaction-border); background: var(--control-selection-surface); color: var(--interaction-ink); }
.eject-auto-button:focus-visible { outline: 2px solid var(--interaction-border); outline-offset: 2px; }
.eject-fixed-size { margin: 8px 0; color: var(--interaction-ink); }
.eject-fixed-size:disabled { opacity: .5; cursor: not-allowed; }
.eject-fixed-size:disabled:hover { border-color: var(--surface-line); background: transparent; }
.eject-size-control :deep(.el-slider) { width: auto; margin: 4px 14px 2px; }
.eject-size-control :deep(.el-slider__runway) { background: var(--parameter-slider-track); }
.eject-hole-note { margin: 0; color: var(--text-tertiary); font-size: 10px; line-height: 1.6; }
.eject-hole-note.is-limited { color: var(--status-warning-default); }

.auto-hint {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin: 0 0 12px 0;
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

.auto-hint.is-estimated { background: var(--status-warning-surface-l1); }
.auto-hint.is-estimated .hint-icon { color: var(--status-warning-default); }

.auto-hint strong {
  color: var(--text-brand);
  font-weight: var(--font-weight-strong);
  font-family: var(--font-family-metric);
}

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

.reset-btn {
  width: 100%;
  padding: 8px 12px;
  border: 1px solid var(--border-neutral-l1);
  border-radius: var(--radius-control); corner-shape: var(--corner-shape);
  background: var(--bg-base-default);
  color: var(--text-secondary);
  font-size: 12px;
  font-weight: var(--font-weight-medium);
  cursor: pointer;
  transition: var(--control-transition);
  margin-top: 8px;
}

.reset-btn:hover {
  background: var(--bg-overlay-l1);
  border-color: var(--border-neutral-l2);
  color: var(--text-default);
}

/* 结构预设按钮组:横向三段式,active 高亮 */
.preset-group {
  --selection-background: var(--control-selection-surface);
  --selection-border: var(--bg-brand);
  --selection-shadow: none;
  --selection-radius: var(--radius-control);
  position: relative;
  isolation: isolate;
  display: flex;
  gap: 8px;
  margin-bottom: 12px;
}

.preset-group .preset-btn {
  position: relative;
  z-index: 1;
  flex: 1;
  padding: 7px 8px;
  border: 1px solid transparent;
  border-radius: var(--radius-control); corner-shape: var(--corner-shape);
  background: transparent;
  color: var(--text-secondary);
  font-size: 12px;
  font-weight: var(--font-weight-medium);
  cursor: pointer;
  transition: var(--control-transition);
}

.preset-btn:not(.active) { border-color: var(--border-neutral-l2); }
.preset-btn:hover:not(.active) {
  border-color: var(--border-neutral-l3);
  background: var(--surface-well);
  color: var(--text-default);
}

.preset-group .preset-btn.active {
  background: transparent;
  border-color: transparent;
  color: var(--text-brand);
}

/* 双向滑块卡片:凸台宽 ⇄ 唇宽 —— 独立卡片突出,整行独占 */
.platter-lip-card {
  border: 1px solid var(--surface-line);
  border-radius: var(--radius-popover);
  corner-shape: var(--corner-shape);
  background: var(--surface-well);
  padding: 10px 10px 12px;
  margin-bottom: 0;
}
.lip-section {
  --grip-fill: rgba(210, 155, 62, .38);
  --grip-ink: #996d2d;
}
:global(html.dark) .lip-section { --grip-fill: rgba(215, 169, 87, .28); --grip-ink: #d7b77d; }
.lip-section-heading { margin-bottom: 10px; }
.platter-lip-slider { padding-inline: 4px; }
.platter-lip-slider .lip-label { color: var(--text-default); }
.lip-current { display: inline-flex; align-items: baseline; gap: 4px; flex-shrink: 0; color: var(--grip-ink); font-family: var(--font-family-metric); font-size: 16px; font-weight: var(--font-weight-strong); line-height: 22px; font-variant-numeric: tabular-nums; }
.lip-current small, .slider-readout small { color: var(--text-tertiary); font-size: var(--body-sm-font-size); font-weight: var(--font-weight-default); }

.lip-proportion { --lip-track: color-mix(in srgb, var(--grip-ink) 72%, var(--surface-raised)); --margin-track: color-mix(in srgb, var(--interaction-ink) 27%, var(--surface-raised)); }
.lip-proportion :deep(.el-slider) { --el-slider-height: 10px; --el-slider-border-radius: 6px; --el-slider-button-wrapper-offset: -13px; width: auto; margin: 2px 8px 0; }
.lip-proportion :deep(.el-slider__runway) { background: var(--margin-track); }
.lip-proportion :deep(.el-slider__bar) { background: var(--lip-track); border-radius: inherit; }
.lip-proportion :deep(.el-slider__button) { box-sizing: border-box; display: inline-grid; place-items: center; width: 15px; height: 22px; border: 1px solid var(--text-tertiary); border-radius: 6px; background: var(--surface-raised); }
.lip-proportion :deep(.el-slider__button::after) { content: ''; width: 2px; height: 8px; border-radius: 1px; background: var(--text-secondary); }
.lip-proportion.unavailable :deep(.el-slider__runway) { background: var(--surface-line); }
.lip-proportion.unavailable :deep(.el-slider__button) { opacity: .55; box-shadow: none; }
.lip-ratio-key { display: grid; grid-template-columns: fit-content(48%) minmax(0, 1fr); align-items: baseline; gap: 8px; color: var(--text-secondary); font-size: 11px; }
.lip-ratio-key span { display: flex; align-items: baseline; flex-wrap: wrap; gap: 0 5px; }
.lip-ratio-key span:last-child { justify-content: flex-end; text-align: end; }
.lip-ratio-key i { align-self: center; flex: 0 0 7px; height: 7px; border-radius: 2px; background: var(--lip-track); }
.lip-ratio-key span:last-child i { background: var(--margin-track); }
.lip-ratio-key b { font-variant-numeric: tabular-nums; color: var(--text-default); }
.lip-budget { display: flex; justify-content: space-between; align-items: baseline; flex-wrap: wrap; gap: 0 8px; margin-top: 3px; color: var(--text-secondary); font-size: 11px; font-variant-numeric: tabular-nums; }
.platter-lip-card .auto-hint { margin: 2px 0 0; padding: 7px 9px; font-size: 11px; }

.slider-readout { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; margin: 9px 0 0; padding-top: 8px; border-top: 1px solid var(--surface-line); }
.slider-readout > div:last-child { text-align: end; }
.slider-readout dt { font-size: 11px; color: var(--text-secondary); }
.slider-readout dd { margin: 0; font-size: 13px; font-family: var(--font-family-metric); font-weight: var(--font-weight-medium); color: var(--text-default); font-variant-numeric: tabular-nums; }
</style>
