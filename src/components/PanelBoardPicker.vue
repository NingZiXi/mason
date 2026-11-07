<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import type { PanelVariant } from "../lib/gerber/panel";
import { pointInPolygon } from "../lib/gerber/geometry";

const props = withDefaults(defineProps<{
  boards: PanelVariant[]; panel: PanelVariant; modelValue: number;
  expanded?: boolean; wholePanel?: boolean;
}>(), { expanded: false, wholePanel: false });
const emit = defineEmits<{ (e: "update:modelValue", value: number): void }>();
const { t } = useI18n();
const selected = computed(() => props.wholePanel ? props.panel : props.boards[props.modelValue]);
const mapSize = computed(() => Math.max(props.panel.width, props.panel.height, 1));

function viewBox(board: PanelVariant, fraction = 0.08) {
  const margin = Math.max(board.width, board.height, 1) * fraction;
  return `${-board.width / 2 - margin} ${-board.height / 2 - margin} ${board.width + margin * 2} ${board.height + margin * 2}`;
}
function shape(board: PanelVariant) {
  return [board.outlinePoints, ...board.outlineHoles].map((ring) =>
    ring.length ? `M${ring.map(([x, y]) => `${x},${y}`).join(" L")}Z` : ""
  ).join(" ");
}
// Keep badges on PCB material, including concave boards and boards with cutouts.
function labelPoint(board: PanelVariant): [number, number] {
  const inside = (x: number, y: number) => pointInPolygon(x, y, board.outlinePoints)
    && !board.outlineHoles.some(hole => pointInPolygon(x, y, hole));
  if (inside(0, 0)) return [0, 0];
  let best: [number, number] = board.outlinePoints[0] ?? [0, 0];
  let distance = Infinity;
  for (let row = 1; row < 16; row++) {
    for (let col = 1; col < 16; col++) {
      const x = board.width * (col / 16 - 0.5), y = board.height * (row / 16 - 0.5);
      if (x * x + y * y < distance && inside(x, y)) {
        best = [x, y]; distance = x * x + y * y;
      }
    }
  }
  return best;
}
const drawings = computed(() => props.boards.map(board => ({ path: shape(board), label: labelPoint(board) })));
function size(board: PanelVariant) { return `${board.width.toFixed(2)} × ${board.height.toFixed(2)}`; }
function label(board: PanelVariant, index: number) {
  return `${t('gerber.boardNumber', { n: index + 1 })} · ${size(board)} mm`;
}
function choose(index: unknown) {
  if (typeof index === "number" && Number.isInteger(index) && props.boards[index]) emit("update:modelValue", index);
}
</script>

<template>
  <div class="board-picker" :class="{ expanded }">
    <div class="map-column">
      <div class="map-surface">
        <div v-if="expanded" class="map-heading">
          <span>{{ t('gerber.boardMap') }}</span>
          <span class="map-count">{{ t('gerber.boardCount', { n: boards.length }) }}</span>
        </div>
        <svg class="board-map" :viewBox="viewBox(panel)" :aria-label="t('gerber.boardMap')">
          <g transform="scale(1, -1)">
            <path :d="shape(panel)" class="panel-boundary" :class="{ 'is-whole': wholePanel }" />
            <g v-for="(board, index) in boards" :key="board.id ?? index"
              :transform="`translate(${board.center.x - panel.center.x}, ${board.center.y - panel.center.y})`">
              <path :d="drawings[index].path" class="board-shape"
                :class="{ selected: !wholePanel && index === modelValue, 'in-panel': wholePanel }"
                role="button" tabindex="0" :aria-label="label(board, index)" :aria-pressed="!wholePanel && index === modelValue"
                @click="choose(index)" @keydown.enter.prevent="choose(index)" @keydown.space.prevent="choose(index)">
                <title>{{ label(board, index) }}</title>
              </path>
              <g class="board-badge" :class="{ selected: !wholePanel && index === modelValue }"
                :transform="`translate(${drawings[index].label[0]}, ${drawings[index].label[1]}) scale(1, -1)`">
                <circle :r="mapSize * 0.032" />
                <text :font-size="mapSize * 0.032">{{ index + 1 }}</text>
              </g>
            </g>
          </g>
        </svg>
        <span class="map-hint">{{ t('gerber.boardMapHint') }}</span>
      </div>
      <div v-if="expanded && selected" class="selection-summary" aria-live="polite">
        <div class="selection-title">
          <span class="selection-dot" />
          <span>{{ wholePanel ? t('gerber.scopePanel') : t('gerber.boardNumber', { n: modelValue + 1 }) }}</span>
          <strong>{{ size(selected) }} <small>mm</small></strong>
        </div>
        <span v-if="selected.topPads || selected.bottomPads" class="pad-summary">
          {{ t('stencil.padCountShort') }} · {{ t('stencil.topShort') }} {{ selected.topPads?.length ?? 0 }} / {{ t('stencil.bottomShort') }} {{ selected.bottomPads?.length ?? 0 }}
        </span>
      </div>
    </div>
    <div v-if="expanded" class="board-list-column">
      <div class="list-heading">{{ t('gerber.boardChoice') }}<span>{{ t('gerber.boardListHint') }}</span></div>
      <div class="board-list" role="group" :aria-label="t('gerber.boardChoice')">
        <button v-for="(board, index) in boards" :key="board.id ?? index" type="button" class="board-card"
          :class="{ selected: !wholePanel && index === modelValue }" :aria-pressed="!wholePanel && index === modelValue"
          @click="choose(index)">
          <span class="board-thumbnail" aria-hidden="true">
            <svg :viewBox="viewBox(board, 0.14)"><path :d="drawings[index].path" transform="scale(1,-1)" /></svg>
          </span>
          <span class="board-card-info"><strong>{{ t('gerber.boardNumber', { n: index + 1 }) }}</strong><span>{{ size(board) }} <small>mm</small></span></span>
          <span class="card-check" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="m4 8 2.5 2.5L12 5" /></svg></span>
        </button>
      </div>
    </div>
    <template v-else>
      <el-select :model-value="modelValue" :aria-label="t('gerber.boardChoice')" @change="choose">
        <el-option v-for="(board, index) in boards" :key="board.id ?? index" :label="label(board, index)" :value="index" />
      </el-select>
      <span v-if="selected && (selected.topPads || selected.bottomPads)" class="pad-summary">
        {{ t('stencil.topShort') }} {{ selected.topPads?.length ?? 0 }} · {{ t('stencil.bottomShort') }} {{ selected.bottomPads?.length ?? 0 }}
      </span>
    </template>
    <span v-if="selected?.inferred || (wholePanel && boards.some(board => board.inferred))" class="inferred-hint">{{ t('gerber.boardInferredHint') }}</span>
  </div>
</template>

<style scoped>
.board-picker { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.map-column { min-width: 0; }
.map-surface { overflow: hidden; border: 1px solid var(--surface-line); border-radius: var(--radius-inner); background-color: var(--surface-well); background-image: radial-gradient(var(--surface-line) 0.8px, transparent 0.8px); background-size: 16px 16px; }
.board-map { display: block; width: 100%; height: 160px; padding: 8px; box-sizing: border-box; }
.panel-boundary { fill: none; stroke: var(--text-tertiary); stroke-opacity: .45; stroke-width: 1; stroke-dasharray: 4 5; vector-effect: non-scaling-stroke; fill-rule: evenodd; pointer-events: none; }
.panel-boundary.is-whole { fill: color-mix(in srgb, var(--bg-brand) 6%, transparent); stroke: var(--bg-brand); stroke-opacity: .8; }
.board-shape { fill: color-mix(in srgb, var(--bg-brand) 7%, var(--surface-raised)); stroke: var(--text-tertiary); stroke-width: 1.2; vector-effect: non-scaling-stroke; fill-rule: evenodd; cursor: pointer; transition: fill var(--motion-fast) var(--ease-out), stroke var(--motion-fast) var(--ease-out); }
.board-shape:focus { outline: none; }
.board-shape:hover, .board-shape:focus-visible { fill: color-mix(in srgb, var(--bg-brand) 20%, var(--surface-raised)); stroke: var(--bg-brand); outline: none; stroke-width: 2; }
.board-shape.selected { fill: color-mix(in srgb, var(--bg-brand) 24%, var(--surface-raised)); stroke: var(--bg-brand); stroke-width: 2; }
.board-shape.in-panel { fill: color-mix(in srgb, var(--bg-brand) 15%, var(--surface-raised)); stroke: var(--bg-brand); }
.board-badge { pointer-events: none; }
.board-badge circle { fill: var(--surface-raised); stroke: var(--surface-line); stroke-width: 1; vector-effect: non-scaling-stroke; transition: fill var(--motion-fast) var(--ease-out); }
.board-badge text { fill: var(--text-secondary); text-anchor: middle; dominant-baseline: central; font-family: var(--font-family-mono); font-weight: 600; }
.board-badge.selected circle { fill: var(--bg-brand); stroke: var(--bg-brand); }
.board-badge.selected text { fill: var(--text-onbrand); }
.map-hint { display: block; padding: 0 12px 10px; text-align: center; }
.map-hint, .pad-summary { font-size: 11px; line-height: 1.5; color: var(--text-tertiary); }
.inferred-hint { font-size: 11px; line-height: 1.6; color: var(--status-warning-default); }
.expanded { display: grid; grid-template-columns: minmax(0, 1fr) 236px; gap: 16px; }
.expanded .board-map { height: clamp(210px, 38vh, 340px); padding: 12px; }
.map-heading { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 14px 16px 0; font-size: 12px; font-weight: 500; color: var(--text-secondary); }
.map-count { font-size: 10px; font-weight: 400; padding: 3px 7px; background: var(--surface-raised); border: 1px solid var(--surface-line); border-radius: var(--radius-full); color: var(--text-tertiary); }
.selection-summary { padding: 14px 2px 0; display: flex; flex-direction: column; gap: 5px; }
.selection-title { display: flex; align-items: center; gap: 7px; color: var(--text-default); font-size: 12px; }
.selection-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--bg-brand); }
.selection-title strong { margin-left: auto; font-family: var(--font-family-mono); font-size: 12px; font-weight: 500; }
.selection-title small, .board-card small { font-family: inherit; font-size: 10px; color: var(--text-tertiary); font-weight: 400; }
.board-list-column { display: flex; flex-direction: column; min-height: 0; min-width: 0; }
.list-heading { display: flex; flex-direction: column; gap: 5px; padding: 3px 2px 14px; font-size: 12px; color: var(--text-default); font-weight: 500; }
.list-heading span { color: var(--text-tertiary); font-size: 11px; font-weight: 400; }
.board-list { display: flex; flex-direction: column; gap: 8px; max-height: clamp(210px, 38vh, 340px); overflow-y: auto; padding: 2px; scrollbar-width: thin; }
.board-card { display: flex; align-items: center; gap: 10px; width: 100%; flex-shrink: 0; padding: 11px 10px; border: 1px solid var(--surface-line); border-radius: var(--radius-control); background: var(--surface-raised); text-align: left; color: var(--text-default); cursor: pointer; transition: background-color var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out); }
.board-card:hover { background: var(--surface-well); border-color: var(--text-tertiary); }
.board-card.selected { background: color-mix(in srgb, var(--bg-brand) 7%, var(--surface-raised)); border-color: var(--bg-brand); }
.board-card:focus { outline: none; }
.board-card:focus-visible { outline: 2px solid var(--bg-brand); outline-offset: 1px; }
.board-thumbnail { display: flex; justify-content: center; align-items: center; width: 40px; height: 40px; flex-shrink: 0; background: var(--surface-well); border-radius: 8px; }
.board-thumbnail svg { width: 32px; height: 32px; }
.board-thumbnail path { fill: color-mix(in srgb, var(--bg-brand) 18%, var(--surface-raised)); stroke: var(--bg-brand); stroke-width: 1; vector-effect: non-scaling-stroke; fill-rule: evenodd; }
.board-card-info { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.board-card-info strong { font-size: 12px; font-weight: 500; }
.board-card-info > span { font-family: var(--font-family-mono); font-size: 10px; color: var(--text-secondary); }
.card-check { margin-left: auto; width: 16px; height: 16px; flex-shrink: 0; border-radius: 50%; border: 1px solid var(--surface-line); }
.card-check svg { display: block; width: 16px; height: 16px; fill: none; stroke: transparent; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
.selected .card-check { border-color: var(--bg-brand); background: var(--bg-brand); }
.selected .card-check svg { stroke: var(--text-onbrand); }
.expanded .inferred-hint { grid-column: 1 / -1; padding: 10px 12px; border-radius: var(--radius-control); background: var(--status-warning-surface-l1); }
@media (max-width: 660px) {
  .expanded { grid-template-columns: minmax(0, 1fr); }
  .expanded .board-map { height: 220px; }
  .board-list { max-height: 160px; }
}
</style>
