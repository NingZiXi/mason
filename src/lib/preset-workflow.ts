import { nextTick } from 'vue';
import type { usePresetsStore } from '../stores/presets';
import { presetName, type UserPreset } from './config-presets';

export type PresetSwitchChoice = 'save' | 'saveAs' | 'discard' | 'cancel';
type PresetStore = ReturnType<typeof usePresetsStore>;

/** Copy the edited settings, with a unique name that still fits the name limit. */
export function presetCopyName(source: string | undefined, presets: UserPreset[], copyLabel: string): string {
  if (!source) return '';
  for (let index = 1; ; index++) {
    const suffix = ` · ${copyLabel}${index === 1 ? '' : ` ${index}`}`;
    const base = source.slice(0, 40 - suffix.length).replace(/[\uD800-\uDBFF]$/, '').trimEnd();
    const candidate = `${base}${suffix}`;
    try { return presetName(candidate, presets); } catch { /* Try the next copy number. */ }
  }
}

/** Do not select the destination until any requested save has completed.
 * Cancelling either dialog or a storage failure leaves the edits in place. */
export async function switchPresetWithEdits(store: PresetStore, target: string, ui: {
  choose: () => Promise<PresetSwitchChoice>;
  requestName: () => Promise<string | null>;
}): Promise<'switched' | 'saved-and-switched' | 'cancelled'> {
  if (target === store.selectedId) return 'cancelled';
  await nextTick();
  let saved = false;
  if (store.dirty) {
    const choice = await ui.choose();
    if (choice === 'cancel') return 'cancelled';
    if (choice === 'save') {
      if (!store.selected) return 'cancelled'; // Built-in defaults cannot be overwritten.
      store.update();
      saved = true;
    } else if (choice === 'saveAs') {
      const name = await ui.requestName();
      if (name === null) return 'cancelled';
      store.saveAs(name);
      saved = true;
    }
  }
  await store.select(target);
  return saved ? 'saved-and-switched' : 'switched';
}
