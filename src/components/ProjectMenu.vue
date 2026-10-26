<script setup lang="ts">
import { ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { save, open } from "@tauri-apps/plugin-dialog";
import { useI18n } from "vue-i18n";
import { useConfigStore } from "../stores/config";
import type { ProjectFile } from "../lib/project";
import { ElMessage } from "element-plus";

const { t } = useI18n();
const store = useConfigStore();
const working = ref(false);

async function saveProject() {
  const path = await save({
    title: t("project.saveTitle"),
    defaultPath: "stencil-jig-project.json",
    filters: [{ name: "JSON", extensions: ["json"] }],
  });
  if (!path) return;

  working.value = true;
  try {
    await invoke("save_project", {
      path,
      config: store.projectConfig(),
      gerberFilename: store.config.gerberFilename,
    });
    ElMessage.success(t("project.saved", { path }));
  } catch (e) {
    ElMessage.error(t("project.saveFailed", { msg: e }));
  } finally {
    working.value = false;
  }
}

async function loadProject() {
  const path = await open({
    title: t("project.loadTitle"),
    multiple: false,
    filters: [{ name: "JSON", extensions: ["json"] }],
  });
  if (!path || Array.isArray(path)) return;

  working.value = true;
  try {
    const project = await invoke<ProjectFile>("load_project", { path });
    await store.restoreProject(project.config, project.gerber_filename);

    ElMessage.success(t("project.loaded"));
  } catch (e) {
    ElMessage.error(t("project.loadFailed", { msg: e }));
  } finally {
    working.value = false;
  }
}
</script>

<template>
  <div class="project-menu">
    <el-button-group class="project-menu__actions">
      <el-button :loading="working" size="small" @click="loadProject">
        {{ t('project.load') }}
      </el-button>
      <el-button
        :loading="working"
        size="small"
        type="primary"
        @click="saveProject"
      >
        {{ t('project.save') }}
      </el-button>
    </el-button-group>
    <span
      v-if="store.config.gerberFilename"
      class="project-menu__filename"
    >
      Gerber: <code>{{ store.config.gerberFilename }}</code>
    </span>
  </div>
</template>

<style scoped>
.project-menu {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: var(--spacer-12);
  font-family: var(--font-family-default);
}

.project-menu__filename {
  font-size: var(--body-sm-font-size);
  color: var(--text-tertiary);
  line-height: var(--body-sm-line-height);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 260px;
}

.project-menu__filename code {
  font-family: var(--font-family-mono);
  font-size: var(--body-sm-font-size);
  background: var(--bg-overlay-l1);
  padding: var(--spacer-1, 1px) var(--spacer-6);
  border-radius: var(--radius-4);
  color: var(--text-secondary);
}
</style>
