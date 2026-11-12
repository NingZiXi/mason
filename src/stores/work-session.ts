import { computed, nextTick, ref, shallowRef } from 'vue';
import { defineStore } from 'pinia';
import { useConfigStore } from './config';
import { apertureSnapshot } from '../lib/pad-overrides';
import { normalizePryNotchSides } from '../lib/config-presets';

export type ExportSnapshot = readonly unknown[];

/** Session-only exit reminder. Compare small parameter values and geometry
 * references, never serialize the imported Gerber on each slider movement. */
export const useWorkSessionStore = defineStore('work-session', () => {
  const config = useConfigStore();
  const decisions = computed(() => JSON.stringify(apertureSnapshot(config.config.stencilPadsTop, config.config.stencilPadsBottom)));
  // Region plans can contain thousands of vertices. Track their content once
  // per edit instead of traversing both faces for every unrelated slider tick.
  const reliefPlans = computed(() => JSON.stringify(config.config.componentReliefRegions));
  const current = computed<ExportSnapshot>(() => Object.entries(config.config).map(([key, value]) => {
    if (key === 'pryNotchSides') return normalizePryNotchSides(config.config.pryNotchSides).join(',');
    if (key === 'panelGrid') return JSON.stringify(value);
    if (key === 'componentReliefRegions') return reliefPlans.value;
    // Choosing a mode on the empty welcome screen is not an edit.
    if (key === 'appMode' && !config.config.gerberFilename && !config.config.pcbOutlinePoints.length
      && !config.config.stencilPadsTop.length && !config.config.stencilPadsBottom.length) return null;
    return value;
  }).concat(decisions.value));
  const acknowledged = shallowRef<ExportSnapshot | null>(null);
  const exporting = ref(false);
  const hasUnexportedChanges = computed(() => acknowledged.value !== null
    && current.value.some((value, index) => !Object.is(value, acknowledged.value![index])));
  let initialization: Promise<void> | undefined;
  let confirmation: Promise<boolean> | undefined;

  function initialize(startup?: Promise<void>) {
    initialization ??= (async () => {
      await startup;
      await nextTick();
      acknowledged.value = current.value;
    })();
    return initialization;
  }

  function captureExport(): ExportSnapshot { return current.value.slice(); }
  function markExported(snapshot: ExportSnapshot) { acknowledged.value = snapshot; }

  function confirmExit(prompt: () => Promise<boolean>): Promise<boolean> {
    if (confirmation) return confirmation;
    confirmation = (async () => {
      await initialization;
      await nextTick();
      if (exporting.value) return false;
      if (!hasUnexportedChanges.value) return true;
      return prompt();
    })().finally(() => { confirmation = undefined; });
    return confirmation;
  }

  return { initialize, hasUnexportedChanges, exporting, captureExport, markExported, confirmExit };
});
