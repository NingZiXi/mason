<script setup lang="ts">
import { computed, h, nextTick, ref } from "vue";
import { useI18n } from "vue-i18n";
import { ElMessage, ElMessageBox, ElOptionGroup } from "element-plus";
import type { SelectInstance } from "element-plus";
import { Check, Delete, EditPen, MoreFilled, Plus } from "@element-plus/icons-vue";
import { usePresetsStore } from "../stores/presets";
import { DEFAULT_PRESET_ID, presetName } from "../lib/config-presets";
import { presetCopyName, switchPresetWithEdits, type PresetSwitchChoice } from "../lib/preset-workflow";
import InlineHelp from "./InlineHelp.vue";

const { t } = useI18n();
const store = usePresetsStore();
const working = ref(false);
const presetSelect = ref<SelectInstance>();
const disabled = computed(() => store.busy || working.value);
const showUnsavedStatus = computed(() => !!store.selected && store.dirty);

async function saveCurrent() {
  if (disabled.value || !store.selected || !store.dirty) return;
  await run(() => {
    store.update();
    ElMessage.success(t("presets.saved"));
  });
}

function managePreset(command: string | number | object) {
  if (disabled.value || !store.selected) return;
  if (command === "rename") void namePreset(true);
  if (command === "delete") void remove();
}

async function run(action: () => Promise<void> | void) {
  working.value = true;
  try { await action(); }
  catch (error) {
    if (error === "cancel" || error === "close") return;
    const key = error instanceof Error && error.message.startsWith("presets.") ? error.message : "presets.failed";
    ElMessage.error(t(key));
  } finally { working.value = false; }
}
async function switchPreset(id: string) {
  if (disabled.value || id === store.selectedId) return;
  await run(async () => {
    const result = await switchPresetWithEdits(store, id, {
      choose: () => chooseBeforeSwitch(id),
      requestName: () => requestPresetName(),
    });
    if (result === 'saved-and-switched') ElMessage.success(t('presets.saved'));
  });
}

async function chooseBeforeSwitch(id: string): Promise<PresetSwitchChoice> {
  let choice: PresetSwitchChoice = 'cancel';
  const destination = store.presets.find(preset => preset.id === id)?.name ?? t('presets.default');
  try {
    await ElMessageBox({
      title: t('presets.switchTitle'),
      customClass: 'stencil-review-dialog preset-switch-dialog',
      showCancelButton: false, showConfirmButton: false,
      distinguishCancelAndClose: true, closeOnClickModal: false, autofocus: false,
      message: ({ confirm }) => {
        const action = (value: PresetSwitchChoice, label: string, primary = false) => h('button', {
          type: 'button', class: ['preset-switch-choice', { 'is-primary': primary, 'is-discard': value === 'discard' }],
          onClick: () => { choice = value; confirm(); },
        }, label);
        return h('div', [
          h('p', { class: 'preset-switch-note' }, t('presets.switchMessage', { name: destination })),
          h('div', { class: 'preset-switch-choices' }, [
            store.selected ? action('save', t('presets.saveAndSwitch'), true) : null,
            action('saveAs', t('presets.saveAsAndSwitch'), !store.selected),
            action('discard', t('presets.discardAndSwitch')),
          ]),
        ]);
      },
    });
  } catch { return 'cancel'; }
  return choice;
}
async function addPreset() {
  if (disabled.value) return;
  presetSelect.value?.blur();
  await nextTick();
  await namePreset();
}

async function requestPresetName(rename = false) {
  const { value } = await ElMessageBox.prompt(t("presets.nameHint"), t(rename ? "presets.rename" : "presets.saveAsNew"), {
    inputValue: rename ? store.selected?.name : presetCopyName(store.selected?.name, store.presets, t('presets.copySuffix')),
    inputPlaceholder: t("presets.namePlaceholder"),
    customClass: 'stencil-review-dialog preset-name-dialog', buttonSize: 'default',
    confirmButtonClass: 'stencil-review-confirm', cancelButtonClass: 'stencil-review-back',
    closeOnClickModal: false,
    confirmButtonText: t("presets.save"), cancelButtonText: t("presets.cancel"),
    inputValidator: (value: string) => {
      try { presetName(value ?? "", store.presets, rename ? store.selectedId : undefined); return true; }
      catch { return t("presets.invalidName"); }
    },
  });
  return value;
}

async function namePreset(rename = false) {
  if (disabled.value) return;
  await run(async () => {
    const value = await requestPresetName(rename);
    if (rename) store.rename(value); else store.saveAs(value);
    ElMessage.success(t("presets.saved"));
  });
}
async function remove() {
  await run(async () => {
    await ElMessageBox.confirm(t("presets.deleteConfirm", { name: store.selected?.name }), t("presets.delete"), {
      confirmButtonText: t("presets.delete"), cancelButtonText: t("presets.cancel"), type: "warning",
      customClass: 'stencil-review-dialog preset-delete-dialog', buttonSize: 'default',
      confirmButtonClass: 'stencil-review-confirm', cancelButtonClass: 'stencil-review-back',
      closeOnClickModal: false,
    });
    await store.removeSelected();
  });
}
</script>

<template>
  <section class="config-presets" :aria-label="t('presets.title')" :aria-busy="store.busy || working">
    <div class="preset-header">
      <InlineHelp id="preset-help" class="preset-help" :label="t('presets.title')" :text="t('presets.hint')">
        <label id="preset-label" class="preset-heading">{{ t('presets.title') }}</label>
      </InlineHelp>
      <span class="preset-status" :class="{ 'is-dirty': showUnsavedStatus, 'is-saved': store.selected && !store.dirty }" role="status" aria-live="polite">
        <span v-if="showUnsavedStatus" class="status-dot" aria-hidden="true" />
        <Check v-else-if="store.selected" class="status-icon" aria-hidden="true" />
        {{ t(showUnsavedStatus ? 'presets.unsaved' : store.selected ? 'presets.savedState' : 'presets.builtIn') }}
      </span>
    </div>
    <el-select ref="presetSelect" class="preset-select" popper-class="config-preset-select-menu" :model-value="store.selectedId" :disabled="disabled" aria-labelledby="preset-label" @change="switchPreset">
      <el-option-group :label="t('presets.builtIn')">
        <el-option :value="DEFAULT_PRESET_ID" :label="t('presets.default')" />
      </el-option-group>
      <el-option-group v-if="store.presets.length" :label="t('presets.myPresets')">
        <el-option v-for="preset in store.presets" :key="preset.id" :value="preset.id" :label="preset.name" />
      </el-option-group>
      <template #footer>
        <button type="button" class="preset-add" :disabled="disabled" @click="addPreset">
          <Plus class="action-icon" aria-hidden="true" />
          <span>{{ t('presets.saveAsNew') }}…</span>
        </button>
      </template>
    </el-select>
    <div v-if="store.selected" class="preset-actions">
      <el-button class="preset-primary" :class="{ 'is-current': !store.dirty }" :disabled="disabled || !store.dirty" @click="saveCurrent">
        <Check class="action-icon" aria-hidden="true" />
        <span>{{ t('presets.saveChanges') }}</span>
      </el-button>
      <el-dropdown class="preset-more" popper-class="config-preset-menu" trigger="click" placement="bottom-end" :disabled="disabled" @command="managePreset">
        <el-button class="preset-more-button" :disabled="disabled" :aria-label="t('presets.more')" :title="t('presets.more')">
          <MoreFilled class="action-icon" aria-hidden="true" />
        </el-button>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item command="rename" :icon="EditPen">{{ t('presets.rename') }}</el-dropdown-item>
            <el-dropdown-item command="delete" divided :icon="Delete" class="preset-delete">{{ t('presets.delete') }}</el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
    </div>
    <p v-if="store.loadError" role="alert" class="preset-error">{{ t(store.loadError) }}</p>
  </section>
</template>

<style scoped>
.config-presets { flex-shrink: 0; padding: 14px 16px; border: 1px solid var(--surface-line); border-radius: var(--radius-panel); corner-shape: var(--corner-shape); background: var(--surface-raised); box-shadow: var(--shadow-card); }
.preset-header { position: relative; margin-bottom: 10px; }
.preset-heading { font-size: 13px; font-weight: 600; color: var(--text-default); }
.preset-help :deep(.help-heading) { padding-right: 70px; }
.preset-status { position: absolute; top: 2px; right: 0; display: inline-flex; align-items: center; gap: 4px; min-height: 20px; padding: 0 6px; border-radius: 5px; background: var(--surface-well); color: var(--text-tertiary); font-size: 10px; line-height: 20px; white-space: nowrap; }
.preset-status.is-dirty { color: var(--el-color-warning-dark-2); background: var(--el-color-warning-light-9); }
.preset-status.is-saved { color: var(--text-brand); background: var(--status-success-surface-l1); }
.status-dot { width: 4px; height: 4px; border-radius: 50%; background: currentColor; }
.status-icon { width: 12px; height: 12px; }
.preset-select { width: 100%; }
.preset-select :deep(.el-select__wrapper) { min-height: 36px; border-radius: var(--radius-control); corner-shape: var(--corner-shape); }
:global(.config-preset-select-menu .el-select-dropdown__footer) { padding: 6px; border-top: 1px solid var(--surface-line); }
.preset-add { display: flex; align-items: center; gap: 8px; width: 100%; min-height: 34px; padding: 8px 10px; border: 0; border-radius: var(--radius-inner); background: transparent; color: var(--text-brand); font: inherit; font-size: 12px; text-align: left; cursor: pointer; transition: var(--control-transition); }
.preset-add:hover:not(:disabled) { background: var(--surface-selected); }
.preset-add:active:not(:disabled) { scale: .98; }
.preset-add:focus-visible { outline: 2px solid var(--bg-brand); outline-offset: -2px; }
.preset-add:disabled { opacity: .5; cursor: default; }
.preset-actions { display: flex; align-items: center; gap: 6px; margin-top: 10px; }
.preset-actions .el-button { height: 30px; min-width: 0; margin: 0; padding: 0 12px; border-radius: var(--radius-full); corner-shape: round; font-size: 12px; }
.action-icon { width: 14px; height: 14px; flex-shrink: 0; }
.preset-primary { flex: 1; border-color: transparent; background: var(--bg-brand); color: var(--text-onbrand); }
.preset-primary :deep(> span) { gap: 5px; }
.preset-primary:not(:disabled):hover { background: var(--bg-brand-hover); color: var(--text-onbrand); border-color: transparent; }
.preset-primary.is-current { background: var(--surface-well); border-color: var(--surface-line); color: var(--text-tertiary); }
.preset-more-button { background: var(--surface-raised); border-color: var(--surface-line); color: var(--text-secondary); }
.preset-more-button:not(:disabled):hover { background: var(--surface-well); border-color: var(--surface-line); color: var(--text-default); }
.preset-more { flex-shrink: 0; }
.preset-actions .preset-more-button { width: 30px; padding: 0; }
:global(.config-preset-menu .preset-delete) { color: var(--el-color-danger); }
:global(.config-preset-menu .preset-delete:not(.is-disabled):hover), :global(.config-preset-menu .preset-delete:not(.is-disabled):focus) { color: var(--el-color-danger); background: var(--el-color-danger-light-9); }
.preset-error { margin: 8px 0 0; font-size: 11px; line-height: 1.65; }
.preset-error { color: var(--el-color-danger); }
</style>
