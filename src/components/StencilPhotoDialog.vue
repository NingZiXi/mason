<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useConfigStore } from '../stores/config';
import type { JigPrintSide } from '../lib/component-relief';
import type { PadPolygon } from '../lib/gerber/pads';
import {
  alignStencilPhoto, jigPlacementFromInstance, orderCorners, photoMapper, rgbaToGray, StencilPhotoError,
  type BoardInstance, type GrayImage, type Quad, type StencilPhotoResult,
} from '../lib/stencil-align';
import type { BoardPlacement, StencilPlacementPlans } from '../lib/stencil-placement';

const props = defineProps<{ modelValue: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>();
const store = useConfigStore();
const { t } = useI18n();
const c = computed(() => store.config);

/** Photos are analysed at most this large; the stencil still spans plenty of pixels. */
const MAX_PHOTO_DIM = 3000;
/** Warn when the openings suggest a stencil size this far from the entered one. */
const SCALE_WARNING = 0.03;
const ANGLE_WARNING = (2 * Math.PI) / 180;
const SIDES: JigPrintSide[] = ['top', 'bottom'];

type ErrorCode = 'stencilNotFound' | 'noMatch' | 'noPads' | 'load';
const fileInput = ref<HTMLInputElement | null>(null);
const svg = ref<SVGSVGElement | null>(null);
const photoUrl = ref<string | null>(null);
const photo = shallowRef<GrayImage | null>(null);
const quad = ref<Quad | null>(null);
const result = shallowRef<StencilPhotoResult | null>(null);
const selection = ref<Record<JigPrintSide, number | null>>({ top: null, bottom: null });
const error = ref<ErrorCode | null>(null);
const busy = ref(false);
// Sizes used for the current result; a later settings change needs a new match.
const sheet = ref({ x: c.value.stencilSizeX, y: c.value.stencilSizeY });

function close() { emit('update:modelValue', false); }
function revokePhoto() {
  if (photoUrl.value) URL.revokeObjectURL(photoUrl.value);
  photoUrl.value = null;
}
onBeforeUnmount(revokePhoto);
watch(() => props.modelValue, open => { if (!open) dragging.value = null; });

async function loadFile(file: File) {
  busy.value = true;
  error.value = null;
  result.value = null;
  try {
    // createImageBitmap honours EXIF orientation, so analysis and display agree.
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_PHOTO_DIM / Math.max(bitmap.width, bitmap.height));
    const w = Math.round(bitmap.width * scale), h = Math.round(bitmap.height * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close();
    photo.value = rgbaToGray(ctx.getImageData(0, 0, w, h).data, w, h);
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.85));
    revokePhoto();
    photoUrl.value = blob ? URL.createObjectURL(blob) : null;
    quad.value = null;
  } catch {
    error.value = 'load';
    busy.value = false;
    return;
  }
  await detect();
}

function onFileChange(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (file) void loadFile(file);
}

function boardSize() {
  const pts = c.value.pcbOutlinePoints;
  if (pts.length < 3) return { width: c.value.pcbSizeX, height: c.value.pcbSizeY };
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  return { width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
}

/** Match on the next frame so the busy state paints first (detection takes ~1 s). */
async function detect(manualQuad?: Quad) {
  const image = photo.value;
  if (!image) return;
  busy.value = true;
  error.value = null;
  await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
  sheet.value = { x: c.value.stencilSizeX, y: c.value.stencilSizeY };
  const { width, height } = boardSize();
  try {
    const found = alignStencilPhoto({
      image, stencilSizeX: sheet.value.x, stencilSizeY: sheet.value.y,
      topPads: c.value.stencilPadsTop, bottomPads: c.value.stencilPadsBottom,
      boardWidth: width, boardHeight: height, quad: manualQuad,
    });
    result.value = found;
    quad.value = found.quad;
    selection.value = { top: found.top.length ? 0 : null, bottom: found.bottom.length ? 0 : null };
  } catch (e) {
    result.value = null;
    if (!(e instanceof StencilPhotoError)) throw e;
    error.value = e.code;
    // Keep the user's corners; otherwise offer a starting frame to drag into place.
    if (!manualQuad) {
      const mx = image.width * 0.15, my = image.height * 0.15;
      quad.value = [[mx, my], [image.width - mx, my], [image.width - mx, image.height - my], [mx, image.height - my]];
    }
  } finally {
    busy.value = false;
  }
}

// Corner editing: drag a handle, then match again with the corrected sheet.
const dragging = ref<number | null>(null);
function svgPoint(event: PointerEvent): [number, number] | null {
  const matrix = svg.value?.getScreenCTM();
  if (!matrix) return null;
  const p = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
  return [p.x, p.y];
}
function startDrag(index: number, event: PointerEvent) {
  if (busy.value) return;
  dragging.value = index;
  (event.currentTarget as Element).setPointerCapture(event.pointerId);
}
function moveDrag(event: PointerEvent) {
  if (dragging.value === null || !quad.value || !photo.value) return;
  const p = svgPoint(event);
  if (!p) return;
  const next = [...quad.value] as Quad;
  next[dragging.value] = [Math.max(0, Math.min(photo.value.width, p[0])), Math.max(0, Math.min(photo.value.height, p[1]))];
  quad.value = next;
}
function endDrag() {
  if (dragging.value === null || !quad.value) return;
  dragging.value = null;
  void detect(orderCorners(quad.value, sheet.value.x / sheet.value.y));
}

const handleRadius = computed(() => photo.value ? Math.max(photo.value.width, photo.value.height) / 110 : 10);
const strokeWidth = computed(() => handleRadius.value / 4);

function padsFor(side: JigPrintSide): readonly PadPolygon[] {
  return side === 'top' ? c.value.stencilPadsTop : c.value.stencilPadsBottom;
}

/** SVG path of one copy's openings and board outline in photo pixels. */
function overlay(instance: BoardInstance, side: JigPrintSide) {
  if (!quad.value) return { pads: '', outline: '' };
  const { x: sx, y: sy } = sheet.value;
  const map = photoMapper(quad.value, sx, sy);
  const cos = Math.cos(instance.rotation) * instance.scale, sin = Math.sin(instance.rotation) * instance.scale;
  const ring = (points: ReadonlyArray<readonly [number, number]>) => 'M' + points.map(([x, y]) => {
    const mx = instance.mirrored ? -x : x;
    const [px, py] = map([cos * mx - sin * y + instance.x + sx / 2, sy / 2 - (sin * mx + cos * y + instance.y)]);
    return `${px.toFixed(1)},${py.toFixed(1)}`;
  }).join('L') + 'Z';
  const pads = padsFor(side).filter(pad => pad.polarity === 'D')
    .flatMap(pad => pad.parts.filter(part => part.polarity === 'D' && part.points.length >= 3).map(part => ring(part.points))).join('');
  const w = c.value.pcbSizeX / 2, h = c.value.pcbSizeY / 2;
  const outline = ring(c.value.pcbOutlinePoints.length >= 3 ? c.value.pcbOutlinePoints : [[-w, -h], [w, -h], [w, h], [-w, h]]);
  return { pads, outline };
}

const overlays = computed(() => {
  const found = result.value;
  if (!found) return [];
  return SIDES.flatMap(side => found[side].map((instance, index) => ({
    key: `${side}-${index}`, side, selected: selection.value[side] === index, ...overlay(instance, side),
  })));
});

function toPlacement(instance: BoardInstance, side: JigPrintSide): BoardPlacement {
  const j = jigPlacementFromInstance(instance, side);
  const round = (v: number) => Math.round(v * 100) / 100 || 0;
  return { x: round(j.x), y: round(j.y), quarter: j.quarter, ...(j.stencilFlipped ? { stencilFlipped: true } : {}) };
}

const copies = computed(() => {
  const found = result.value;
  if (!found) return null;
  return SIDES.map(side => ({
    side,
    hasPads: padsFor(side).length > 0,
    items: found[side].map((instance, index) => {
      const placement = toPlacement(instance, side);
      const angle = jigPlacementFromInstance(instance, side).angleError;
      return { index, instance, placement, tilted: Math.abs(angle) > ANGLE_WARNING, angle: (angle * 180 / Math.PI).toFixed(1) };
    }),
  }));
});

/** Openings span the board, so a large, well-matched copy measures the sheet scale. */
const scaleWarning = computed(() => {
  const found = result.value;
  if (!found) return null;
  const reference = [...found.top, ...found.bottom].filter(i => i.inliers >= 8).sort((a, b) => b.inliers - a.inliers)[0];
  if (!reference || Math.abs(reference.scale - 1) <= SCALE_WARNING) return null;
  return { x: (sheet.value.x / reference.scale).toFixed(0), y: (sheet.value.y / reference.scale).toFixed(0) };
});

const canApply = computed(() => !busy.value && !!result.value
  && (selection.value.top !== null || selection.value.bottom !== null));

function apply() {
  const found = result.value;
  if (!found) return;
  const current = c.value.stencilPlacements;
  const plans: StencilPlacementPlans = { top: current.top, bottom: current.bottom };
  for (const side of SIDES) {
    const index = selection.value[side];
    if (index !== null && found[side][index]) plans[side] = toPlacement(found[side][index], side);
  }
  store.setStencilPlacements(plans);
  // Show the side that was found when the current one has no copy on this sheet.
  if (selection.value[c.value.jigPrintSide] === null) {
    const other = SIDES.find(side => selection.value[side] !== null);
    if (other) c.value.jigPrintSide = other;
  }
  close();
}
const signed = (v: number) => (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(2);
</script>

<template>
  <el-dialog :model-value="modelValue" :title="t('placement.dialogTitle')" class="stencil-photo-dialog"
    width="920px" append-to-body align-center :close-on-click-modal="false" :z-index="3200"
    @update:model-value="(value: boolean) => value || close()">
    <div class="photo-align">
      <p class="intro">{{ t('placement.dialogIntro') }}</p>
      <input ref="fileInput" type="file" accept="image/*" hidden @change="onFileChange" />

      <button v-if="!photoUrl" type="button" class="photo-drop" :disabled="busy" @click="fileInput?.click()">
        <svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true">
          <path d="M3.5 7.5h3.5l1.8-2.5h6.4l1.8 2.5h3.5v11h-17z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" />
          <circle cx="12" cy="13" r="3.3" fill="none" stroke="currentColor" stroke-width="1.4" />
        </svg>
        <span>{{ t('placement.choosePhoto') }}</span>
      </button>

      <div v-else class="workspace">
        <div class="photo-frame" :class="{ busy }">
          <svg v-if="photo" ref="svg" :viewBox="`0 0 ${photo.width} ${photo.height}`" class="photo-svg"
            @pointermove="moveDrag" @pointerup="endDrag" @pointercancel="endDrag">
            <image :href="photoUrl" x="0" y="0" :width="photo.width" :height="photo.height" />
            <g v-for="o in overlays" :key="o.key" class="copy-overlay" :class="[o.side, { selected: o.selected }]"
              :style="{ strokeWidth: strokeWidth }">
              <path :d="o.outline" class="copy-outline" />
              <path :d="o.pads" class="copy-pads" />
            </g>
            <g v-if="quad" class="sheet-quad" :style="{ strokeWidth: strokeWidth * 1.5 }">
              <path :d="`M${quad.map(p => p.join(',')).join('L')}Z`" />
              <circle v-for="(p, i) in quad" :key="i" :cx="p[0]" :cy="p[1]" :r="handleRadius" class="corner-handle"
                :aria-label="t('placement.cornerHandle', { n: i + 1 })"
                @pointerdown="startDrag(i, $event)" />
            </g>
          </svg>
          <div v-if="busy" class="busy-overlay" aria-live="polite">{{ t('placement.detecting') }}</div>
        </div>

        <aside class="results" aria-live="polite">
          <p class="sheet-size">{{ t('placement.sheetSize', { x: sheet.x, y: sheet.y }) }}</p>
          <p class="corners-hint">{{ t('placement.cornersHint') }}</p>
          <p v-if="error" class="result-error" role="alert">{{ t(`placement.errors.${error}`) }}</p>
          <p v-if="scaleWarning" class="result-warning">{{ t('placement.scaleWarning', scaleWarning) }}</p>

          <template v-if="copies">
            <section v-for="group in copies" :key="group.side" class="side-results" :class="group.side">
              <h3>{{ t(`placement.${group.side}Copies`) }}</h3>
              <p v-if="!group.hasPads" class="none">{{ t('placement.noLayer') }}</p>
              <p v-else-if="!group.items.length" class="none">{{ t('placement.notFound') }}</p>
              <button v-for="item in group.items" :key="item.index" type="button" class="copy-choice"
                :class="{ active: selection[group.side] === item.index }" :aria-pressed="selection[group.side] === item.index"
                @click="selection[group.side] = selection[group.side] === item.index ? null : item.index">
                <strong>{{ t('placement.copy', { n: item.index + 1 }) }}</strong>
                <span>{{ t('placement.copyDetail', { matched: item.instance.inliers, total: item.instance.total,
                  x: signed(item.placement.x), y: signed(item.placement.y), angle: item.placement.quarter * 90 }) }}</span>
                <span v-if="item.placement.stencilFlipped" class="flip">{{ t('placement.flipNote') }}</span>
                <span v-if="item.tilted" class="flip">{{ t('placement.angleWarning', { deg: item.angle }) }}</span>
              </button>
            </section>
          </template>

          <button type="button" class="secondary" :disabled="busy" @click="fileInput?.click()">{{ t('placement.replacePhoto') }}</button>
        </aside>
      </div>
    </div>
    <template #footer>
      <div class="dialog-actions">
        <el-button @click="close">{{ t('placement.cancel') }}</el-button>
        <el-button type="primary" :disabled="!canApply" @click="apply">{{ t('placement.apply') }}</el-button>
      </div>
    </template>
  </el-dialog>
</template>

<style scoped>
.photo-align { color: var(--text-default); }
.intro { margin: 0 0 12px; color: var(--text-secondary); font-size: 12px; line-height: 1.6; }
.photo-drop { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; width: 100%; min-height: 220px; border: 1.5px dashed var(--surface-line); border-radius: var(--radius-control); background: var(--surface-well); color: var(--text-secondary); font: inherit; cursor: pointer; }
.photo-drop:hover { border-color: var(--interaction-ink); color: var(--interaction-ink); }
.workspace { display: grid; grid-template-columns: minmax(0, 1fr) 260px; gap: 16px; }
@media (max-width: 760px) { .workspace { grid-template-columns: 1fr; } }
.photo-frame { position: relative; min-height: 0; border-radius: var(--radius-control); overflow: hidden; background: var(--surface-well); }
.photo-svg { display: block; width: 100%; max-height: 62dvh; touch-action: none; }
.photo-frame.busy .photo-svg { opacity: .6; }
.busy-overlay { position: absolute; inset: auto 0 0; padding: 8px; background: rgba(0, 0, 0, .55); color: #fff; font-size: 12px; text-align: center; }
.sheet-quad path { fill: none; stroke: #2fd16b; vector-effect: non-scaling-stroke; stroke-width: 2px; }
.corner-handle { fill: rgba(47, 209, 107, .35); stroke: #2fd16b; stroke-width: 2px; vector-effect: non-scaling-stroke; cursor: grab; }
.corner-handle:active { cursor: grabbing; }
.copy-overlay path { fill: none; vector-effect: non-scaling-stroke; }
.copy-overlay .copy-outline { stroke-width: 2px; stroke-dasharray: 6 4; opacity: .7; }
.copy-overlay .copy-pads { stroke-width: 1.2px; opacity: .55; }
.copy-overlay.selected .copy-outline { opacity: 1; stroke-dasharray: none; }
.copy-overlay.selected .copy-pads { opacity: 1; }
.copy-overlay.top path { stroke: #ff4d4f; }
.copy-overlay.bottom path { stroke: #2ec5f2; }
.results { display: flex; flex-direction: column; gap: 10px; min-width: 0; font-size: 12px; }
.results p { margin: 0; line-height: 1.55; }
.sheet-size { font-weight: 600; }
.corners-hint { color: var(--text-secondary); }
.result-error { color: var(--el-color-danger, #d64545); }
.result-warning { color: var(--el-color-warning, #b7791f); }
.side-results { display: flex; flex-direction: column; gap: 6px; }
.side-results h3 { display: flex; align-items: center; gap: 6px; margin: 4px 0 0; font-size: 12px; font-weight: 600; }
.side-results h3::before { content: ''; width: 10px; height: 3px; border-radius: 2px; background: currentColor; }
.side-results.top h3::before { background: #ff4d4f; }
.side-results.bottom h3::before { background: #2ec5f2; }
.none { color: var(--text-tertiary); }
.copy-choice { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; padding: 8px 10px; border: 1px solid var(--surface-line); border-radius: var(--radius-control); background: var(--surface-raised); color: inherit; font: inherit; text-align: left; cursor: pointer; }
.copy-choice.active { border-color: var(--interaction-ink); box-shadow: 0 0 0 1px var(--interaction-ink) inset; }
.copy-choice span { color: var(--text-secondary); font-variant-numeric: tabular-nums; }
.copy-choice .flip { color: var(--el-color-warning, #b7791f); }
.secondary { align-self: flex-start; padding: 6px 10px; border: 1px solid var(--surface-line); border-radius: var(--radius-control); background: transparent; color: var(--text-default); font: inherit; cursor: pointer; }
.dialog-actions { display: flex; justify-content: flex-end; gap: 8px; }
</style>

<style>
.stencil-photo-dialog.el-dialog { max-width: calc(100vw - 32px); max-height: calc(100dvh - 32px); padding: 24px; border: 1px solid var(--surface-line); border-radius: var(--radius-dialog); corner-shape: var(--corner-shape); box-shadow: var(--shadow-float); display: flex; flex-direction: column; }
.stencil-photo-dialog .el-dialog__body { min-height: 0; overflow-y: auto; padding: 0; }
.stencil-photo-dialog .el-dialog__footer { margin-top: 16px; padding: 0; }
</style>
