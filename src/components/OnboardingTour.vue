<script setup lang="ts">
import { computed, ref } from "vue";
import { ElTour, ElTourStep } from "element-plus";
import { useI18n } from "vue-i18n";

const props = defineProps<{ mode: "jig" | "stencil"; context?: "inspection"; root?: HTMLElement }>();
const emit = defineEmits<{ close: [] }>();
const { t } = useI18n();
const current = ref(0);
const copyPrefix = computed(() => props.context === "inspection" ? "inspection.tour" : "onboarding");
type Step = { key: string; selector: string; fallback?: string; placement: "top" | "bottom" | "left" | "right" };
const steps = computed<Step[]>(() => props.context === "inspection" ? [
  { key: "select", selector: ".pad-hit", placement: "bottom" },
  { key: "decide", selector: ".inspection-sidebar-heading", fallback: ".inspection-sidebar-toggle", placement: "bottom" },
  { key: "compare", selector: ".inspection-segments", placement: "bottom" },
] : [
  { key: "modes", selector: ".mode-switch", placement: "bottom" },
  { key: "import", selector: "#slot-gerber .dropzone, #slot-gerber .result-header", placement: "right" },
  { key: props.mode === "jig" ? "jigParams" : "stencilParams", selector: props.mode === "jig" ? ".stencil-size-section" : "#slot-stencil .slot-header", placement: "right" },
  { key: "preview", selector: ".preview-modes", placement: "bottom" },
  { key: "export", selector: ".export-actions", placement: "bottom" },
]);

function visibleInspectionTarget(element: HTMLElement | null): boolean {
  if (!element || element.closest('[inert], [aria-hidden="true"]')) return false;
  const { visibility, opacity } = getComputedStyle(element);
  if (visibility !== "visible" || opacity === "0") return false;
  const rect = element.getBoundingClientRect();
  const scope = props.root?.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0
    && rect.right > Math.max(0, scope?.left ?? 0)
    && rect.bottom > Math.max(0, scope?.top ?? 0)
    && rect.left < Math.min(window.innerWidth, scope?.right ?? window.innerWidth)
    && rect.top < Math.min(window.innerHeight, scope?.bottom ?? window.innerHeight);
}

function visiblePad(root: HTMLElement | Document, selector: string) {
  const canvas = root.querySelector(".inspection-canvas")?.getBoundingClientRect();
  if (!canvas) return null;
  const sidebar = root.querySelector<HTMLElement>(".inspection-sidebar.is-open");
  const right = Math.min(window.innerWidth, canvas.right,
    visibleInspectionTarget(sidebar) ? sidebar!.getBoundingClientRect().left : Infinity);
  for (const pad of root.querySelectorAll<HTMLElement>(selector)) {
    const { left, top, right: padEnd, bottom, width, height } = pad.getBoundingClientRect();
    if (!width || !height || left < Math.max(0, canvas.left) || padEnd > right
      || top < Math.max(0, canvas.top) || bottom > Math.min(window.innerHeight, canvas.bottom)) continue;
    // A board-wide target can push the guide off screen. Anchor it to a pad
    // with space for the card, or let the tour center itself when zoomed in.
    if (Math.max(top, window.innerHeight - bottom) >= 265) return pad;
  }
  return null;
}

function target({ key, selector, fallback }: Step) {
  const root = props.root ?? document;
  if (props.context === "inspection" && key === "select") return visiblePad(root, selector);
  const element = root.querySelector<HTMLElement>(selector);
  if (props.context === "inspection") {
    if (visibleInspectionTarget(element)) return element;
    const alternative = fallback ? root.querySelector<HTMLElement>(fallback) : null;
    return visibleInspectionTarget(alternative) ? alternative : null;
  }

  // The main sidebar clips its contents, even inside the window's viewport.
  // Scroll it before Tour measures the target.
  const sidebar = element?.closest<HTMLElement>(".app-sidebar");
  if (element && sidebar) {
    const rect = element.getBoundingClientRect();
    const container = sidebar.getBoundingClientRect();
    const top = sidebar.scrollTop + rect.top - container.top - Math.max(16, (sidebar.clientHeight - rect.height) / 2);
    sidebar.scrollTo({ top: Math.max(0, top), behavior: "instant" });
  }
  return element;
}
</script>

<template>
  <ElTour :model-value="true" v-model:current="current" class="mason-onboarding"
    :z-index="4000" :gap="{ offset: 7, radius: 14 }" :target-area-clickable="false"
    :mask="{ color: 'rgba(28, 27, 31, .48)' }" :scroll-into-view-options="false"
    :content-style="{ width: '350px', maxWidth: 'calc(100vw - 32px)' }" @close="emit('close')">
    <ElTourStep v-for="(step, index) in steps" :key="step.key"
      :target="() => target(step)" :placement="step.placement"
      :title="t(`${copyPrefix}.${step.key}Title`)" :show-close="false"
      :prev-button-props="{ children: t('onboarding.previous') }"
      :next-button-props="{ children: t(index === steps.length - 1 ? `${copyPrefix}.finish` : 'onboarding.next') }">
      <p class="tour-copy">{{ t(`${copyPrefix}.${step.key}Body`) }}</p>
      <button type="button" class="tour-skip" @click="emit('close')">{{ t('onboarding.skip') }}</button>
    </ElTourStep>
    <template #indicators="{ current: index, total }">
      <span class="tour-progress">{{ index + 1 }} / {{ total }}</span>
    </template>
  </ElTour>
</template>

<style>
.mason-onboarding .el-tour__content {
  border: 1px solid var(--border-neutral-l2);
  border-radius: 18px;
  padding: 22px;
  background: var(--bg-base-default);
  color: var(--text-default);
  box-shadow: 0 18px 60px rgba(28, 27, 31, .2);
}
.mason-onboarding .el-tour__title { font-size: 16px; font-weight: 600; }
.mason-onboarding .el-tour__footer { margin-top: 18px; }
.mason-onboarding .el-button { border-radius: 9px; min-height: 30px; padding: 7px 13px; }
.mason-onboarding .tour-copy { font-size: 13px; line-height: 1.85; color: var(--text-secondary); margin: 12px 0; }
.mason-onboarding .tour-progress { color: var(--text-tertiary); font-size: 11px; font-variant-numeric: tabular-nums; }
.mason-onboarding .tour-skip { border: 0; background: transparent; color: var(--text-tertiary); padding: 3px 0; font: inherit; font-size: 12px; cursor: pointer; }
.mason-onboarding .tour-skip:hover { color: var(--text-default); }
.mason-onboarding .tour-skip:focus-visible { outline: 2px solid var(--bg-brand); outline-offset: 4px; border-radius: 3px; }
</style>
