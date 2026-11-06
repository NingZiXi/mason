<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onMounted, onBeforeUnmount, ref, watch } from "vue";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { useI18n } from "vue-i18n";
import zhCn from "element-plus/es/locale/lang/zh-cn";
import enLocale from "element-plus/es/locale/lang/en";
import { useConfigStore } from "./stores/config";
import { useUiStore } from "./stores/ui";
import ConfigForm from "./components/ConfigForm.vue";
import ModelPreview from "./components/ModelPreview.vue";
import GerberImport, { type GerberImportPayload } from "./components/GerberImport.vue";
import ScrewDiagram from "./components/ScrewDiagram.vue";
import StencilForm from "./components/StencilForm.vue";
import PythonSetup from "./components/PythonSetup.vue";
import ProjectMenu from "./components/ProjectMenu.vue";
import HistoryControls from "./components/HistoryControls.vue";
import SettingsMenu from "./components/SettingsMenu.vue";
import ConfigPresets from "./components/ConfigPresets.vue";
import MotionCollapse from "./components/MotionCollapse.vue";
import { usePresetsStore } from "./stores/presets";
import type { PanelMode } from "./lib/gerber/panel";

const OnboardingTour = defineAsyncComponent(() => import("./components/OnboardingTour.vue"));

const configStore = useConfigStore();
void usePresetsStore().initialize();
const ui = useUiStore();
const { t } = useI18n();

// Element Plus 内置组件文案(弹窗按钮等)跟随语言切换
const epLocale = computed(() => (ui.locale === "en" ? enLocale : zhCn));
const appMode = computed(() => configStore.config.appMode);
// Gerber 导入完成态:治具模式看板框轮廓,钢网模式看焊盘(用于步骤圆点 1 → ✓)
const gerberDone = computed(() =>
  appMode.value === "stencil"
    ? configStore.config.stencilPadsTop.length > 0 || configStore.config.stencilPadsBottom.length > 0
    : configStore.config.pcbOutlinePoints.length > 0
);
function switchMode(mode: "jig" | "stencil") {
  configStore.setMode(mode);
}

// ===== 自定义标题栏(decorations:false,与页眉融合) =====
// 浏览器环境(纯 vite dev 预览)无 Tauri 窗口 API,兜底成空实现以便 UI 调试
const appWindow = (() => {
  try {
    return getCurrentWindow();
  } catch {
    return {
      isMaximized: async () => false,
      toggleMaximize: async () => {},
      onResized: async () => () => {},
    } as unknown as ReturnType<typeof getCurrentWindow>;
  }
})();
const isMaximized = ref(false);
let unlistenMaximize: UnlistenFn | null = null;

async function initWindowState() {
  isMaximized.value = await appWindow.isMaximized();
  // 旧版 @tauri-apps/api 无 onMaximizedChanged,用 onResized + 查询代替
  unlistenMaximize = (await appWindow.onResized(async () => {
    isMaximized.value = await appWindow.isMaximized();
  })) as unknown as UnlistenFn;
}

// 双击页眉空白 → 最大化/还原(Windows 标题栏惯例);交互控件上双击不触发
function onHeaderDblClick(e: MouseEvent) {
  const target = e.target as HTMLElement;
  if (target.closest("button, a, input, [role='button']")) return;
  appWindow.toggleMaximize();
}

onMounted(initWindowState);
onBeforeUnmount(() => {
  unlistenMaximize?.();
});

// 侧栏宽度
const sidebarWidth = ref(480);
const SIDEBAR_MIN = 340;
const SIDEBAR_MAX = 800;
const SIDEBAR_KEY = "psj_sidebar_width";
const SIDEBAR_HIDDEN_KEY = "psj_sidebar_hidden";
const sidebarHidden = ref(false);
const sidebarShell = ref<HTMLElement | null>(null);
const configFormRef = ref<InstanceType<typeof ConfigForm> | null>(null);
let importGuideSequence = 0;
const viewportWidth = ref(window.innerWidth);
const visibleSidebarWidth = computed(() => Math.max(SIDEBAR_MIN,
  Math.min(sidebarWidth.value, SIDEBAR_MAX, viewportWidth.value - 440)));
// 拖拽过程中禁用 transition 保证跟手,松手后再启用,产生"惯性到位"效果
const sidebarAnimating = ref(true);

// 每个卡片的高度
const CARD_MIN = 140;
const CARD_MAX = 900;
const CARD_COLLAPSED = 44;
const cardHeights = ref<Record<string, number>>({
  python: 160,
  gerber: 300,
  config: 520,
  screw: 360,
  stencil: 520,
});
// 卡片高度是否自适应内容(展开即完整显示);用户手动拖过 → false 锁定像素
const autoHeights = ref<Record<string, boolean>>({
  python: true,
  gerber: true,
  config: true,
  screw: true,
  stencil: true,
});
// Python 环境卡片默认折叠
const collapsed = ref<Record<string, boolean>>({
  python: true,
  gerber: false,
  config: false,
  screw: false,
  stencil: false,
});

const tourOpen = ref(false);
let tourPreparing = false;
let appDisposed = false;
let tourLayout: { hidden: boolean; collapsed: Record<string, boolean>; auto: Record<string, boolean>; scroll: number } | undefined;

async function startTour() {
  if (tourOpen.value || tourPreparing || appDisposed) return;
  tourPreparing = true;
  onWidthUp();
  onHeightUp();
  const sidebar = sidebarShell.value?.querySelector<HTMLElement>(".app-sidebar");
  tourLayout = { hidden: sidebarHidden.value, collapsed: { ...collapsed.value }, auto: { ...autoHeights.value }, scroll: sidebar?.scrollTop ?? 0 };
  sidebarHidden.value = false;
  collapsed.value = { ...collapsed.value, gerber: false, config: false, stencil: false };
  autoHeights.value = { ...autoHeights.value, gerber: true, config: true, stencil: true };
  await nextTick();
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  await Promise.allSettled((sidebarShell.value?.getAnimations({ subtree: true }) ?? [])
    .filter((animation) => Number.isFinite(animation.effect?.getComputedTiming().endTime))
    .map((animation) => animation.finished));
  tourPreparing = false;
  if (!appDisposed) tourOpen.value = true;
}

async function finishTour() {
  tourOpen.value = false;
  ui.dismissOnboarding();
  const layout = tourLayout;
  tourLayout = undefined;
  if (!layout) return;
  sidebarHidden.value = layout.hidden;
  collapsed.value = layout.collapsed;
  autoHeights.value = layout.auto;
  await nextTick();
  sidebarShell.value?.querySelector<HTMLElement>(".app-sidebar")?.scrollTo({ top: layout.scroll, behavior: "instant" });
}

const HEIGHTS_KEY = "psj_card_heights";
const AUTO_KEY = "psj_card_auto";
const COLLAPSED_KEY = "psj_card_collapsed";

// 从 localStorage 恢复
try {
  sidebarHidden.value = localStorage.getItem(SIDEBAR_HIDDEN_KEY) === "true";
  const w = localStorage.getItem(SIDEBAR_KEY);
  if (w) {
    const n = parseInt(w, 10);
    if (n >= SIDEBAR_MIN && n <= SIDEBAR_MAX) sidebarWidth.value = n;
  }
  const h = localStorage.getItem(HEIGHTS_KEY);
  if (h) {
    const parsed = JSON.parse(h);
    if (parsed && typeof parsed === "object") {
      cardHeights.value = { ...cardHeights.value, ...parsed };
    }
  }
  const a = localStorage.getItem(AUTO_KEY);
  if (a) {
    const parsed = JSON.parse(a);
    if (parsed && typeof parsed === "object") {
      autoHeights.value = { ...autoHeights.value, ...parsed };
    }
  }
  const c = localStorage.getItem(COLLAPSED_KEY);
  if (c) {
    const parsed = JSON.parse(c);
    if (parsed && typeof parsed === "object") {
      collapsed.value = { ...collapsed.value, ...parsed };
    }
  }
} catch { /* ignore */ }

function saveSettings() {
  try {
    localStorage.setItem(SIDEBAR_KEY, String(sidebarWidth.value));
    localStorage.setItem(SIDEBAR_HIDDEN_KEY, String(sidebarHidden.value));
    localStorage.setItem(HEIGHTS_KEY, JSON.stringify(cardHeights.value));
    localStorage.setItem(AUTO_KEY, JSON.stringify(autoHeights.value));
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify(collapsed.value));
  } catch { /* ignore */ }
}

// ===== 侧栏宽度拖动 =====
let isResizingWidth = false;
let widthStartX = 0;
let widthStartW = 480;

function onWidthDown(e: MouseEvent) {
  if (sidebarHidden.value) return;
  isResizingWidth = true;
  widthStartX = e.clientX;
  widthStartW = visibleSidebarWidth.value;
  document.body.style.cursor = "col-resize";
  document.body.style.userSelect = "none";
  sidebarAnimating.value = false;
  e.preventDefault();
}

function onWidthMove(e: MouseEvent) {
  if (!isResizingWidth) return;
  const newWidth = widthStartW + (e.clientX - widthStartX);
  if (newWidth >= SIDEBAR_MIN && newWidth <= SIDEBAR_MAX) {
    sidebarWidth.value = newWidth;
  }
}

function onWidthUp() {
  if (isResizingWidth) {
    isResizingWidth = false;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    saveSettings();
    // 松手后下一帧开启 transition,产生"惯性到位"效果
    requestAnimationFrame(() => {
      sidebarAnimating.value = true;
    });
  }
}

function resetSidebarWidth() {
  sidebarAnimating.value = true;
  sidebarWidth.value = 480;
  saveSettings();
}

function toggleSidebar() {
  onWidthUp();
  onHeightUp();
  sidebarAnimating.value = true;
  sidebarHidden.value = !sidebarHidden.value;
  saveSettings();
}

function updateViewportWidth() {
  viewportWidth.value = window.innerWidth;
}

// ===== 卡片高度拖动 =====
let isResizingHeight = false;
let heightCardId = "";
let heightStartY = 0;
let heightStartH = 0;

function onHeightDown(id: string, e: MouseEvent) {
  if (collapsed.value[id]) return;
  isResizingHeight = true;
  heightCardId = id;
  heightStartY = e.clientY;
  // 起点 = 卡片当前实际高度(自适应模式下没有存储值可用)
  const slot = (e.currentTarget as HTMLElement).closest<HTMLElement>(".card-slot");
  heightStartH = slot ? slot.offsetHeight : cardHeights.value[id];
  document.body.style.cursor = "ns-resize";
  document.body.style.userSelect = "none";
  e.preventDefault();
  e.stopPropagation();
}

function onHeightMove(e: MouseEvent) {
  if (!isResizingHeight) return;
  // 用户开始拖 → 退出自适应,锁定像素高度
  if (autoHeights.value[heightCardId]) {
    autoHeights.value[heightCardId] = false;
  }
  const newH = heightStartH + (e.clientY - heightStartY);
  const clamped = Math.max(CARD_MIN, Math.min(CARD_MAX, newH));
  cardHeights.value[heightCardId] = clamped;
}

function onHeightUp() {
  if (isResizingHeight) {
    isResizingHeight = false;
    heightCardId = "";
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    saveSettings();
  }
}

// 双击拖拽条 → 恢复自适应内容高度
function onHandleDblClick(id: string) {
  if (collapsed.value[id]) return;
  autoHeights.value[id] = true;
  saveSettings();
}


// 锁定高度装不下内容自然高度时恢复自适应(内容后来变高了,旧锁定值已过时)。
// "锁定 + 内容溢出滚动"场景下,内部滚动区里的按钮真实点击会不可靠地
// 不触发(实测:手动 click 正常、真实点击失效),所以从根上不让该场景存在
function ensureHeightFits(id: string) {
  if (collapsed.value[id] || autoHeights.value[id]) return;
  const slot = document.getElementById(`slot-${id}`);
  const slotBody = slot?.querySelector<HTMLElement>(".slot-body");
  if (!slotBody) return;
  const need = slotBody.scrollHeight + CARD_COLLAPSED + 24;
  if (cardHeights.value[id] < need - 40) {
    autoHeights.value[id] = true;
  }
}

// ===== 卡片折叠切换 =====
function toggleCollapse(id: string) {
  collapsed.value[id] = !collapsed.value[id];
  // 展开时:必须等 v-show 渲染完(nextTick)再量,否则量到的是折叠态高度
  if (!collapsed.value[id] && !autoHeights.value[id]) {
    void nextTick(() => ensureHeightFits(id));
  }
  saveSettings();
}

// 内容高度变化(高级区开合、提示出现等)后复查:锁定值装不下就恢复自适应
const CARD_IDS = ["python", "gerber", "config", "screw", "stencil"] as const;
let contentObserver: ResizeObserver | null = null;

function observeCardContent(id: string) {
  const slot = document.getElementById(`slot-${id}`);
  const slotBody = slot?.querySelector<HTMLElement>(".slot-body");
  if (!slotBody) return;
  contentObserver?.observe(slotBody);
  // 锁定高度时 slot-body 尺寸被夹死,内容增长它自己不变大,
  // 必须观察内容根元素(高级区开合/提示出现时它会实际变高)
  const contentRoot = slotBody.firstElementChild as HTMLElement | null;
  if (contentRoot) contentObserver?.observe(contentRoot);
}

// 卡片高度:折叠=固定条高;自适应=内容自然高度;手动拖过=锁定像素
function slotBodyHeight(id: string): number | undefined {
  if (autoHeights.value[id]) return undefined;
  return Math.max(0, cardHeights.value[id] - CARD_COLLAPSED - 2);
}

// Mode-specific forms are mounted after a mode change, so observe their new
// content too (including advanced sections growing during a transition).
watch(appMode, async () => {
  importGuideSequence++;
  await nextTick();
  contentObserver?.disconnect();
  for (const id of CARD_IDS) observeCardContent(id);
});

async function onGerberLoaded(
  payload: GerberImportPayload & { mode: PanelMode }
) {
  configStore.applyGerberImport(payload);
  const sequence = ++importGuideSequence;
  if (appMode.value !== "jig") return;
  sidebarAnimating.value = true;
  sidebarHidden.value = false;
  collapsed.value.config = false;
  autoHeights.value.config = true;
  saveSettings();
  await nextTick();
  // Wait for the sidebar/card to open before measuring the target position.
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  const animations = sidebarShell.value?.getAnimations({ subtree: true }) ?? [];
  await Promise.allSettled(animations
    .filter((animation) => Number.isFinite(animation.effect?.getComputedTiming().endTime))
    .map((animation) => animation.finished));
  if (sequence !== importGuideSequence || appMode.value !== "jig" || sidebarHidden.value || collapsed.value.config) return;
  await configFormRef.value?.revealStencilSize();
}

onMounted(() => {
  configStore.detectPython();
  if (!ui.onboardingSeen) void startTour();
  window.addEventListener("resize", updateViewportWidth);
  document.addEventListener("mousemove", onWidthMove);
  document.addEventListener("mouseup", onWidthUp);
  document.addEventListener("mousemove", onHeightMove);
  document.addEventListener("mouseup", onHeightUp);
  window.addEventListener("pointerup", configStore.endParameterInteraction);
  window.addEventListener("pointercancel", configStore.endParameterInteraction);
  window.addEventListener("blur", configStore.endParameterInteraction);
  // 内容高度变化复查(等首帧渲染完再挂,避免初始布局抖动误判)
  void nextTick(() => {
    contentObserver = new ResizeObserver(() => {
      for (const id of CARD_IDS) ensureHeightFits(id);
    });
    for (const id of CARD_IDS) observeCardContent(id);
  });
});

onBeforeUnmount(() => {
  appDisposed = true;
  importGuideSequence++;
  window.removeEventListener("resize", updateViewportWidth);
  document.removeEventListener("mousemove", onWidthMove);
  document.removeEventListener("mouseup", onWidthUp);
  document.removeEventListener("mousemove", onHeightMove);
  document.removeEventListener("mouseup", onHeightUp);
  window.removeEventListener("pointerup", configStore.endParameterInteraction);
  window.removeEventListener("pointercancel", configStore.endParameterInteraction);
  window.removeEventListener("blur", configStore.endParameterInteraction);
  contentObserver?.disconnect();
  contentObserver = null;
});
</script>

<template>
  <el-config-provider :locale="epLocale">
  <div class="app-shell">
    <header class="app-header" data-tauri-drag-region @dblclick="onHeaderDblClick">
      <div class="header-brand" data-tauri-drag-region>
        <!-- Logo:B1 竖向蛇形砖墙(走线 = 砖墙灰缝 · 起绿终橙) -->
        <svg class="brand-mark" viewBox="0 0 64 64" aria-hidden="true" data-tauri-drag-region>
          <path d="M14 14 L50 14 L50 26 L26 26 L26 38 L50 38 L50 50 L14 50" fill="none" stroke="var(--bg-brand)" stroke-width="6" stroke-linecap="round" stroke-linejoin="round" />
          <circle cx="14" cy="14" r="5" fill="var(--bg-brand)" />
          <circle cx="14" cy="50" r="5" fill="var(--brand-accent)" />
        </svg>
        <div class="header-titles" data-tauri-drag-region>
          <h1 data-tauri-drag-region>{{ t('app.title') }}</h1>
          <span class="subtitle" :key="appMode" data-tauri-drag-region>
            {{ appMode === 'stencil' ? t('app.subtitleStencil') : t('app.subtitleJig') }}
          </span>
        </div>
        <!-- 模式切换 -->
        <div class="mode-switch">
          <div class="mode-indicator" :class="{ 'pos-jig': appMode === 'jig', 'pos-stencil': appMode === 'stencil' }" aria-hidden="true" />
          <button
            class="mode-btn"
            :class="{ active: appMode === 'jig' }"
            @click="switchMode('jig')"
          >
            <svg class="mode-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <rect x="2" y="2" width="12" height="12" rx="2" stroke="currentColor" stroke-width="1.6"/>
              <path d="M5 5h6v3H8.5L7 9.5v1.5H5z" fill="currentColor"/>
            </svg>
            {{ t('mode.jig') }}
          </button>
          <button
            class="mode-btn"
            :class="{ active: appMode === 'stencil' }"
            @click="switchMode('stencil')"
          >
            <svg class="mode-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <rect x="2" y="2" width="12" height="12" rx="1" stroke="currentColor" stroke-width="1.6"/>
              <circle cx="5.5" cy="5.5" r="1" fill="currentColor"/>
              <circle cx="10.5" cy="5.5" r="1" fill="currentColor"/>
              <circle cx="5.5" cy="10.5" r="1" fill="currentColor"/>
              <circle cx="10.5" cy="10.5" r="1" fill="currentColor"/>
            </svg>
            {{ t('mode.stencil') }}
          </button>
        </div>
      </div>
      <div class="spacer" data-tauri-drag-region />
      <HistoryControls />
      <ProjectMenu />
      <SettingsMenu @start-tour="startTour" />

      <!-- 窗口控制(与页眉融合,替代系统标题栏) -->
      <div class="window-controls">
        <button
          class="win-btn"
          :title="t('win.minimize')"
          @click="appWindow.minimize()"
        >
          <svg viewBox="0 0 10 10" width="10" height="10">
            <path d="M1 5h8" stroke="currentColor" stroke-width="1" />
          </svg>
        </button>
        <button
          class="win-btn"
          :title="isMaximized ? t('win.restore') : t('win.maximize')"
          @click="appWindow.toggleMaximize()"
        >
          <svg v-if="isMaximized" viewBox="0 0 10 10" width="10" height="10">
            <rect x="1.5" y="3.5" width="5" height="5" fill="none" stroke="currentColor" stroke-width="1" />
            <path d="M3.5 3.5V1.5h5v5h-2" fill="none" stroke="currentColor" stroke-width="1" />
          </svg>
          <svg v-else viewBox="0 0 10 10" width="10" height="10">
            <rect x="1.5" y="1.5" width="7" height="7" fill="none" stroke="currentColor" stroke-width="1" />
          </svg>
        </button>
        <button
          class="win-btn win-close"
          :title="t('win.close')"
          @click="appWindow.close()"
        >
          <svg viewBox="0 0 10 10" width="10" height="10">
            <path d="M1.5 1.5l7 7M8.5 1.5l-7 7" stroke="currentColor" stroke-width="1" />
          </svg>
        </button>
      </div>
    </header>

    <main class="app-main" :class="{ 'is-sidebar-hidden': sidebarHidden }"
      :style="{ '--preview-inset': (sidebarHidden ? 0 : visibleSidebarWidth + 5) + 'px' }">
      <div ref="sidebarShell" class="sidebar-shell" :class="{ 'is-animating': sidebarAnimating, 'is-hidden': sidebarHidden }"
        :style="{ width: (visibleSidebarWidth + 5) + 'px' }"
        :inert="sidebarHidden" :aria-hidden="sidebarHidden">
      <aside id="parameters-sidebar" class="app-sidebar" :aria-label="t('layout.parameters')"
        @pointerdown.capture="configStore.beginParameterInteraction()"
        :style="{ width: visibleSidebarWidth + 'px' }">
        <ConfigPresets />
        <!-- Python Environment -->
        <div id="slot-python" class="card-slot">
          <button class="slot-header" :aria-expanded="!collapsed.python" aria-controls="body-python" @click="toggleCollapse('python')">
            <div class="slot-label">
              <span class="slot-step-dot" data-icon="py" :class="{ 'is-done': configStore.pythonDetected }">Py</span>
              <span class="slot-title">{{ t('cards.python') }}</span>
            </div>
            <div class="slot-meta">
              <span
                class="status-badge"
                :class="configStore.pythonDetected ? 'is-ok' : configStore.pythonPath ? 'is-warn' : 'is-err'"
              >
                {{ configStore.pythonDetected ? t('cards.configured') : configStore.pythonPath ? t('cards.depsMissing') : t('cards.notDetected') }}
              </span>
              <svg class="chevron" :class="{ 'is-collapsed': collapsed.python }" viewBox="0 0 16 16" width="16" height="16">
                <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            </div>
          </button>
          <MotionCollapse id="body-python" :open="!collapsed.python" :height="slotBodyHeight('python')">
          <div class="slot-body">
            <PythonSetup />
          </div>
          <div
            class="drag-handle"
            title="拖动调整高度,双击恢复自适应"
            @mousedown="onHeightDown('python', $event)"
            @dblclick="onHandleDblClick('python')"
          />
          </MotionCollapse>
        </div>

        <!-- Gerber Import (两种模式共用) -->
        <div id="slot-gerber" class="card-slot">
          <button class="slot-header" :aria-expanded="!collapsed.gerber" aria-controls="body-gerber" @click="toggleCollapse('gerber')">
            <div class="slot-label">
              <span class="slot-step-dot" data-step="1" :class="{ 'is-done': gerberDone }">{{ gerberDone ? '✓' : '1' }}</span>
              <span class="slot-title">{{ appMode === 'stencil' ? t('stencil.import') : t('cards.gerber') }}</span>
            </div>
            <svg class="chevron" :class="{ 'is-collapsed': collapsed.gerber }" viewBox="0 0 16 16" width="16" height="16">
              <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </button>
          <MotionCollapse id="body-gerber" :open="!collapsed.gerber" :height="slotBodyHeight('gerber')">
          <div class="slot-body">
            <GerberImport :mode="appMode" @gerber-loaded="onGerberLoaded" />
          </div>
          <div
            class="drag-handle"
            title="拖动调整高度,双击恢复自适应"
            @mousedown="onHeightDown('gerber', $event)"
            @dblclick="onHandleDblClick('gerber')"
          />
          </MotionCollapse>
        </div>

        <!-- Gerber Import (jig mode) -->
        <template v-if="appMode === 'jig'">

        <!-- Config Form -->
        <div id="slot-config" class="card-slot mode-card">
          <button class="slot-header" :aria-expanded="!collapsed.config" aria-controls="body-config" @click="toggleCollapse('config')">
            <div class="slot-label">
              <span class="slot-step-dot" data-step="2">2</span>
              <span class="slot-title">{{ t('cards.config') }}</span>
            </div>
            <svg class="chevron" :class="{ 'is-collapsed': collapsed.config }" viewBox="0 0 16 16" width="16" height="16">
              <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </button>
          <MotionCollapse id="body-config" :open="!collapsed.config" :height="slotBodyHeight('config')">
          <div class="slot-body">
            <ConfigForm ref="configFormRef" />
          </div>
          <div
            class="drag-handle"
            title="拖动调整高度,双击恢复自适应"
            @mousedown="onHeightDown('config', $event)"
            @dblclick="onHandleDblClick('config')"
          />
          </MotionCollapse>
        </div>

        <!-- Screw Diagram -->
        <div id="slot-screw" class="card-slot mode-card">
          <button class="slot-header" :aria-expanded="!collapsed.screw" aria-controls="body-screw" @click="toggleCollapse('screw')">
            <div class="slot-label">
              <span class="slot-step-dot" data-step="3">3</span>
              <span class="slot-title">{{ t('cards.screw') }}</span>
            </div>
            <svg class="chevron" :class="{ 'is-collapsed': collapsed.screw }" viewBox="0 0 16 16" width="16" height="16">
              <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </button>
          <MotionCollapse id="body-screw" :open="!collapsed.screw" :height="slotBodyHeight('screw')">
          <div class="slot-body">
            <ScrewDiagram />
          </div>
          <div
            class="drag-handle"
            title="拖动调整高度,双击恢复自适应"
            @mousedown="onHeightDown('screw', $event)"
            @dblclick="onHandleDblClick('screw')"
          />
          </MotionCollapse>
        </div>
        </template>

        <!-- Stencil Card (stencil mode) -->
        <template v-if="appMode === 'stencil'">
        <div id="slot-stencil" class="card-slot mode-card">
          <button class="slot-header" :aria-expanded="!collapsed.stencil" aria-controls="body-stencil" @click="toggleCollapse('stencil')">
            <div class="slot-label">
              <span class="slot-step-dot" data-step="1">1</span>
              <span class="slot-title">{{ t('cards.stencil') }}</span>
            </div>
            <svg class="chevron" :class="{ 'is-collapsed': collapsed.stencil }" viewBox="0 0 16 16" width="16" height="16">
              <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </button>
          <MotionCollapse id="body-stencil" :open="!collapsed.stencil" :height="slotBodyHeight('stencil')">
          <div class="slot-body">
            <StencilForm />
          </div>
          <div
            class="drag-handle"
            title="拖动调整高度,双击恢复自适应"
            @mousedown="onHeightDown('stencil', $event)"
            @dblclick="onHandleDblClick('stencil')"
          />
          </MotionCollapse>
        </div>
        </template>
      </aside>

      <div
        class="sidebar-resizer"
        @mousedown="onWidthDown"
        @dblclick="resetSidebarWidth"
        title="拖动调整侧栏宽度,双击重置"
      />
      </div>

      <button class="sidebar-toggle" :class="{ 'is-animating': sidebarAnimating, 'is-hidden': sidebarHidden }"
        :title="sidebarHidden ? t('layout.expandSidebar') : t('layout.collapseSidebar')"
        :aria-label="sidebarHidden ? t('layout.expandSidebar') : t('layout.collapseSidebar')"
        :aria-expanded="!sidebarHidden" aria-controls="parameters-sidebar" @click="toggleSidebar">
        <svg viewBox="0 0 20 20" width="20" height="20" fill="none" aria-hidden="true">
          <path class="sidebar-toggle-arrow" d="m11.5 6-4 4 4 4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>

      <section class="app-preview">
        <ModelPreview :class="{ 'is-layout-animating': sidebarAnimating }" />
      </section>
    </main>
    <OnboardingTour v-if="tourOpen" :mode="appMode" @close="finishTour" />
  </div>
  </el-config-provider>
</template>

<style scoped>
.app-shell {
  display: flex;
  flex-direction: column;
  height: 100vh;
  width: 100vw;
  background: var(--bg-base-secondary);
}

/* ===== Header ===== */
/* Keep the mode switch and history actions clear at smaller window widths. */
@media (max-width: 1400px) {
  .app-header :deep(.project-menu__filename) { display: none; }
}

.app-header {
  flex: 0 0 auto;
  height: 56px;
  padding: 0 0 0 24px;
  background: var(--bg-base-default);
  border-bottom: 1px solid var(--border-neutral-l1);
  display: flex;
  align-items: center;
  gap: 16px;
  user-select: none;
  position: relative;
  box-shadow: 0 1px 0 var(--surface-highlight);
  z-index: 6;
}

/* ===== 窗口控制(融合标题栏) ===== */
.window-controls {
  display: flex;
  align-items: stretch;
  margin-left: auto;
  align-self: stretch;
}

.sidebar-toggle {
  position: absolute;
  left: 0;
  transform: translateX(var(--preview-inset));
  top: 72px;
  z-index: 5;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 44px;
  padding: 0;
  border: 1px solid var(--border-neutral-l1);
  border-left: none;
  border-radius: 0 12px 12px 0;
  corner-shape: var(--corner-shape);
  color: var(--text-tertiary);
  background: var(--bg-base-default);
  box-shadow: 2px 1px 5px rgba(0, 0, 0, .04);
  cursor: pointer;
  transition: background-color var(--motion-fast), border-color var(--motion-fast), color var(--motion-fast);
}
.sidebar-toggle.is-animating { transition: transform var(--sidebar-duration) var(--sidebar-ease), background-color var(--motion-fast), border-color var(--motion-fast), color var(--motion-fast); }
.sidebar-toggle:hover, .sidebar-toggle:focus-visible { background: var(--status-success-surface-l1); border-color: var(--bg-brand); color: var(--bg-brand); }
.sidebar-toggle:focus-visible { outline: 2px solid var(--bg-brand); outline-offset: 2px; }
.sidebar-toggle:active svg { scale: .94; }
.sidebar-toggle-arrow { transform-origin: 10px 10px; transition: transform var(--motion-panel) var(--ease-out); }
.sidebar-toggle.is-hidden .sidebar-toggle-arrow { transform: rotate(180deg); }

.win-btn {
  width: 46px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  transition: background-color 0.12s ease, color 0.12s ease;
}

.win-btn:hover {
  background: var(--bg-overlay-l2);
  color: var(--text-default);
}

.win-btn:active {
  background: var(--bg-overlay-l3);
}

.win-btn.win-close:hover {
  background: #E8463A;
  color: #FFFFFF;
}

.win-btn.win-close:active {
  background: #C9382F;
  color: #FFFFFF;
}

.header-brand {
  display: flex;
  align-items: center;
  gap: 12px;
  /* mode-switch 已用绝对定位脱离 flex 流;这里 max-width 控制不要撞到 mode-switch */
  max-width: 300px;
  min-width: 0;
  flex-shrink: 1;
}

.brand-mark {
  width: 28px;
  height: 28px;
  flex-shrink: 0;
  background: var(--status-success-surface-l1);
  border-radius: var(--radius-control);
  corner-shape: var(--corner-shape);
  box-shadow: 0 0 0 4px var(--status-success-surface-l1);
}

.header-titles {
  display: flex;
  flex-direction: column;
  gap: 0;
  min-width: 0;
  overflow: hidden;
}

.app-header h1 {
  font-size: 15px;
  font-weight: var(--font-weight-strong);
  line-height: 22px;
  margin: 0;
  color: var(--text-default);
  letter-spacing: -0.035em;
}

.subtitle {
  font-size: 11px;
  line-height: 16px;
  color: var(--text-tertiary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  animation: subtitleFadeIn 0.28s cubic-bezier(0.4, 0, 0.2, 1);
}
@keyframes subtitleFadeIn {
  from { opacity: 0; transform: translateY(-2px); }
  to   { opacity: 1; transform: translateY(0); }
}

.mode-switch {
  position: absolute;
  left: 380px;
  top: 50%;
  transform: translateY(-50%);
  z-index: 1;
  display: inline-grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  background: var(--surface-well);
  border: 1px solid var(--surface-line);
  border-radius: var(--radius-full);
  padding: 3px;
  gap: 0;
  /* 关键:模式按钮不允许被挤压消失 */
  flex-shrink: 0;
  box-shadow: none;
}
/* 滑动指示器:宽度 = 容器宽度的一半,根据 active 状态左右平移 */
.mode-switch .mode-indicator {
  position: absolute;
  top: 3px;
  left: 3px;
  width: calc(50% - 3px);
  height: calc(100% - 6px);
  border-radius: var(--radius-full);
  background: var(--surface-selected);
  box-shadow: var(--shadow-control);
  transition: transform 340ms var(--ease-out);
  pointer-events: none;
}
.mode-switch .mode-indicator.pos-stencil {
  transform: translateX(100%);
}
.mode-btn {
  position: relative;
  z-index: 1;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font-size: 13px;
  font-weight: 600;
  padding: 8px 18px;
  border-radius: var(--radius-full);
  cursor: pointer;
  transition: var(--control-transition);
  line-height: 1;
}
.mode-btn .mode-icon {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
}
.mode-btn:hover:not(.active) {
  color: var(--brand-500);
}
.mode-btn.active {
  color: var(--text-brand);
}
.spacer {
  flex: 1 1 auto;
}

/* ===== Main Layout ===== */
.app-main {
  /* Animate composited layers; the 3D canvas keeps its full-workspace size. */
  --sidebar-duration: 420ms;
  --sidebar-ease: cubic-bezier(.25, .1, .2, 1);
  position: relative;
  flex: 1 1 auto;
  display: flex;
  overflow: hidden;
}
.app-main.is-sidebar-hidden { --sidebar-duration: 380ms; }

/* ===== Sidebar ===== */
.sidebar-shell {
  position: absolute;
  left: 0;
  top: 0;
  z-index: 2;
  transform: translateX(0);
  background: var(--bg-base-default);
  min-width: 0;
  height: 100%;
  overflow: hidden;
}
.sidebar-shell.is-animating { transition: transform var(--sidebar-duration) var(--sidebar-ease), width var(--sidebar-duration) var(--sidebar-ease); }
.sidebar-shell.is-hidden { transform: translateX(-100%); pointer-events: none; }

.app-sidebar {
  flex: 0 0 auto;
  background: var(--surface-sidebar);
  border-right: 1px solid var(--surface-line);
  overflow-y: auto;
  overflow-x: hidden;
  padding: 14px 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  height: 100%;
  scrollbar-gutter: stable;
}

/* ===== Card Slots ===== */
.card-slot {
  position: relative;
  border: 1px solid var(--surface-line);
  border-radius: var(--radius-panel);
  corner-shape: var(--corner-shape);
  background: var(--surface-raised);
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-shadow: var(--shadow-card);
  transition: border-color var(--motion-fast) var(--ease-out), box-shadow 200ms var(--ease-out);
}
.card-slot:hover { border-color: color-mix(in srgb, var(--text-tertiary) 15%, var(--surface-line)); }
.card-slot:focus-within { border-color: color-mix(in srgb, var(--bg-brand) 24%, var(--surface-line)); }
.mode-card { animation: panel-arrive 300ms var(--ease-out) both; }
#slot-screw.mode-card { animation-delay: 35ms; }
@keyframes panel-arrive { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }

/* Slot Header */
.slot-header {
  width: 100%;
  border: none;
  text-align: left;
  font-family: inherit;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 0 12px;
  height: 44px;
  background: var(--surface-card-heading);
  border-bottom: 1px solid transparent;
  cursor: pointer;
  user-select: none;
  transition: background-color var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out);
  flex: 0 0 auto;
}

.slot-header:hover {
  color: var(--text-brand);
  background: color-mix(in srgb, var(--surface-well) 55%, var(--surface-raised));
}
.slot-header::after { content: ''; position: absolute; left: 16px; right: 16px; top: 43px; height: 1px; background: var(--surface-line); opacity: .45; pointer-events: none; transition: opacity var(--motion-fast) var(--ease-out); }
.slot-header[aria-expanded="false"]::after { opacity: 0; }
.slot-header:hover .slot-title { color: var(--text-brand); }

.slot-label {
  display: flex;
  align-items: center;
  gap: 8px;
}

.slot-step-dot {
  width: 20px;
  height: 20px;
  border-radius: var(--radius-inner);
  corner-shape: var(--corner-shape);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  font-weight: var(--font-weight-strong);
  line-height: 1;
  background: var(--bg-overlay-l2);
  color: var(--text-secondary);
  flex-shrink: 0;
}

.slot-step-dot[data-step] {
  background: var(--status-success-surface-l1);
  color: var(--text-brand);
  box-shadow: none;
}

/* 完成态:导入成功/环境就绪后,步骤圆点变成功绿(数字换成 ✓) */
.slot-step-dot.is-done {
  background: var(--status-success-default);
  color: var(--text-onbrand);
}

.slot-step-dot[data-icon="py"] {
  font-size: 9px;
}

.slot-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-default);
  letter-spacing: 0;
  transition: color 180ms ease;
}

.slot-meta {
  display: flex;
  align-items: center;
  gap: 8px;
}

.status-badge {
  font-size: 11px;
  font-weight: var(--font-weight-medium);
  line-height: 16px;
  padding: 1px 6px;
  border-radius: var(--radius-4);
}

.status-badge.is-ok {
  background: var(--status-success-surface-l1);
  color: var(--status-success-default);
}

.status-badge.is-warn {
  background: var(--status-warning-surface-l1);
  color: var(--status-warning-default);
}

.status-badge.is-err {
  background: var(--status-error-surface-l1);
  color: var(--status-error-default);
}

.chevron {
  color: var(--text-tertiary);
  flex-shrink: 0;
  transition: transform var(--motion-panel) var(--ease-out);
}

.chevron.is-collapsed {
  transform: rotate(-90deg);
}

/* Slot Body */
.slot-body {
  flex: 1 1 auto;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

/* Remove nested el-card borders — we already have the slot border */
.slot-body :deep(.el-card) {
  height: 100%;
  display: flex;
  flex-direction: column;
  border: none !important;
  border-radius: 0 !important;
  background: transparent;
  margin: 0;
}

.slot-body :deep(.el-card__header) {
  display: none;
}

.slot-body :deep(.el-card__body) {
  flex: 1 1 auto;
  overflow-y: auto;
  padding: 16px;
}

/* Drag Handle */
.drag-handle {
  height: 6px;
  background: transparent;
  border-top: 1px solid transparent;
  cursor: ns-resize;
  flex: 0 0 auto;
  transition: background-color 0.12s ease;
  position: relative;
}

.drag-handle:hover {
  background: var(--bg-overlay-l2);
}

.drag-handle::after {
  opacity: .35;
  transition: opacity var(--motion-fast), background-color var(--motion-fast);
  content: '';
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 24px;
  height: 2px;
  border-radius: 1px;
  background: var(--border-neutral-l2);
}

.drag-handle:hover::after {
  opacity: 1;
  background: var(--text-tertiary);
}

/* Sidebar Resizer */
.sidebar-resizer {
  width: 5px;
  background: transparent;
  cursor: col-resize;
  position: absolute;
  right: 0;
  top: 0;
  bottom: 0;
  transition: background-color 0.15s ease;
}

.sidebar-resizer:hover {
  background: var(--bg-overlay-l2);
}

.sidebar-resizer:active {
  background: var(--bg-overlay-l3);
}

/* Preview Area */
.app-preview {
  flex: 1 1 auto;
  background: var(--bg-base-secondary);
  overflow: hidden;
  min-width: 0;
}

</style>
