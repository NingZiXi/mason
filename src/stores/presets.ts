import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { DEFAULT, useConfigStore } from "./config";
import {
  DEFAULT_PRESET_ID, PRESETS_STORAGE_KEY, pickPresetSettings, readPresetSettings,
  presetName, type UserPreset,
} from "../lib/config-presets";

export const usePresetsStore = defineStore("config-presets", () => {
  const config = useConfigStore();
  const presets = ref<UserPreset[]>([]);
  const selectedId = ref(DEFAULT_PRESET_ID);
  const busy = ref(false);
  const loadError = ref("");
  let initialization: Promise<void> | undefined;
  const selected = computed(() => presets.value.find((p) => p.id === selectedId.value));
  const dirty = computed(() => JSON.stringify(pickPresetSettings(config.config)) !==
    JSON.stringify(selected.value?.settings ?? pickPresetSettings(DEFAULT)));

  function persist(items: UserPreset[], id: string) {
    try {
      // Commit to disk first: a quota/access error must not look like a successful save.
      localStorage.setItem(PRESETS_STORAGE_KEY, JSON.stringify({ version: 1, selectedId: id, presets: items }));
    } catch { throw new Error("presets.storageFailed"); }
    presets.value = items;
    selectedId.value = id;
    loadError.value = "";
  }

  function initialize(): Promise<void> {
    if (initialization) return initialization;
    busy.value = true;
    initialization = (async () => {
      try {
        const raw = localStorage.getItem(PRESETS_STORAGE_KEY);
        if (!raw) return;
        const data = JSON.parse(raw);
        if (data.version !== 1 || !Array.isArray(data.presets)) throw new Error();
        const items: UserPreset[] = [];
        for (const entry of data.presets) {
          if (!entry || typeof entry.id !== "string" || !entry.id || entry.id === DEFAULT_PRESET_ID ||
              items.some((p) => p.id === entry.id) || typeof entry.name !== "string") throw new Error();
          items.push({ id: entry.id, name: presetName(entry.name, items), settings: readPresetSettings(entry.settings, DEFAULT) });
        }
        const id = items.some((p) => p.id === data.selectedId) ? data.selectedId : DEFAULT_PRESET_ID;
        await config.applyUserSettings(items.find((p) => p.id === id)?.settings ?? pickPresetSettings(DEFAULT));
        presets.value = items;
        selectedId.value = id;
      } catch { loadError.value = "presets.loadFailed"; }
      finally { config.clearParameterHistory(); busy.value = false; }
    })();
    return initialization;
  }

  async function select(id: string) {
    if (busy.value) return;
    const target = presets.value.find((p) => p.id === id);
    if (id !== DEFAULT_PRESET_ID && !target) throw new Error("presets.invalidData");
    const settings = target?.settings ?? pickPresetSettings(DEFAULT);
    busy.value = true;
    try {
      persist(presets.value, id);
      await config.applyUserSettings(settings);
    } finally { busy.value = false; }
  }

  function saveAs(rawName: string) {
    const name = presetName(rawName, presets.value);
    const settings = readPresetSettings(pickPresetSettings(config.config), DEFAULT);
    const id = crypto.randomUUID();
    persist([...presets.value, { id, name, settings }], id);
  }
  function update() {
    if (!selected.value) return;
    const settings = readPresetSettings(pickPresetSettings(config.config), DEFAULT);
    persist(presets.value.map((p) => p.id === selectedId.value ? { ...p, settings } : p), selectedId.value);
  }
  function rename(rawName: string) {
    if (!selected.value) return;
    const name = presetName(rawName, presets.value, selectedId.value);
    persist(presets.value.map((p) => p.id === selectedId.value ? { ...p, name } : p), selectedId.value);
  }
  async function removeSelected() {
    if (!selected.value || busy.value) return;
    busy.value = true;
    try {
      persist(presets.value.filter((p) => p.id !== selectedId.value), DEFAULT_PRESET_ID);
      await config.applyUserSettings(pickPresetSettings(DEFAULT));
    } finally { busy.value = false; }
  }

  return { presets, selectedId, selected, dirty, busy, loadError, initialize, select, saveAs, update, rename, removeSelected };
});
