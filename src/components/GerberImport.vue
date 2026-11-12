<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch } from "vue";
import { listen, type Event as TauriEvent } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { useI18n } from "vue-i18n";
import { useGerberOutline } from "../composables/useGerberOutline";
import { useGerberStencil } from "../composables/useGerberStencil";
import { useGerberImportSession, type GerberImportPayload } from "../composables/useGerberImportSession";
import { useCompletionFeedback } from "../composables/useCompletionFeedback";
import { getPanelBoards, resolvePanelSelection, type PanelMode, type PanelVariant } from "../lib/gerber/panel";
import { useConfigStore } from "../stores/config";
import PanelBoardPicker from "./PanelBoardPicker.vue";
import ActionStatusIcon from "./ActionStatusIcon.vue";

const props = withDefaults(defineProps<{
  mode?: "jig" | "stencil";
}>(), { mode: "jig" });

const { t } = useI18n();
const configStore = useConfigStore();
const { completed: importCompleted, complete: completeImport, reset: resetImportFeedback } = useCompletionFeedback();

/** 一次导入的完整结果:整版 / 单板两套口径一起交给 store */
export type { GerberImportPayload } from "../composables/useGerberImportSession";

const emit = defineEmits<{
  (e: "gerberLoaded", payload: GerberImportPayload & { mode: PanelMode }): void;
}>();

const outline = useGerberOutline();
const stencil = useGerberStencil();

const session = useGerberImportSession({ mode: () => props.mode, outline, stencil, submit,
  onStart: () => { resetImportFeedback(); showPanelDialog.value = false; payload.value = null; } });
const { loading, error, processFile } = session;
watch(loading, value => { configStore.gerberImporting = value; }, { flush: 'sync' });
watch(error, value => { if (value) resetImportFeedback(); }, { flush: 'sync' });
const candidates = computed(() => (props.mode === "stencil" ? [] : outline.candidates.value));

// ===== 拼版口径选择 =====
/** 最近一次解析出的结果(用于预览按当前口径渲染) */
const payload = ref<GerberImportPayload | null>(null);
/** 当前生效口径:以 store 为唯一来源,设置面板切换后这里同步跟随 */
const activeMode = computed(() => configStore.config.panelMode);
const activeBoardIndex = computed(() => configStore.selectedPanelBoard);
const availableBoards = computed(() => showPanelDialog.value && payload.value
  ? getPanelBoards(payload.value.variants) : configStore.panelBoards);
/** 拼版文件导入时弹窗,让用户先选整版还是单板 */
const showPanelDialog = ref(false);
const dialogMode = ref<PanelMode>("panel");
const dialogBoardIndex = ref(0);

function openPanelDialog() {
  resetImportFeedback();
  if (!showPanelDialog.value && configStore.panelOverview && configStore.config.panelAvailable) {
    payload.value = { filename: configStore.config.gerberFilename ?? '', isPanel: true,
      sourceFilename: configStore.gerberSourceFilename ?? undefined,
      outlineSource: configStore.gerberOutlineSource ?? undefined,
      outlineFallbackReason: configStore.gerberOutlineFallbackReason ?? undefined,
      hasPads: !!(configStore.panelOverview.topPads?.length || configStore.panelOverview.bottomPads?.length),
      panelGrid: configStore.config.panelGrid ?? undefined,
      variants: { panel: configStore.panelOverview, single: configStore.panelBoards[0] ?? configStore.panelOverview,
        boards: configStore.panelBoards } };
  }
  dialogMode.value = activeMode.value;
  dialogBoardIndex.value = activeBoardIndex.value;
  showPanelDialog.value = true;
}

function selectDialogBoard(index: number) {
  dialogBoardIndex.value = index;
  dialogMode.value = "board";
}

function variantFor(p: GerberImportPayload, mode: PanelMode, boardIndex: number): PanelVariant {
  return resolvePanelSelection(p.variants, mode, boardIndex).variant;
}

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
  boardCount?: number;
  boardIndex?: number;
  units?: string | null;
  arcs?: number;
  outlineSource?: 'gerber' | 'pads-bounds';
  outlineFallbackReason?: 'missing' | 'invalid';
}
const display = computed<DisplayResult | null>(() => {
  // Reflect the active board and pad edits when switching panel scopes.
  if (!showPanelDialog.value) {
    const c = configStore.config;
    if (!c.pcbOutlinePoints.length && !c.stencilPadsTop.length && !c.stencilPadsBottom.length) return null;
    const sameImport = payload.value?.filename === c.gerberFilename;
    return { width: c.pcbSizeX, height: c.pcbSizeY, filename: c.gerberFilename ?? '',
      outlineSource: configStore.gerberOutlineSource ?? undefined,
      outlineFallbackReason: configStore.gerberOutlineFallbackReason ?? undefined,
      outlinePoints: c.pcbOutlinePoints, holes: c.pcbOutlineHoles,
      topPadCount: c.stencilPadsTop.length, bottomPadCount: c.stencilPadsBottom.length,
      skipped: sameImport ? stencil.result.value?.skipped : undefined,
      units: sameImport ? outline.result.value?.bbox.units : 'mm',
      arcs: sameImport ? outline.result.value?.parse.arcsLinearized : undefined,
      isPanel: c.panelAvailable, panelGrid: c.panelGrid ?? undefined,
      boardCount: configStore.panelBoards.length, boardIndex: c.panelMode === 'board' ? configStore.selectedPanelBoard : undefined };
  }
  const p = payload.value;
  if (!p) return null;
  const mode = showPanelDialog.value ? dialogMode.value : activeMode.value;
  const boardIndex = showPanelDialog.value ? dialogBoardIndex.value : activeBoardIndex.value;
  const v = variantFor(p, mode, boardIndex);
  const o = outline.result.value;
  const s = stencil.result.value;
  return {
    width: v.width,
    height: v.height,
    filename: p.filename,
    outlineSource: p.outlineSource,
    outlineFallbackReason: p.outlineFallbackReason,
    outlinePoints: v.outlinePoints,
    holes: v.outlineHoles,
    topPadCount: v.topPads?.length,
    bottomPadCount: v.bottomPads?.length,
    skipped: s?.skipped,
    isPanel: p.isPanel,
    panelGrid: p.panelGrid,
    boardCount: availableBoards.value.length,
    boardIndex: mode === "board" ? boardIndex : undefined,
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
    dialogMode.value = activeMode.value;
    dialogBoardIndex.value = activeBoardIndex.value;
    showPanelDialog.value = true;
    return;
  }
  emit("gerberLoaded", { ...p, mode: "panel" });
  completeImport();
}

/** 弹窗选择完成:按选中口径应用 */
function confirmPanelMode(mode: PanelMode, boardIndex = dialogBoardIndex.value) {
  if (loading.value) return;
  showPanelDialog.value = false;
  const p = payload.value;
  if (p) {
    const selection = resolvePanelSelection(p.variants, mode, boardIndex);
    resetImportFeedback();
    emit("gerberLoaded", { ...p, mode: selection.mode, boardIndex: selection.index ?? undefined });
    completeImport();
  }
}

async function onFileChange(e: Event) {
  const target = e.target as HTMLInputElement;
  const file = target.files?.[0];
  if (!file) return;
  target.value = "";
  await processFile(file);
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

  await session.processSource(async () => {
    const bytes = await invoke<number[]>("read_dropped_file", { path });
    const u8 = new Uint8Array(bytes);
    return new File([u8], fileName, {
      type: fileName.toLowerCase().endsWith(".zip")
        ? "application/zip"
        : "text/plain",
    });
  });
}

// Tauri 2 原生文件拖拽事件
let unlistenDrop: (() => void) | null = null;
let unlistenEnter: (() => void) | null = null;
let unlistenLeave: (() => void) | null = null;
let disposed = false;

watch(() => props.mode, () => {
  resetImportFeedback();
  session.cancel();
  payload.value = null;
  showPanelDialog.value = false;
}, { flush: 'sync' });

onMounted(async () => {
  const register = async <T,>(name: string, handler: (event: TauriEvent<T>) => void) => {
    const unlisten = await listen<T>(name, event => { if (!disposed) handler(event); });
    if (disposed) { unlisten(); return null; }
    return unlisten;
  };
  try {
    unlistenDrop = await register<{ paths: string[] }>(
      "tauri://drag-drop",
      (e) => processDroppedPaths(e.payload.paths)
    );
    unlistenEnter = await register("tauri://drag-enter", () => {
      dragOver.value = true;
    });
    unlistenLeave = await register("tauri://drag-leave", () => {
      dragOver.value = false;
    });
  } catch (err) {
    console.warn("Tauri drag-drop event listener failed:", err);
  }
});

onBeforeUnmount(() => {
  disposed = true;
  session.cancel();
  unlistenDrop?.();
  unlistenEnter?.();
  unlistenLeave?.();
});

function clear() {
  resetImportFeedback();
  session.cancel();
  showPanelDialog.value = false;
  payload.value = null;
  configStore.clearPanelScope();
  Object.assign(configStore.config, { gerberFilename: null, pcbOutlinePoints: [], pcbOutlineHoles: [],
    stencilPadsTop: [], stencilPadsBottom: [] });
}

function fmt(n: number): string {
  return n.toFixed(2);
}

const acceptAttr = computed(() =>
  props.mode === "stencil" ? ".zip,.gtp,.gbp,.gpt,.gpb,.gbr" : ".zip,.gko,.gm1,.gme,.gbr"
);

/** SVG path:外框 + 内孔子路径,配合 fill-rule=evenodd 显示挖孔 */
const outlinePath = computed(() => {
  if (!display.value) return "";
  const toSub = (pts: Array<[number, number]>) =>
    pts.length >= 3 ? `M${pts.map(([x, y]) => `${x},${y}`).join("L")}Z` : "";
  return [toSub(display.value.outlinePoints), ...display.value.holes.map(toSub)].join(" ");
});
// Frame the imported geometry itself. Editing the nominal PCB dimensions must
// not crop this reference preview or assume the outline is centred at (0, 0).
const outlineViewBox = computed(() => {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of display.value?.outlinePoints ?? []) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  if (!Number.isFinite(minX)) return '-1 -1 2 2';
  const padding = Math.max(maxX - minX, maxY - minY, 1) * .08 + .5;
  return `${minX - padding} ${-maxY - padding} ${maxX - minX + padding * 2} ${maxY - minY + padding * 2}`;
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
      v-if="!display"
      class="dropzone"
      :class="{ active: loading || dragOver }"
      role="button"
      tabindex="0"
      :aria-label="t('gerber.drop')"
      :aria-busy="loading"
      @click="pickFile"
      @keydown.enter.prevent="pickFile"
      @keydown.space.prevent="pickFile"
      @dragover="onDragOver"
      @dragleave="onDragLeave"
      @drop="onDrop"
    >
      <ActionStatusIcon class="drop-icon" :size="28" :state="loading ? 'busy' : 'idle'">
        <svg viewBox="0 0 24 24" width="28" height="28">
          <path d="M12 3v12m0-12l-4 4m4-4l4 4M5 15v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4"
            fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </ActionStatusIcon>
      <p v-if="!loading" class="drop-text">{{ t('gerber.drop') }}</p>
      <p v-else class="drop-text">{{ t('gerber.parsing') }}</p>
      <p class="drop-hint">{{ t('gerber.dropHint') }}</p>
    </div>

    <!-- Error -->
    <el-alert v-if="error" type="error" :closable="false" class="error-alert">
      {{ error }}
    </el-alert>

    <!-- Result -->
    <div v-if="display" class="result" :aria-busy="loading">
      <p v-if="loading" class="import-progress" role="status">{{ t('gerber.parsing') }}</p>
      <div class="result-header" :class="{
        'is-estimated': display.outlineSource === 'pads-bounds',
        'is-complete': importCompleted && !loading && !showPanelDialog && display.outlineSource !== 'pads-bounds',
      }">
        <ActionStatusIcon class="check-icon" :size="16"
          :state="loading ? 'busy' : importCompleted && !showPanelDialog && display.outlineSource !== 'pads-bounds' ? 'success' : 'idle'">
          <svg viewBox="0 0 16 16" width="16" height="16">
            <g v-if="display.outlineSource === 'pads-bounds'" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round">
              <circle cx="8" cy="8" r="6.5" />
              <path d="M8 4.5v4M8 11v.5" />
            </g>
            <path v-else d="M3 8.5l3.5 3.5L13 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </ActionStatusIcon>
        <span class="result-title">{{ t(display.outlineSource === 'pads-bounds' ? 'gerber.estimatedOutlineTitle' : 'gerber.recognized') }}</span>
      </div>

      <div v-if="display.outlineSource === 'pads-bounds'" class="outline-estimate-note" role="status">
        <p>{{ t(display.outlineFallbackReason === 'invalid' ? 'gerber.estimatedOutlineInvalid' : 'gerber.estimatedOutlineMissing') }}</p>
        <p>{{ t('gerber.estimatedOutlineHint') }}</p>
        <button class="link-btn" @click="pickFile">{{ t('gerber.chooseCompleteFile') }}</button>
      </div>

      <!-- SVG Preview -->
      <svg
        v-if="display.outlinePoints.length > 0"
        class="outline-preview"
        :viewBox="outlineViewBox"
        preserveAspectRatio="xMidYMid meet"
      >
        <g transform="scale(1, -1)">
          <path
            :d="outlinePath"
            fill-rule="evenodd"
            fill="var(--outline-preview-fill)"
            stroke="var(--outline-preview-stroke)"
            stroke-width="1.1"
            vector-effect="non-scaling-stroke"
          />
        </g>
      </svg>

      <!-- Core dimensions and the current board stay prominent. -->
      <div class="result-summary">
        <div class="size-summary" :class="{ 'is-estimated': display.outlineSource === 'pads-bounds' }">
          <span class="summary-label">{{ t(display.outlineSource === 'pads-bounds' ? 'gerber.estimatedSize' : 'gerber.pcbSize') }}</span>
          <span class="size-value"><strong>{{ fmt(display.width) }} × {{ fmt(display.height) }}</strong><span>mm</span></span>
        </div>
        <div v-if="display.isPanel" class="summary-row">
          <span class="summary-label">{{ t('gerber.panelScope') }}</span>
          <div class="scope-value">
            <span :title="t('gerber.panelScopeHint')">
              {{ t(activeMode === 'board' ? 'gerber.scopeBoard' : 'gerber.scopePanel') }}
              <template v-if="activeMode === 'board' && display.boardCount">
                · {{ (display.boardIndex ?? 0) + 1 }} / {{ display.boardCount }}
              </template>
            </span>
            <button class="link-btn" @click="openPanelDialog">{{ t('gerber.panelChange') }}</button>
          </div>
        </div>
        <div v-if="props.mode === 'stencil'" class="summary-row">
          <span class="summary-label">{{ t('stencil.padCountShort') }}</span>
          <div class="pad-counts">
            <span>{{ t('stencil.topShort') }} <strong>{{ display.topPadCount }}</strong></span>
            <span class="pad-divider" aria-hidden="true">/</span>
            <span>{{ t('stencil.bottomShort') }} <strong>{{ display.bottomPadCount }}</strong></span>
          </div>
        </div>
      </div>
      <div v-if="props.mode === 'stencil' && display.skipped && display.skipped > 0" class="result-warning">
        <span>{{ t('stencil.skippedShort') }}</span>
        <span>{{ t('stencil.skippedWarning', { n: display.skipped }) }}</span>
      </div>

      <!-- Source metadata remains visible, with quieter type and spacing. -->
      <div class="info-grid">
        <div class="info-row">
          <span class="info-label">{{ t('gerber.outlineFile') }}</span>
          <span class="info-value info-filename" :title="display.filename">{{ display.filename }}</span>
        </div>
        <div v-if="display.isPanel" class="info-row">
          <span class="info-label">{{ t('gerber.panel') }}</span>
          <span class="info-value">
            {{ display.panelGrid ? t('gerber.panelGrid', display.panelGrid) : t('gerber.panelDetected') }}
          </span>
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
      class="panel-import-dialog"
      width="840"
      align-center
      append-to-body
      :close-on-click-modal="false"
    >
      <p class="dialog-desc">
        {{ t(payload?.variants.boards?.some(board => board.inferred) ? 'gerber.panelDialogDescConnected'
          : display?.boardCount && display.boardCount > 1 ? 'gerber.panelDialogDescMixed' : 'gerber.panelDialogDesc', {
          grid: display?.panelGrid
            ? t('gerber.panelGrid', display.panelGrid)
            : t('gerber.panelDetected'),
          n: display?.boardCount ?? 0,
        }) }}
      </p>
      <div class="scope-options">
        <button
          class="scope-option"
          :class="{ 'is-active': dialogMode === 'panel' }"
          :aria-pressed="dialogMode === 'panel'"
          @click="dialogMode = 'panel'"
        >
          <span class="scope-name">{{ t('gerber.scopePanel') }}</span>
          <span class="scope-hint">{{ t('gerber.scopePanelHint') }}</span>
        </button>
        <button
          class="scope-option"
          :class="{ 'is-active': dialogMode === 'board' }"
          :aria-pressed="dialogMode === 'board'"
          @click="dialogMode = 'board'"
        >
          <span class="scope-name">{{ t('gerber.scopeBoard') }}</span>
          <span class="scope-hint">{{ t('gerber.scopeBoardHint') }}</span>
        </button>
      </div>
      <PanelBoardPicker v-if="payload" expanded :model-value="dialogBoardIndex"
        :whole-panel="dialogMode === 'panel'" :boards="availableBoards" :panel="payload.variants.panel"
        @update:model-value="selectDialogBoard" />
      <template #footer>
        <div class="panel-dialog-footer">
          <span class="dialog-foot">{{ t('gerber.panelSelectionFoot') }}</span>
          <button class="scope-confirm" @click="confirmPanelMode(dialogMode, dialogBoardIndex)">
            {{ t(dialogMode === 'panel' ? 'gerber.panelUseWhole' : 'gerber.panelUseChoice') }}
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M3 8h10m-4-4 4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" /></svg>
          </button>
        </div>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.gerber-import {
  padding: 16px;
}

/* Dropzone */
.dropzone {
  border: 1px dashed var(--border-neutral-l2);
  background: var(--surface-well);
  border-radius: var(--radius-popover);
  corner-shape: var(--corner-shape);
  padding: 32px 16px;
  text-align: center;
  cursor: pointer;
  transition: border-color var(--motion-fast) var(--ease-out), background-color var(--motion-fast) var(--ease-out), box-shadow var(--motion-fast) var(--ease-out);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}

.dropzone:hover {
  border-color: var(--interaction-border);
  background: color-mix(in srgb, var(--bg-brand) 6%, var(--surface-well));
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--bg-brand) 12%, transparent);
}
.dropzone:focus-visible { outline: 2px solid var(--interaction-border); outline-offset: 3px; }
.dropzone:active { background: var(--control-selection-surface); }

/* 拖文件悬停/解析中:品牌橙提示"投入信号"(与 hover 的绿区分) */
.dropzone.active {
  border-color: var(--accent-ink);
  background: var(--brand-accent-surface);
}

.dropzone.active .drop-icon {
  color: var(--accent-ink);
}

.drop-icon {
  color: var(--interaction-ink);
  transition: color var(--motion-fast) var(--ease-out), transform var(--motion-release) var(--ease-settle);
}

.dropzone:hover .drop-icon {
  transform: translateY(-2px);
  color: var(--interaction-ink);
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
  font-family: var(--font-family-default);
}

.error-alert {
  margin-top: 12px;
}

/* Result */
.result {
  margin-top: 0;
}

.result-header.is-estimated :is(.check-icon, .result-title) { color: var(--status-warning-default); }
.import-progress { margin: 0 0 10px; color: var(--text-secondary); font-size: 12px; }
.outline-estimate-note { margin: 0 0 12px; padding: 10px 12px; border-radius: var(--radius-control); background: var(--status-warning-surface-l1); color: var(--text-secondary); font-size: 12px; line-height: 1.6; }
.outline-estimate-note p { margin: 0; }
.outline-estimate-note p + p { margin-top: 4px; }
.outline-estimate-note .link-btn { margin-top: 6px; color: var(--status-warning-default); }

.result-header {
  position: relative;
  isolation: isolate;
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 12px;
}

.result-header::before {
  content: '';
  position: absolute;
  inset: -5px -7px;
  z-index: -1;
  border-radius: var(--radius-inner);
  background: var(--status-success-surface-l1);
  opacity: 0;
  pointer-events: none;
  transition: opacity 220ms var(--ease-out);
}
.result-header.is-complete::before { opacity: .75; }

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

.result-summary {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 12px 14px;
  border: 1px solid var(--surface-line);
  border-radius: var(--radius-control);
  background: var(--surface-well);
}

.size-summary {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.summary-label {
  color: var(--text-tertiary);
  font-size: 11px;
  line-height: 1.5;
}

.size-value {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 6px;
  color: var(--text-tertiary);
  font-size: 11px;
  line-height: 1.35;
}

.size-value strong {
  color: var(--text-default);
  font-size: 21px;
  font-weight: var(--font-weight-strong);
  letter-spacing: -.025em;
  font-variant-numeric: tabular-nums;
  overflow-wrap: anywhere;
}

.size-summary.is-estimated :is(.summary-label, .size-value strong) {
  color: var(--status-warning-default);
}

.summary-row {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: 4px 12px;
}

.scope-value,
.pad-counts {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: flex-end;
  gap: 4px 8px;
  min-width: 0;
  max-width: 100%;
  margin-left: auto;
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.6;
  overflow-wrap: anywhere;
}

.scope-value > .link-btn {
  flex-shrink: 0;
  margin-left: 0;
}

.pad-counts strong {
  margin-left: 3px;
  color: var(--text-default);
  font-weight: var(--font-weight-strong);
  font-variant-numeric: tabular-nums;
}
.pad-divider { color: var(--text-disabled); }

.result-warning {
  display: flex;
  flex-wrap: wrap;
  gap: 3px 8px;
  margin-top: 8px;
  padding: 8px 10px;
  border-radius: var(--radius-inner);
  background: var(--status-warning-surface-l1);
  color: var(--status-warning-default);
  font-size: 11px;
  line-height: 1.6;
  overflow-wrap: anywhere;
}

.info-grid {
  display: flex;
  flex-direction: column;
  gap: 7px;
  margin-top: 14px;
  padding: 0 2px;
}

.info-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.5fr);
  align-items: baseline;
  gap: 12px;
  line-height: 1.5;
}

.info-label {
  font-size: 11px;
  color: var(--text-tertiary);
  overflow-wrap: anywhere;
}

.info-value {
  min-width: 0;
  font-size: 11px;
  color: var(--text-secondary);
  font-family: var(--font-family-default);
  font-variant-numeric: tabular-nums;
  text-align: right;
  overflow-wrap: anywhere;
}
.info-filename { font-family: var(--font-family-mono); }

.info-sub {
  color: var(--text-tertiary);
  font-size: 10px;
  margin-left: 4px;
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
  display: inline-block;
  max-width: 100%;
  font-family: var(--font-family-mono);
  font-size: 10px;
  background: var(--bg-base-default);
  padding: 2px 6px;
  border-radius: var(--radius-4);
  border: 1px solid var(--border-neutral-l1);
  color: var(--text-secondary);
  overflow-wrap: anywhere;
}
.candidate-item { min-width: 0; max-width: 100%; }

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
  transition: var(--control-transition);
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
  color: var(--interaction-ink);
  font-size: 11px;
  font-family: inherit;
  cursor: pointer;
  text-decoration: underline;
}

/* 拼版口径选择弹窗 */
.dialog-desc {
  margin: 0 0 18px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-secondary);
}

.scope-options {
  display: flex;
  gap: 8px;
  margin-bottom: 20px;
}

.scope-option {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 12px 14px;
  border: 1px solid var(--surface-line);
  border-radius: var(--radius-control);
  background: var(--surface-raised);
  text-align: left;
  cursor: pointer;
  transition: var(--control-transition);
}

.scope-option:hover {
  border-color: var(--interaction-border);
  background: color-mix(in srgb, var(--bg-brand) 5%, var(--surface-raised));
}

.scope-option.is-active {
  border-color: var(--interaction-border);
  background: color-mix(in srgb, var(--bg-brand) 8%, var(--surface-raised));
}

.scope-option:focus-visible, .scope-confirm:focus-visible { outline: 2px solid var(--interaction-border); outline-offset: 3px; }

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

.scope-confirm {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 11px 18px;
  border: 1px solid var(--interaction-border);
  border-radius: var(--radius-control);
  background: var(--bg-brand);
  color: var(--text-onbrand);
  font-size: 12px;
  font-weight: var(--font-weight-medium);
  cursor: pointer;
  white-space: nowrap;
  transition: var(--control-transition);
}

.scope-confirm:hover {
  background: var(--bg-brand-hover);
}
.panel-dialog-footer { display: flex; align-items: center; justify-content: space-between; gap: 16px; }

.dialog-foot {
  margin: 0;
  font-size: 11px;
  color: var(--text-tertiary);
}
</style>

<style>
.panel-import-dialog.el-dialog {
  max-width: calc(100vw - 40px);
  max-height: calc(100dvh - 40px);
  display: flex;
  flex-direction: column;
  padding: 24px;
  border: 1px solid var(--surface-line);
  border-radius: var(--radius-dialog);
  corner-shape: var(--corner-shape);
  box-shadow: var(--shadow-float);
}
.panel-import-dialog .el-dialog__header { flex-shrink: 0; padding: 0 32px 12px 0; border-bottom: none; }
.panel-import-dialog .el-dialog__title { font-size: 18px; font-weight: 600; letter-spacing: -.02em; }
.panel-import-dialog .el-dialog__body { overflow-y: auto; min-height: 0; padding: 0; }
.panel-import-dialog .el-dialog__footer { flex-shrink: 0; padding: 18px 0 0; margin-top: 20px; border-top: 1px solid var(--surface-line); }
@media (max-width: 660px) {
  .panel-import-dialog.el-dialog { padding: 18px; max-width: calc(100vw - 24px); }
  .panel-import-dialog .panel-dialog-footer { align-items: flex-start; }
}
</style>
