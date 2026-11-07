<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useConfigStore } from '../stores/config';
import { assemblyHardware, CLAMP_SHEET_ESTIMATE } from '../lib/assembly-hardware';
import InlineHelp from './InlineHelp.vue';

const store = useConfigStore();
const { t } = useI18n();
const hardware = computed(() => assemblyHardware(store.config, store.screwPositions.length));
const number = (value: number) => Number(value.toFixed(2)).toString();
const size = computed(() => {
  const h = hardware.value;
  if (h.screwLength !== null) return `${store.config.screwSpec} × ${h.screwLength} mm`;
  if (h.lengthRange) return `${store.config.screwSpec} × ${number(h.lengthRange[0])}–${number(h.lengthRange[1])} mm`;
  return h.state === 'selfTap' ? t('hardware.matchPilot') : store.config.screwSpec;
});
</script>

<template>
  <section class="hardware-card" :aria-label="t('hardware.title')">
    <InlineHelp id="assembly-hardware-help" :label="t('hardware.title')"
      :text="t('hardware.help', { thickness: CLAMP_SHEET_ESTIMATE })">
      <h3 class="hardware-title">{{ t('hardware.title') }}</h3>
    </InlineHelp>
    <p v-if="hardware.state === 'off'" class="hardware-empty">{{ t('hardware.off') }}</p>
    <template v-else>
      <dl class="hardware-list">
        <div class="hardware-row">
          <svg class="hardware-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M7 4h10v4H7zM10 8v12h4V8M10 11h4M10 14h4M10 17h4M10 20h4M10 4v4m4-4v4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
          <dt class="hardware-item">
            <span>{{ t(hardware.state === 'selfTap' ? 'hardware.selfTapName' : 'hardware.screw') }}</span>
            <strong>{{ size }}</strong>
            <small v-if="hardware.screwLength !== null">{{ t('hardware.reference') }}</small>
          </dt>
          <dd class="hardware-quantity">× {{ t('hardware.screwCount', { n: hardware.screwCount }) }}</dd>
        </div>
        <div class="hardware-row" :class="{ 'is-unused': !hardware.nutCount }">
          <svg class="hardware-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="m12 3 8 4.5v9L12 21l-8-4.5v-9z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" />
            <circle cx="12" cy="12" r="3.2" stroke="currentColor" stroke-width="1.3" />
          </svg>
          <dt class="hardware-item">
            <span>{{ t('hardware.nut') }}</span>
            <strong>{{ hardware.nutCount ? store.config.screwSpec : t('hardware.noNut') }}</strong>
            <small v-if="hardware.nutCount">{{ t('hardware.nutSize', { across: number(store.config.nutAcrossFlats), height: number(store.config.nutHeight) }) }}</small>
          </dt>
          <dd class="hardware-quantity">{{ hardware.nutCount ? `× ${t('hardware.nutCount', { n: hardware.nutCount })}` : '—' }}</dd>
        </div>
      </dl>
      <p v-if="hardware.state !== 'ready'" class="hardware-note">{{ t(`hardware.${hardware.state}`, { diameter: number(store.config.periScrewD) }) }}</p>
      <p v-else-if="hardware.customFit" class="hardware-note">{{ t('hardware.customFit') }}</p>
    </template>
  </section>
</template>

<style scoped>
.hardware-card { margin: 2px 0 12px; padding: 12px 14px; border: 1px solid var(--surface-line); border-radius: var(--radius-popover); corner-shape: var(--corner-shape); background: var(--surface-well); }
.hardware-title { margin: 0; font-size: 12px; font-weight: 600; color: var(--text-default); }
.hardware-list { margin: 8px 0 0; }
.hardware-row { display: flex; align-items: center; gap: 10px; padding: 9px 0; }
.hardware-row + .hardware-row { border-top: 1px solid var(--surface-line); }
.hardware-icon { width: 24px; height: 24px; flex-shrink: 0; color: var(--text-secondary); }
.hardware-item { display: flex; flex-wrap: wrap; align-items: baseline; gap: 3px 8px; min-width: 0; flex: 1; }
.hardware-item > span { width: 100%; font-size: 11px; line-height: 16px; color: var(--text-secondary); }
.hardware-item strong { font-family: var(--font-family-metric); font-size: 13px; font-weight: 600; line-height: 20px; color: var(--text-default); overflow-wrap: anywhere; }
.hardware-item small { color: var(--text-tertiary); font-size: 10px; line-height: 16px; }
.hardware-quantity { margin: 0; flex-shrink: 0; font-family: var(--font-family-metric); color: var(--text-brand); font-size: 12px; font-weight: 500; font-variant-numeric: tabular-nums; }
.is-unused .hardware-icon, .is-unused .hardware-item strong, .is-unused .hardware-quantity { color: var(--text-tertiary); }
.hardware-note, .hardware-empty { margin: 6px 0 0; font-size: 11px; line-height: 1.7; overflow-wrap: anywhere; color: var(--text-secondary); }
.hardware-note { padding-top: 8px; border-top: 1px solid var(--surface-line); color: var(--status-warning-default); }
</style>
