<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useConfigStore, windowHalf, windowHalfXY } from "../stores/config";

const { t } = useI18n();
const store = useConfigStore();

// 螺丝高级设置(直径等)默认折叠:常规流程用默认值
const showAdvanced = ref(false);

const padding = 16; // SVG 内边距(加大)

const diagramSize = computed(() => {
  const W = store.config.jigSize;
  const H = store.config.jigSize;
  // 等比缩放到 320x320 显示区域(放大)
  const scale = 320 / Math.max(W, H);
  return {
    width: W * scale + 2 * padding,
    height: H * scale + 2 * padding,
    scale,
  };
});

// 模型坐标(夹具中心为原点)→ SVG 坐标:加 jig/2 平移到外框内
function toSvg(x: number, y: number): { cx: number; cy: number } {
  const { scale } = diagramSize.value;
  const half = store.config.jigSize / 2;
  return { cx: padding + (half + x) * scale, cy: padding + (half + y) * scale };
}

// 周圈螺丝(小点)
const screws = computed(() => {
  return store.screwPositions.map(([x, y]) => ({
    ...toSvg(x, y),
    r: 4,
  }));
});

// 4 角压钢网螺丝(大点,与 Python corner_screw_positions 同算法:紧贴 4 角)
const cornerScrews = computed(() => {
  const c = store.config;
  const win = windowHalf(c);
  const s = Math.max(c.jigSize / 2 - 7, win + 3.5);
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

// 窗口示意(凸台+0.4,真实矩形:x/y 半宽独立)
const windowRect = computed(() => {
  const { scale } = diagramSize.value;
  const { hx, hy } = windowHalfXY(store.config);
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
  const { hx, hy } = windowHalfXY(store.config);
  return `${(hx * 2).toFixed(1)}×${(hy * 2).toFixed(1)}`;
});
</script>

<template>
  <div class="screw-diagram">
    <div class="diagram-wrapper">
      <svg
        :width="diagramSize.width"
        :height="diagramSize.height"
        :viewBox="`0 0 ${diagramSize.width} ${diagramSize.height}`"
        style="background: var(--brand-grey-50); border-radius: var(--radius-6); padding: 8px"
      >
        <!-- 夹具外框 -->
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

        <!-- 窗口示意(凸台+0.4) -->
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

        <!-- 周圈螺丝(B 面配置) -->
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

        <!-- 4 角压钢网螺丝 -->
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

    <p class="meta">
      <span>{{ t('screwDiagram.count', { n: screwCount }) }}</span>
      <span>{{ t('screwDiagram.jigSize', { x: store.config.jigSize, y: store.config.jigSize }) }}</span>
      <span>{{ t('screwDiagram.windowSize', { s: windowSize }) }}</span>
    </p>

    <!-- 螺丝设置:基础 = 间距滑条;高级 = 直径等 -->
    <div class="screw-settings">
      <div class="field-col">
        <label class="settings-label">{{ t('config.spacing') }}</label>
        <el-slider
          v-model="store.config.screwSpacing"
          :min="0"
          :max="60"
          :step="5"
          show-input
          :show-input-controls="false"
        />
      </div>

      <button class="advanced-toggle" @click="showAdvanced = !showAdvanced">
        <span>{{ t('config.advanced') }}</span>
        <svg class="chevron" :class="{ 'is-open': showAdvanced }" viewBox="0 0 16 16" width="14" height="14">
          <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>
      <div v-show="showAdvanced" class="advanced-body">
        <div class="settings-row">
          <div class="field-col">
            <label class="settings-label">{{ t('config.cornerScrewD') }}</label>
            <el-input-number v-model="store.config.cornerScrewD" :min="3" :max="8" :step="0.5" :precision="1" size="small" style="width: 100%" />
          </div>
          <div class="field-col">
            <label class="settings-label">{{ t('config.periScrewD') }}</label>
            <el-input-number v-model="store.config.periScrewD" :min="2" :max="6" :step="0.5" :precision="1" size="small" style="width: 100%" />
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.screw-diagram {
  display: flex;
  flex-direction: column;
}

.diagram-wrapper {
  display: flex;
  justify-content: center;
  padding: var(--spacer-12);
}

svg {
  max-width: 100%;
  height: auto;
}

.meta {
  display: flex;
  flex-direction: column;
  gap: var(--spacer-6);
  margin-top: var(--spacer-12);
  padding: var(--spacer-10) var(--spacer-12);
  background: var(--bg-overlay-l1);
  border-radius: var(--radius-8);
  color: var(--text-secondary);
  font-size: var(--body-md-font-size);
  line-height: var(--body-md-line-height);
}

.meta span {
  font-weight: var(--font-weight-medium);
}

.meta strong {
  color: var(--text-brand);
  font-size: var(--body-lg-font-size);
  font-family: var(--font-family-metric);
  font-weight: var(--font-weight-strong);
  margin-right: var(--spacer-6);
}

/* 螺丝设置区 */
.screw-settings {
  margin-top: var(--spacer-12);
  display: flex;
  flex-direction: column;
  gap: var(--spacer-8);
}

.settings-row {
  display: flex;
  align-items: center;
  gap: var(--spacer-12);
}

.field-col {
  display: flex;
  flex-direction: column;
  gap: var(--spacer-4);
}

.settings-label {
  font-size: var(--body-sm-font-size);
  color: var(--text-secondary);
  font-weight: var(--font-weight-medium);
  white-space: nowrap;
}

.advanced-toggle {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--spacer-4);
  width: 100%;
  padding: 6px 12px;
  border: none;
  border-top: 1px solid var(--border-neutral-l1);
  background: transparent;
  color: var(--text-secondary);
  font-size: var(--body-sm-font-size);
  cursor: pointer;
}

.advanced-toggle:hover {
  color: var(--text-primary);
}

.advanced-toggle .chevron {
  transition: transform 0.22s cubic-bezier(0.4, 0, 0.2, 1);
}

.advanced-toggle .chevron.is-open {
  transform: rotate(180deg);
}

.advanced-body {
  display: flex;
  flex-direction: column;
  gap: var(--spacer-8);
}
</style>
