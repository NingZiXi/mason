<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from "vue";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { useI18n } from "vue-i18n";
import { useGerberOutline } from "../composables/useGerberOutline";
import { useGerberStencil, type GerberStencilResult } from "../composables/useGerberStencil";
import type { PanelMode, PanelVariant } from "../lib/gerber/panel";
import { useConfigStore } from "../stores/config";

const props = withDefaults(defineProps<{
  mode?: "jig" | "stencil";
}>(), { mode: "jig" });

const { t } = useI18n();
const configStore = useConfigStore();

/** 一次导入的完整结果:整版 / 单板两套口径一起交给 store */
export interface GerberImportPayload {
  filename: string;
  isPanel: boolean;
  panelGrid?: { nx: number; ny: number };
  hasPads: boolean;
  variants: { panel: PanelVariant; single: PanelVariant };
}

const emit = defineEmits<{
  (e: "gerberLoaded", payload: GerberImportPayload & { mode: PanelMode }): void;
}>();

const outline = useGerberOutline();
const stencil = useGerberStencil();

const loading = computed(() => (props.mode === "stencil" ? stencil.loading.value : outline.loading.value));
const error = computed(() => (props.mode === "stencil" ? stencil.error.value : outline.error.value));
const hasResult = computed(() => (props.mode === "stencil" ? stencil.hasResult.value : outline.hasResult.value));
const candidates = computed(() => (props.mode === "stencil" ? [] : outline.candidates.value));

// ===== 拼版口径选择 =====
/** 最近一次解析出的结果(用于预览按当前口径渲染) */
const payload = ref<GerberImportPayload | null>(null);
/** 当前生效口径:以 store 为唯一来源,设置面板切换后这里同步跟随 */
const activeMode = computed(() => configStore.config.panelMode);
/** 拼版文件导入时弹窗,让用户先选整版还是单板 */
const showPanelDialog = ref(false);

/** 统一显示用的结果 */
interface DisplayResult {
  width: number;
  height: number;
  filename: string;
  outlinePoints: Array<[number, number]>;
  holes: Array<Array<[number, number]>>;
  topPadCount?: number;
  bottomPadCount?: number;
  skipped?: number;
  isPanel?: boolean;
  panelGrid?: { nx: number; ny: number };
  units?: string | null;
  arcs?: number;
}
const display = computed<DisplayResult | null>(() => {
  const p = payload.value;
  if (!p) return null;
  const v = p.variants[activeMode.value];
  const o = outline.result.value;
  const s = stencil.result.value;
  return {
    width: v.width,
    height: v.height,
    filename: p.filename,
    outlinePoints: v.outlinePoints,
    holes: v.outlineHoles,
    topPadCount: v.topPads?.length,
    bottomPadCount: v.bottomPads?.length,
    skipped: s?.skipped,
    isPanel: p.isPanel,
    panelGrid: p.panelGrid,
    units: props.mode === "stencil" ? undefined : o?.bbox.units ?? null,
    arcs: o?.parse.arcsLinearized,
  };
});

const fileInput = ref<HTMLInputElement | null>(null);
const dragOver = ref(false);

function pickFile() {
  fileInput.value?.click();
}

/**
 * 解析结果 → 交给 store。
 * 拼版文件先弹窗让用户选口径(整版 / 单板),非拼版直接用整版口径。
 */
function submit(p: GerberImportPayload) {
  payload.value = p;
  if (p.isPanel) {
    // 拼版文件:先弹窗让用户选口径(默认沿用上次选择)
    showPanelDialog.value = true;
    return;
  }
  emit("gerberLoaded", { ...p, mode: "panel" });
}

/** 弹窗选择完成:按选中口径应用 */
function confirmPanelMode(mode: PanelMode) {
  showPanelDialog.value = false;
  const p = payload.value;
  if (p) emit("gerberLoaded", { ...p, mode });
}

/**
 * 统一入口:按当前模式解析,并把结果同步到另一模式的数据源 ——
 * 治具模式导入 ZIP 时顺带解析锡膏层焊盘(best-effort,无锡膏层静默跳过),
 * 切到钢网模式后无需重复导入即可看到带开孔的钢网;
 * 钢网模式的板框已含在结果里(会写 pcbOutlinePoints),切回治具模式天然可用。
 */
async function processFile(file: File) {
  if (props.mode === "stencil") {
    await stencil.processFile(file);
    const r = stencil.result.value;
    if (r) {
      submit({
        filename: [r.topPasteFile, r.bottomPasteFile].filter(Boolean).join(" + "),
        isPanel: r.isPanel,
        panelGrid: r.panelGrid,
        hasPads: true,
        variants: r.variants,
      });
    }
    return;
  }

  await outline.processFile(file);
  const o = outline.result.value;
  if (!o) return;

  // 治具模式:同一文件再跑一遍锡膏解析,拿到焊盘;纯板框文件则静默跳过
  let pads: { variants: GerberStencilResult["variants"] } | null = null;
  try {
    await stencil.processFile(file);
    const s = stencil.result.value;
    if (s) pads = { variants: s.variants };
    else stencil.reset();
  } catch {
    stencil.reset();
  }

  submit({
    filename: o.filename,
    isPanel: o.parse.isPanel,
    panelGrid: o.parse.panelGrid,
    hasPads: pads !== null,
    variants: pads?.variants ?? o.variants,
  });
}

async function onFileChange(e: Event) {
  const target = e.target as HTMLInputElement;
  const file = target.files?.[0];
  if (!file) return;
  await processFile(file);
  target.value = "";
}

async function onDrop(e: DragEvent) {
  e.preventDefault();
  dragOver.value = false;
  const file = e.dataTransfer?.files?.[0];
  if (!file) return;
  await processFile(file);
}

function onDragOver(e: DragEvent) {
  e.preventDefault();
  dragOver.value = true;
}

function onDragLeave() {
  dragOver.value = false;
}

// 处理 Tauri 拖入的文件路径 — 调用 Rust 读取字节
async function processDroppedPaths(paths: string[]) {
  if (!paths || paths.length === 0) return;
  const path = paths[0];
  const fileName = path.split(/[/\\]/).pop() || path;

  try {
    const bytes = await invoke<number[]>("read_dropped_file", { path });
    const u8 = new Uint8Array(bytes);
    const file = new File([u8], fileName, {
      type: fileName.toLowerCase().endsWith(".zip")
        ? "application/zip"
        : "text/plain",
    });
    await processFile(file);
  } catch (err) {
    console.error("读取拖入文件失败:", err);
  }
}

// Tauri 2 原生文件拖拽事件
let unlistenDrop: (() => void) | null = null;
let unlistenEnter: (() => void) | null = null;
let unlistenLeave: (() => void) | null = null;

onMounted(async () => {
  try {
    unlistenDrop = await listen<{ paths: string[] }>(
      "tauri://drag-drop",
      (e) => processDroppedPaths(e.payload.paths)
    );
    unlistenEnter = await listen("tauri://drag-enter", () => {
      dragOver.value = true;
    });
    unlistenLeave = await listen("tauri://drag-leave", () => {
      dragOver.value = false;
    });
  } catch (err) {
    console.warn("Tauri drag-drop event listener failed:", err);
  }
});

onBeforeUnmount(() => {
  unlistenDrop?.();
  unlistenEnter?.();
  unlistenLeave?.();
});

function clear() {
  if (props.mode === "stencil") stencil.reset();
  else outline.reset();
  payload.value = null;
  configStore.clearPanelScope();
}

function fmt(n: number): string {
  return n.toFixed(2);
}

const acceptAttr = computed(() =>
  props.mode === "stencil" ? ".zip,.gtp,.gbp,.gbr" : ".zip,.gko,.gm1,.gbr"
);

/** SVG path:外框 + 内孔子路径,配合 fill-rule=evenodd 显示挖孔 */
const outlinePath = computed(() => {
  if (!display.value) return "";
  const toSub = (pts: Array<[number, number]>) =>
    pts.map((p) => `${p[0]},${p[1]}`).join(" ");
  return [toSub(display.value.outlinePoints), ...display.value.holes.map(toSub)].join(" ");
});
</script>

<template>
  <div class="gerber-import">
    <input
      ref="fileInput"
      type="file"
      :accept="acceptAttr"
      style="display: none"
      @change="onFileChange"
    />

    <!-- Dropzone -->
    <div
      v-if="!hasResult"
      class="dropzone"
      :class="{ active: loading || dragOver }"
      @click="pickFile"
      @dragover="onDragOver"
      @dragleave="onDragLeave"
      @drop="onDrop"
    >
      <svg class="drop-icon" viewBox="0 0 24 24" width="28" height="28">
        <path d="M12 3v12m0-12l-4 4m4-4l4 4M5 15v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4"
          fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
      <p v-if="!loading" class="drop-text">{{ t('gerber.drop') }}</p>
      <p v-else class="drop-text">{{ t('gerber.parsing') }}</p>
      <p class="drop-hint">{{ t('gerber.dropHint') }}</p>
    </div>

    <!-- Error -->
    <el-alert v-if="error" type="error" :closable="false" class="error-alert">
      {{ error }}
    </el-alert>

    <!-- Result -->
    <div v-if="display" class="result">
      <div class="result-header">
        <svg viewBox="0 0 16 16" width="16" height="16" class="check-icon">
          <path d="M3 8.5l3.5 3.5L13 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        <span class="result-title">{{ t('gerber.recognized') }}</span>
      </div>

      <!-- SVG Preview -->
      <svg
        v-if="display.outlinePoints.length > 0"
        class="outline-preview"
        :viewBox="`${-display.width / 2 - 2} ${-display.height / 2 - 2} ${display.width + 4} ${display.height + 4}`"
        preserveAspectRatio="xMidYMid meet"
      >
        <g transform="scale(1, -1)">
          <polygon
            :points="outlinePath"
            fill-rule="evenodd"
            fill="rgba(62,125,98,0.10)"
            stroke="#3E7D62"
            stroke-width="0.3"
          />
        </g>
        <line
          :x1="-display.width/2" :y1="0"
          :x2="display.width/2" :y2="0"
          stroke="rgba(115,115,115,0.36)" stroke-width="0.2" stroke-dasharray="2,2"
        />
        <text
          :x="display.width/2 + 2" y="3"
          font-size="3"
          fill="rgba(115,115,115,0.5)"
          font-family="JetBrains Mono, monospace"
        >
          {{ fmt(display.width) }}×{{ fmt(display.height) }} mm
        </text>
      </svg>

      <!-- Info -->
      <div class="info-grid">
        <div class="info-row">
          <span class="info-label">{{ t('gerber.outlineFile') }}</span>
          <span class="info-value" :title="display.filename">{{ display.filename }}</span>
        </div>
        <div class="info-row">
          <span class="info-label">{{ t('gerber.pcbSize') }}</span>
          <span class="info-value">{{ fmt(display.width) }} × {{ fmt(display.height) }} mm</span>
        </div>
        <div v-if="display.isPanel" class="info-row">
          <span class="info-label">{{ t('gerber.panel') }}</span>
          <span class="info-value">
            {{ display.panelGrid ? t('gerber.panelGrid', display.panelGrid) : t('gerber.panelDetected') }}
          </span>
        </div>
        <div v-if="display.isPanel" class="info-row">
          <span class="info-label">{{ t('gerber.panelScope') }}</span>
          <span class="info-value" :title="t('gerber.panelScopeHint')">
            {{ t(activeMode === 'single' ? 'gerber.scopeSingle' : 'gerber.scopePanel') }}
            <button class="link-btn" @click="showPanelDialog = true">{{ t('gerber.panelChange') }}</button>
          </span>
        </div>
        <div v-if="props.mode === 'stencil'" class="info-row">
          <span class="info-label">{{ t('stencil.padCountShort') }}</span>
          <span class="info-value">
            {{ t('stencil.topShort') }} {{ display.topPadCount }} / {{ t('stencil.bottomShort') }} {{ display.bottomPadCount }}
          </span>
        </div>
        <div v-if="props.mode === 'stencil' && display.skipped && display.skipped > 0" class="info-row">
          <span class="info-label">{{ t('stencil.skippedShort') }}</span>
          <span class="info-value warn">{{ t('stencil.skippedWarning', { n: display.skipped }) }}</span>
        </div>
        <div v-if="props.mode !== 'stencil'" class="info-row">
          <span class="info-label">{{ t('gerber.units') }}</span>
          <span class="info-value">{{ display.units || t('gerber.unitsUnknown') }}</span>
        </div>
        <div class="info-row">
          <span class="info-label">{{ t('gerber.vertices') }}</span>
          <span class="info-value">
            {{ display.outlinePoints.length }}
            <span v-if="display.arcs && display.arcs > 0" class="info-sub">
              ({{ t('gerber.arcs', { n: display.arcs }) }})
            </span>
          </span>
        </div>
        <div v-if="display.holes.length > 0" class="info-row">
          <span class="info-label">{{ t('gerber.holesLabel') }}</span>
          <span class="info-value">{{ t('gerber.holes', { n: display.holes.length }) }}</span>
        </div>
      </div>

      <!-- Candidates -->
      <div v-if="candidates.length > 1" class="alt-candidates">
        <span class="candidates-label">{{ t('gerber.candidates') }}</span>
        <div class="candidates-list">
          <span v-for="c in candidates.slice(1, 4)" :key="c.filename" class="candidate-item">
            <code>{{ c.filename }}</code>
          </span>
        </div>
      </div>

      <button class="reimport-btn" @click="clear">{{ t('gerber.reimport') }}</button>
    </div>

    <!-- 拼版口径选择:检测到拼版时先问用户做整版还是单板 -->
    <el-dialog
      v-model="showPanelDialog"
      :title="t('gerber.panelDialogTitle')"
      width="420"
      align-center
      :close-on-click-modal="false"
    >
      <p class="dialog-desc">
        {{ t('gerber.panelDialogDesc', {
          grid: display?.panelGrid
            ? t('gerber.panelGrid', display.panelGrid)
            : t('gerber.panelDetected'),
        }) }}
      </p>
      <div class="scope-options">
        <button
          class="scope-option"
          :class="{ 'is-active': activeMode === 'panel' }"
          @click="confirmPanelMode('panel')"
        >
          <span class="scope-name">{{ t('gerber.scopePanel') }}</span>
          <span class="scope-hint">{{ t('gerber.scopePanelHint') }}</span>
        </button>
        <button
          class="scope-option"
          :class="{ 'is-active': activeMode === 'single' }"
          @click="confirmPanelMode('single')"
        >
          <span class="scope-name">{{ t('gerber.scopeSingle') }}</span>
          <span class="scope-hint">{{ t('gerber.scopeSingleHint') }}</span>
        </button>
      </div>
      <p class="dialog-foot">{{ t('gerber.panelDialogFoot') }}</p>
    </el-dialog>
  </div>
</template>

<style scoped>
.gerber-import {
  padding: 16px;
}

/* Dropzone */
.dropzone {
  border: 1.5px dashed var(--border-neutral-l2);
  border-radius: var(--radius-12);
  padding: 32px 16px;
  text-align: center;
  cursor: pointer;
  transition: border-color 0.15s ease, background-color 0.15s ease;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}

.dropzone:hover {
  border-color: var(--bg-brand);
  background: var(--bg-brand-popup);
}

/* 拖文件悬停/解析中:品牌橙提示"投入信号"(与 hover 的绿区分) */
.dropzone.active {
  border-color: var(--brand-accent);
  background: var(--brand-accent-surface);
}

.dropzone.active .drop-icon {
  color: var(--brand-accent);
}

.drop-icon {
  color: var(--text-tertiary);
  transition: color 0.15s ease;
}

.dropzone:hover .drop-icon {
  color: var(--bg-brand);
}

.drop-text {
  margin: 0;
  font-size: 13px;
  font-weight: var(--font-weight-medium);
  color: var(--text-secondary);
}

.drop-hint {
  margin: 0;
  font-size: 11px;
  color: var(--text-tertiary);
  font-family: var(--font-family-mono);
}

.error-alert {
  margin-top: 12px;
}

/* Result */
.result {
  margin-top: 0;
}

.result-header {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 12px;
}

.check-icon {
  color: var(--status-success-default);
}

.result-title {
  font-size: 12px;
  font-weight: var(--font-weight-medium);
  color: var(--text-secondary);
}

.outline-preview {
  width: 100%;
  height: 120px;
  background: var(--brand-grey-50);
  border-radius: var(--radius-8);
  margin-bottom: 12px;
  border: 1px solid var(--border-neutral-l1);
}

.info-grid {
  display: flex;
  flex-direction: column;
  gap: 0;
  border: 1px solid var(--border-neutral-l1);
  border-radius: var(--radius-8);
  overflow: hidden;
}

.info-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border-neutral-l1);
}

.info-row:last-child {
  border-bottom: none;
}

.info-label {
  font-size: 11px;
  color: var(--text-tertiary);
  font-weight: var(--font-weight-medium);
}

.info-value {
  font-size: 12px;
  color: var(--text-default);
  font-family: var(--font-family-mono);
  text-align: right;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 60%;
}

.info-sub {
  color: var(--text-tertiary);
  font-size: 10px;
  margin-left: 4px;
}

.info-value.warn {
  color: #D9913D;
}

.alt-candidates {
  margin-top: 8px;
  padding: 8px 12px;
  background: var(--bg-overlay-l1);
  border-radius: var(--radius-6);
}

.candidates-label {
  font-size: 10px;
  color: var(--text-tertiary);
  font-weight: var(--font-weight-medium);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.candidates-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 4px;
}

.candidate-item code {
  font-family: var(--font-family-mono);
  font-size: 10px;
  background: var(--bg-base-default);
  padding: 2px 6px;
  border-radius: var(--radius-4);
  border: 1px solid var(--border-neutral-l1);
  color: var(--text-secondary);
}

.reimport-btn {
  margin-top: 12px;
  padding: 6px 12px;
  border: 1px solid var(--border-neutral-l1);
  border-radius: var(--radius-6);
  background: var(--bg-base-default);
  color: var(--text-secondary);
  font-size: 12px;
  font-weight: var(--font-weight-medium);
  cursor: pointer;
  transition: background-color 0.12s ease;
}

.reimport-btn:hover {
  background: var(--bg-overlay-l1);
  color: var(--text-default);
}

/* 拼版口径:结果卡片里的切换链接 */
.link-btn {
  margin-left: 6px;
  padding: 0;
  border: none;
  background: none;
  color: var(--bg-brand);
  font-size: 11px;
  font-family: inherit;
  cursor: pointer;
  text-decoration: underline;
}

/* 拼版口径选择弹窗 */
.dialog-desc {
  margin: 0 0 14px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-secondary);
}

.scope-options {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.scope-option {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 12px 14px;
  border: 1.5px solid var(--border-neutral-l1);
  border-radius: var(--radius-8);
  background: var(--bg-base-default);
  text-align: left;
  cursor: pointer;
  transition: border-color 0.15s ease, background-color 0.15s ease;
}

.scope-option:hover {
  border-color: var(--bg-brand);
  background: var(--bg-brand-popup);
}

.scope-option.is-active {
  border-color: var(--bg-brand);
  background: var(--bg-brand-popup);
}

.scope-name {
  font-size: 13px;
  font-weight: var(--font-weight-medium);
  color: var(--text-default);
}

.scope-hint {
  font-size: 11px;
  line-height: 1.5;
  color: var(--text-tertiary);
}

.dialog-foot {
  margin: 14px 0 0;
  font-size: 11px;
  color: var(--text-tertiary);
}
</style>
