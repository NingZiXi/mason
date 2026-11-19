<script setup lang="ts">
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import ParameterHelpDiagram from './ParameterHelpDiagram.vue';
import type en from '../i18n/en';
import MotionCollapse from "./MotionCollapse.vue";
import { vAppTooltip } from '../directives/app-tooltip';

defineProps<{ id: string; label: string; topic: keyof typeof en.guide; text?: string; notchVariant?: 'jig' | 'stencil' }>();
const open = ref(false);
const detailsOpen = ref(false);
const heading = ref<HTMLElement | null>(null);
const trigger = ref<HTMLButtonElement | null>(null);
const detailsTrigger = ref<HTMLButtonElement | null>(null);
const visits = ref(0);
const { t } = useI18n();

let pendingReveal: { control: HTMLButtonElement; scrollPositions: { port: HTMLElement; top: number }[] } | undefined;
function rememberReveal(control: HTMLButtonElement | null) {
  pendingReveal = undefined;
  if (!control) return;
  const scrollPositions = [];
  for (let port = control.parentElement; port; port = port.parentElement) {
    const { overflowY } = getComputedStyle(port);
    if (overflowY === 'auto' || overflowY === 'scroll') scrollPositions.push({ port, top: port.scrollTop });
  }
  pendingReveal = { control, scrollPositions };
}

function toggleHelp() {
  open.value = !open.value;
  if (open.value) {
    detailsOpen.value = false;
    visits.value++;
  }
  rememberReveal(open.value ? trigger.value : null);
}

function toggleDetails() {
  detailsOpen.value = !detailsOpen.value;
  rememberReveal(detailsOpen.value ? detailsTrigger.value : null);
}

function revealPanel(panel: Element, control: HTMLButtonElement | null, anchor: HTMLElement | null = control) {
  const reveal = pendingReveal;
  if (!open.value || !reveal || reveal.control !== control) return;
  pendingReveal = undefined;
  // A nearby help card closing can move this trigger without scrolling its container.
  if (reveal.scrollPositions.some(({ port, top }) => Math.abs(port.scrollTop - top) > 4)) return;
  if (!anchor) return;
  const behavior = matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth';
  // Reveal the heading and explanation as a group, stopping before the parameter controls.
  let top = anchor.getBoundingClientRect().top;
  let bottom = panel.getBoundingClientRect().bottom;
  for (const { port } of reveal.scrollPositions) {
    const maxScroll = port.scrollHeight - port.clientHeight;
    if (maxScroll <= 1) continue;
    const style = getComputedStyle(port);
    const edge = port.getBoundingClientRect().top + port.clientTop;
    const start = edge + (parseFloat(style.scrollPaddingTop) || 0);
    const end = edge + port.clientHeight - (parseFloat(style.scrollPaddingBottom) || 0);
    const delta = top < start || bottom - top > end - start ? top - start : Math.max(0, bottom - end);
    const offset = port.scrollTop;
    const target = Math.min(maxScroll, Math.max(0, offset + delta));
    if (Math.abs(target - offset) > 1) port.scrollTo({ top: target, behavior });
    // The sidebar can only reveal the part that will be visible inside a resized card.
    top = Math.max(edge, top - (target - offset));
    bottom = Math.min(edge + port.clientHeight, bottom - (target - offset));
  }
}

function closeHelp(event: KeyboardEvent) {
  if (!open.value) return;
  event.stopPropagation();
  open.value = false;
  pendingReveal = undefined;
  trigger.value?.focus();
}
</script>

<template>
  <div class="inline-help">
    <div ref="heading" class="help-heading">
      <div class="help-label"><slot /></div>
      <button ref="trigger" type="button" class="help-button" :class="{ active: open }"
        v-app-tooltip="open ? false : t('help.show', { label })"
        :aria-label="t(open ? 'help.hide' : 'help.show', { label })"
        :aria-expanded="open" :aria-controls="id" @click="toggleHelp" @keydown.esc="closeHelp">
        <svg viewBox="0 0 20 20" width="16" height="16" fill="none" aria-hidden="true">
          <circle cx="10" cy="10" r="7.25" stroke="currentColor" stroke-width="1.3" />
          <path d="M7.9 7.6a2.1 2.1 0 1 1 3.5 1.55C10.45 9.8 10 10.05 10 11.1" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
          <circle cx="10" cy="13.5" r=".8" fill="currentColor" />
        </svg>
      </button>
      <div v-if="$slots.trailing" class="help-trailing"><slot name="trailing" /></div>
    </div>
    <MotionCollapse :id="id" :open="open" @shown="revealPanel($event, trigger, heading)" @keydown.esc="closeHelp">
      <figure v-if="visits" :key="visits" class="help-figure">
        <ParameterHelpDiagram :topic="topic" :active="open" :notch-variant="notchVariant" />
        <figcaption>{{ t(`guide.${topic}`) }}</figcaption>
        <div v-if="text" class="help-details">
          <button ref="detailsTrigger" type="button" class="help-details-toggle" :aria-expanded="detailsOpen"
            :aria-controls="id + '-details'" @click="toggleDetails">
            <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="m4.5 3 3 3-3 3" /></svg>
            {{ t('guideUi.details') }}
          </button>
          <MotionCollapse :id="id + '-details'" class="help-details-body" :open="detailsOpen"
            @shown="revealPanel($event, detailsTrigger)">
            <p>{{ text }}</p>
          </MotionCollapse>
        </div>
      </figure>
    </MotionCollapse>
    <slot name="control" />
  </div>
</template>

<style scoped>
.help-heading { display: flex; align-items: center; gap: 6px; min-width: 0; min-height: 24px; }
.help-trailing { display: flex; align-items: center; flex: 0 0 auto; margin-inline-start: auto; padding-inline-start: 4px; }
.help-label { min-width: 0; line-height: var(--body-md-line-height); overflow-wrap: anywhere; }
.help-button { --button-press-scale: .92; display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; width: 24px; height: 24px; padding: 0; border: none; border-radius: 50%; background: transparent; color: var(--text-tertiary); cursor: pointer; transition: var(--control-transition); }
.help-button svg { display: block; }
.help-button:hover, .help-button.active { background: var(--control-selection-surface); color: var(--interaction-ink); }
.help-button:focus-visible { outline: 2px solid var(--interaction-border); outline-offset: 2px; }
.help-figure { margin: 6px 0 8px; padding: 8px 10px 6px; background: var(--surface-raised); border: 1px solid var(--surface-line); border-radius: var(--radius-control); corner-shape: var(--corner-shape); color: var(--text-secondary); font-size: var(--body-sm-font-size); font-weight: var(--font-weight-default); line-height: var(--body-md-line-height); overflow-wrap: anywhere; }
.help-figure figcaption { padding: 5px 0 3px; }
.help-details { margin-top: 3px; padding-top: 3px; border-top: 1px solid var(--surface-line); }
.help-details-toggle { display: flex; align-items: center; gap: 4px; width: fit-content; max-width: 100%; min-height: 28px; padding: 0 6px 0 2px; border: 0; border-radius: var(--radius-inner); background: transparent; color: var(--text-brand); font: inherit; text-align: start; cursor: pointer; transition: background-color var(--motion-fast) var(--ease-out); }
.help-details-toggle svg { flex: none; fill: none; stroke: currentColor; stroke-width: 1.4; stroke-linecap: round; stroke-linejoin: round; transition: rotate var(--motion-fast) var(--ease-out); }
.help-details-toggle[aria-expanded='true'] svg { rotate: 90deg; }
.help-details-toggle:hover { background: var(--control-selection-surface); }
.help-details-toggle:focus-visible { outline: 2px solid var(--interaction-border); outline-offset: -1px; }
.help-details-body p { margin: 4px 0 5px; color: var(--text-secondary); }
</style>
