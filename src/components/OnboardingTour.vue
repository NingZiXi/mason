<script setup lang="ts">
import { computed, ref } from "vue";
import { ElTour, ElTourStep } from "element-plus";
import { useI18n } from "vue-i18n";

const props = defineProps<{ mode: "jig" | "stencil"; context?: "inspection"; root?: HTMLElement }>();
const emit = defineEmits<{ close: [] }>();
const { t } = useI18n();
const current = ref(0);
const copyPrefix = computed(() => props.context === "inspection" ? "inspection.tour" : "onboarding");
const steps = computed(() => props.context === "inspection" ? [
  { key: "select", selector: ".selection-label", placement: "bottom" as const },
  { key: "decide", selector: ".decision-controls", placement: "bottom" as const },
  { key: "compare", selector: ".inspection-segments", placement: "bottom" as const },
] : [
  { key: "modes", selector: ".mode-switch", placement: "bottom" as const },
  { key: "import", selector: "#slot-gerber .dropzone, #slot-gerber .result-header", placement: "right" as const },
  { key: props.mode === "jig" ? "jigParams" : "stencilParams", selector: props.mode === "jig" ? ".stencil-size-section" : "#slot-stencil .slot-header", placement: "right" as const },
  { key: "preview", selector: ".preview-modes", placement: "bottom" as const },
  { key: "export", selector: ".export-actions", placement: "bottom" as const },
]);

// The sidebar clips its contents. Position its scroll before Tour measures a
// target, even when that target happens to lie inside the window's viewport.
function target(selector: string) {
  const element = (props.root ?? document).querySelector<HTMLElement>(selector);
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
    :mask="{ color: 'rgba(15, 24, 21, .48)' }" :scroll-into-view-options="false"
    :content-style="{ width: '350px', maxWidth: 'calc(100vw - 32px)' }" @close="emit('close')">
    <ElTourStep v-for="(step, index) in steps" :key="step.key"
      :target="step.selector ? () => target(step.selector) : undefined" :placement="step.placement"
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
  box-shadow: 0 18px 60px rgba(12, 27, 20, .2);
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
