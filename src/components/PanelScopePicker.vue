<script setup lang="ts">
/**
 * 拼版口径选择器
 *
 * 仅当导入的 Gerber 识别为拼版时出现,在「整版 / 选择子板」之间切换。
 * 切换会重算板框尺寸、钢网尺寸与唇宽,几何随之更新。
 */
import { useI18n } from "vue-i18n";
import { useConfigStore } from "../stores/config";
import type { PanelMode } from "../lib/gerber/panel";
import PanelBoardPicker from "./PanelBoardPicker.vue";

const { t } = useI18n();
const store = useConfigStore();

function pick(mode: PanelMode) {
  store.setPanelMode(mode);
}

function onScopeChange(v: string | number | boolean | undefined) {
  if (v === "panel" || v === "single" || v === "board") pick(v);
}

function onBoardChange(v: string | number | boolean | undefined) {
  const index = typeof v === "number" ? v : Number(v);
  if (Number.isFinite(index)) store.setPanelBoard(index);
}
</script>

<template>
  <div v-if="store.config.panelAvailable" class="panel-scope">
    <label class="field-label">{{ t('gerber.panelScope') }}</label>
    <el-radio-group
      class="scope-group"
      :model-value="store.config.panelMode === 'panel' ? 'panel' : 'board'"
      size="default"
      @change="onScopeChange"
    >
      <el-radio-button value="panel">{{ t('gerber.scopePanel') }}</el-radio-button>
      <el-radio-button value="board">{{ t('gerber.scopeBoard') }}</el-radio-button>
    </el-radio-group>
    <PanelBoardPicker
      v-if="store.panelBoards.length && store.config.panelMode !== 'panel'"
      :boards="store.panelBoards"
      :panel="store.panelOverview!"
      :model-value="store.selectedPanelBoard"
      @update:model-value="onBoardChange"
    />
    <span class="hint">
      {{ t('gerber.panelScopeHint') }}
      <template v-if="store.config.panelGrid">
        ({{ t('gerber.panelGrid', store.config.panelGrid) }})
      </template>
    </span>
  </div>
</template>

<style scoped>
.panel-scope {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 12px;
}

/* 两个选项等分整行,与下方输入框同宽,视觉更规整 */
.scope-group {
  display: flex;
  width: 100%;
}

.scope-group :deep(.el-radio-button) {
  flex: 1;
}

.scope-group :deep(.el-radio-button__inner) {
  width: 100%;
}

.field-label {
  font-size: 12px;
  color: var(--text-secondary);
  font-weight: var(--font-weight-medium);
}

.hint {
  font-size: 11px;
  line-height: 1.5;
  color: var(--text-tertiary);
}
</style>
