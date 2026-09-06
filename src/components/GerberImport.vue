<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from "vue";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { useI18n } from "vue-i18n";
import { useGerberOutline } from "../composables/useGerberOutline";
import { useGerberStencil } from "../composables/useGerberStencil";
import type { PadPolygon } from "../lib/gerber/pads";

const props = withDefaults(defineProps<{
  mode?: "jig" | "stencil";
}>(), { mode: "jig" });

const { t } = useI18n();

const emit = defineEmits<{
  (e: "sizeDetected", payload: {
    width: number;
    height: number;
    filename: string;
    outlinePoints: Array<[number, number]>;
    holes: Array<Array<[number, number]>>;
  }): void;
  (e: "stencilDetected", payload: {
    width: number;
    height: number;
    outlinePoints: Array<[number, number]>;
    topPads: PadPolygon[];
    bottomPads: PadPolygon[];
  }): void;
}>();

const outline = useGerberOutline();
const stencil = useGerberStencil();

const loading = computed(() => (props.mode === "stencil" ? stencil.loading.value : outline.loading.value));
const error = computed(() => (props.mode === "stencil" ? stencil.error.value : outline.error.value));
const hasResult = computed(() => (props.mode === "stencil" ? stencil.hasResult.value : outline.hasResult.value));
const candidates = computed(() => (props.mode === "stencil" ? [] : outline.candidates.value));

// 统一显示用的结果
interface DisplayResult {
  width: number;
  height: number;
  filename: string;
  outlinePoints: Array<[number, number]>;
  holes: Array<Array<[number, number]>>;
  padCount?: number;
  topPadCount?: number;
  bottomPadCount?: number;
  skipped?: number;
  bbox?: { units: string | null };
  parse?: { arcsLinearized: number };
}
const display = computed<DisplayResult | null>(() => {
  if (props.mode === "stencil") {
    const r = stencil.result.value;
    if (!r) return null;
    return {
      width: r.width,
      height: r.height,
      filename: [r.topPasteFile, r.bottomPasteFile].filter(Boolean).join(" + "),
      outlinePoints: r.outlinePoints,
      holes: r.outlineHoles,
      padCount: r.padCount,
      topPadCount: r.topPads.length,
      bottomPadCount: r.bottomPads.length,
      skipped: r.skipped,
    };
  }
  const r = outline.result.value;
  if (!r) return null;
  return {
    width: r.width,
    height: r.height,
    filename: r.filename,
    outlinePoints: r.outlinePoints,
    holes: r.holes,
    bbox: { units: r.bbox.units },
    parse: { arcsLinearized: r.parse.arcsLinearized },
  };
});

const fileInput = ref<HTMLInputElement | null>(null);
const dragOver = ref(false);

function pickFile() {
  fileInput.value?.click();
}

async function handleResult() {
  if (props.mode === "stencil") {
    const r = stencil.result.value;
    if (r) {
      emit("stencilDetected", {
        width: r.width,
        height: r.height,
        outlinePoints: r.outlinePoints,
        topPads: r.topPads,
        bottomPads: r.bottomPads,
      });
    }
  } else {
    const r = outline.result.value;
    if (r) {
      emit("sizeDetected", {
        width: r.width,
        height: r.height,
        filename: r.filename,
        outlinePoints: r.outlinePoints,
        holes: r.holes,
      });
    }
  }
}

async function onFileChange(e: Event) {
  const target = e.target as HTMLInputElement;
  const file = target.files?.[0];
  if (!file) return;
  await (props.mode === "stencil" ? stencil.processFile(file) : outline.processFile(file));
  await handleResult();
  target.value = "";
}

async function onDrop(e: DragEvent) {
  e.preventDefault();
  dragOver.value = false;
  const file = e.dataTransfer?.files?.[0];
  if (!file) return;
  await (props.mode === "stencil" ? stencil.processFile(file) : outline.processFile(file));
  await handleResult();
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
    await (props.mode === "stencil" ? stencil.processFile(file) : outline.processFile(file));
    await handleResult();
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
          <span class="info-value">{{ display.bbox?.units || t('gerber.unitsUnknown') }}</span>
        </div>
        <div class="info-row">
          <span class="info-label">{{ t('gerber.vertices') }}</span>
          <span class="info-value">
            {{ display.outlinePoints.length }}
            <span v-if="display.parse && display.parse.arcsLinearized > 0" class="info-sub">
              ({{ t('gerber.arcs', { n: display.parse.arcsLinearized }) }})
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

.dropzone.active {
  border-color: var(--bg-brand);
  background: var(--bg-brand-popup);
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
</style>
