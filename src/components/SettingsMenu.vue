<script setup lang="ts">
import { ref, onMounted, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useUiStore } from "../stores/ui";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getVersion } from "@tauri-apps/api/app";
import { isTauri } from "@tauri-apps/api/core";
import { ElMessageBox, ElNotification } from "element-plus";
import { useUpdaterStore } from "../stores/updater";
import { useExitConfirmation } from "../composables/useExitConfirmation";
import { version } from "../../package.json";
import { LOCALE_NAMES } from '../lib/locales';

const { t } = useI18n();
const emit = defineEmits<{ startTour: [] }>();
const replayTour = ref(false);
const ui = useUiStore();
const updater = useUpdaterStore();
const confirmExit = useExitConfirmation();
const canUpdate = isTauri() && !import.meta.env.DEV;
const confirmingUpdate = ref(false);
const showSettings = ref(false);
const appVersion = ref("");
const activeTab = ref<"about" | "general">("about");
const aboutPane = ref<HTMLElement | null>(null);
const generalPane = ref<HTMLElement | null>(null);
const settingsTransition = { name: 'settings-reveal', duration: { enter: 300, leave: 180 } };
watch(activeTab, tab => {
  const pane = tab === 'about' ? aboutPane.value : generalPane.value;
  if (pane) pane.scrollTop = 0;
});

onMounted(async () => {
  try {
    appVersion.value = await getVersion();
  } catch {
    appVersion.value = version;
  }
  if (canUpdate && ui.checkUpdatesOnStartup) {
    await updater.checkForUpdates();
    if (updater.update) {
      ElNotification({
        title: t("updates.available", { version: updater.update.version }),
        message: t("updates.notification"),
        duration: 8000,
        onClick: () => { activeTab.value = "about"; showSettings.value = true; },
      });
    }
  }
});

async function installUpdate() {
  if (confirmingUpdate.value || updater.busy) return;
  confirmingUpdate.value = true;
  try {
    await ElMessageBox.confirm(t("updates.confirm"), t("updates.title"), {
      confirmButtonText: t("updates.install"), cancelButtonText: t("updates.later"), type: "warning",
      customClass: 'stencil-review-dialog update-review-dialog', buttonSize: 'default',
      confirmButtonClass: 'stencil-review-confirm', cancelButtonClass: 'stencil-review-back',
      modalClass: 'app-confirm-overlay', appendTo: 'body', closeOnClickModal: false,
    });
    await updater.installUpdate(confirmExit);
  } catch {
    // Closing or cancelling the confirmation leaves the update available.
  } finally {
    confirmingUpdate.value = false;
  }
}

async function restart() {
  if (await confirmExit()) await updater.restart();
}

const REPO_URL = "https://github.com/NingZiXi/mason";
const ISSUE_URL = "https://github.com/NingZiXi/mason/issues";
const AUTHOR_URL = "https://github.com/NingZiXi";

function openLink(url: string) {
  openUrl(url).catch(console.error);
}

function closeSettings() {
  showSettings.value = false;
}

function onSettingsClosed() {
  if (!replayTour.value) return;
  replayTour.value = false;
  emit("startTour");
}
</script>

<template>
  <button class="settings-btn" :title="t('settings.button')" :aria-label="t('settings.button')" aria-haspopup="dialog" :aria-expanded="showSettings" @click="showSettings = true">
    <span v-if="updater.update" class="update-dot" :title="t('updates.title')" />
    <svg viewBox="0 0 24 24" width="15" height="15">
      <circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="2" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1.08-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1.08 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33h.08a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.08a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"
        fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  </button>

  <!-- Escape the header stacking context so the mask covers all preview controls. -->
  <el-dialog v-model="showSettings" width="680px" :title="t('settings.button')" :show-close="false" append-to-body align-center :z-index="3000" modal-class="settings-overlay" class="settings-dialog" :transition="settingsTransition" @closed="onSettingsClosed">
    <div class="dialog-root">
      <!-- 顶部栏 -->
      <div class="dialog-header">
        <div class="header-left">
          <svg class="header-icon" viewBox="0 0 24 24" width="16" height="16">
            <circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="2" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1.08-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1.08 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33h.08a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.08a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"
              fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
          <span class="header-title">{{ t('settings.button') }}</span>
        </div>
        <button class="close-btn" :title="t('settings.close')" :aria-label="t('settings.close')" @click="closeSettings">
          <svg viewBox="0 0 16 16" width="14" height="14">
            <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
          </svg>
        </button>
      </div>

      <!-- 主体:左菜单 + 右内容 -->
      <div class="dialog-body">
        <nav class="sidebar" :aria-label="t('settings.button')">
          <span class="nav-indicator" :class="{ 'is-general': activeTab === 'general' }" aria-hidden="true" />
          <button
            class="nav-item"
            :class="{ active: activeTab === 'about' }"
            :aria-current="activeTab === 'about' ? 'page' : undefined"
            @click="activeTab = 'about'"
          >
            <svg viewBox="0 0 16 16" width="15" height="15">
              <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.3" />
              <path d="M8 7v4M8 5.4v.6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
            </svg>
            <span>{{ t('settings.about') }}</span>
          </button>
          <button
            class="nav-item"
            :class="{ active: activeTab === 'general' }"
            :aria-current="activeTab === 'general' ? 'page' : undefined"
            @click="activeTab = 'general'"
          >
            <svg viewBox="0 0 16 16" width="15" height="15">
              <circle cx="8" cy="8" r="2.2" fill="none" stroke="currentColor" stroke-width="1.3" />
              <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" />
            </svg>
            <span>{{ t('settings.general') }}</span>
          </button>
        </nav>

        <div class="content">
          <!-- 关于 -->
          <div ref="aboutPane" class="pane pane-about" :class="{ 'is-active': activeTab === 'about' }"
            :inert="activeTab !== 'about'" :aria-hidden="activeTab !== 'about'">
            <div class="about-hero">
              <div class="app-logo">
                <svg viewBox="0 0 64 64" width="36" height="36">
                  <path d="M14 14 L50 14 L50 26 L26 26 L26 38 L50 38 L50 50 L14 50" fill="none" stroke="currentColor" stroke-width="6" stroke-linecap="round" stroke-linejoin="round" />
                  <circle cx="14" cy="14" r="5" fill="currentColor" />
                  <circle cx="14" cy="50" r="5" fill="var(--settings-logo-accent, var(--brand-accent, #E07A3C))" />
                </svg>
              </div>
              <div class="app-meta">
                <div class="app-name">{{ t('app.title') }}</div>
                <div class="app-version">v{{ appVersion || version }}</div>
              </div>
            </div>

            <p class="about-desc">{{ t('about.desc') }}</p>

            <div class="update-card" aria-live="polite">
              <strong>{{ t('updates.title') }}</strong>
              <p v-if="!canUpdate">{{ t('updates.development') }}</p>
              <template v-else>
                <p v-if="updater.status === 'checking'">{{ t('updates.checking') }}</p>
                <p v-else-if="updater.status === 'latest'">{{ t('updates.latest') }}</p>
                <p v-else-if="updater.status === 'downloading'">
                  {{ updater.total ? t('updates.progress', { percent: updater.progress }) : t('updates.downloading') }}
                </p>
                <p v-else-if="updater.status === 'installing'">{{ t('updates.installing') }}</p>
                <p v-else-if="updater.status === 'ready'">{{ t('updates.ready') }}</p>
                <p v-else-if="updater.update">{{ t('updates.available', { version: updater.update.version }) }}</p>
                <p v-else>{{ t(ui.checkUpdatesOnStartup ? 'updates.automatic' : 'updates.manualOnly') }}</p>
                <el-progress v-if="updater.status === 'downloading' && updater.total" :percentage="updater.progress" />
                <pre v-if="updater.update?.body" class="update-notes">{{ updater.update.body }}</pre>
                <p v-if="updater.error" class="update-error">{{ t('updates.failed') }}<br>{{ updater.error }}</p>
                <div class="update-actions">
                  <el-button v-if="updater.status === 'ready'" size="small" type="primary" @click="restart">{{ t('updates.restart') }}</el-button>
                  <template v-else>
                    <el-button size="small" :loading="updater.status === 'checking'" :disabled="updater.busy || confirmingUpdate" @click="updater.checkForUpdates()">{{ t('updates.check') }}</el-button>
                    <el-button v-if="updater.update" size="small" type="primary" :loading="updater.status === 'downloading' || updater.status === 'installing'" :disabled="updater.busy || confirmingUpdate" @click="installUpdate">{{ t('updates.install') }}</el-button>
                  </template>
                </div>
              </template>
            </div>

            <div class="link-list">
              <a class="link-row" :href="REPO_URL" @click.prevent="openLink(REPO_URL)">
                <span class="link-label">{{ t('about.repo') }}</span>
                <span class="link-cta">
                  {{ t('about.openRepo') }}
                  <svg viewBox="0 0 16 16" width="12" height="12" class="arrow">
                    <path d="M4 3h7v7M11 3L4 10" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
                  </svg>
                </span>
              </a>
              <a class="link-row" :href="ISSUE_URL" @click.prevent="openLink(ISSUE_URL)">
                <span class="link-label">{{ t('about.feedback') }}</span>
                <span class="link-cta">
                  {{ t('about.submitIssue') }}
                  <svg viewBox="0 0 16 16" width="12" height="12" class="arrow">
                    <path d="M4 3h7v7M11 3L4 10" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
                  </svg>
                </span>
              </a>
              <a class="link-row" :href="AUTHOR_URL" @click.prevent="openLink(AUTHOR_URL)">
                <span class="link-label">{{ t('about.author') }}</span>
                <span class="link-cta">
                  {{ t('about.openAuthor') }}
                  <svg viewBox="0 0 16 16" width="12" height="12" class="arrow">
                    <path d="M4 3h7v7M11 3L4 10" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
                  </svg>
                </span>
              </a>
              <div class="link-row">
                <span class="link-label">{{ t('about.license') }}</span>
                <span class="link-cta link-value">{{ t('about.licenseValue') }}</span>
              </div>
              <div class="link-row">
                <span class="link-label">{{ t('about.stack') }}</span>
                <span class="link-cta link-value">{{ t('about.stackValue') }}</span>
              </div>
            </div>
          </div>

          <!-- 通用:界面与工作习惯 -->
          <div ref="generalPane" class="pane pane-general" :class="{ 'is-active': activeTab === 'general' }"
            :inert="activeTab !== 'general'" :aria-hidden="activeTab !== 'general'">
            <section class="setting-section">
              <h3 class="section-title">{{ t('settings.interface') }}</h3>
            <div class="setting-row">
              <div class="setting-label">
                <span class="label-text">{{ t('settings.theme') }}</span>
              </div>
              <div class="seg-group" role="group" :aria-label="t('settings.theme')"
                :style="{ '--segment-count': 3, '--segment-index': ui.theme === 'light' ? 0 : ui.theme === 'dark' ? 1 : 2 }">
                <span class="seg-indicator" aria-hidden="true" />
                <button
                  class="seg-btn"
                  :class="{ active: ui.theme === 'light' }" :aria-pressed="ui.theme === 'light'"
                  @click="ui.setTheme('light')"
                >
                  <svg viewBox="0 0 16 16" width="14" height="14">
                    <circle cx="8" cy="8" r="3" fill="none" stroke="currentColor" stroke-width="1.4" />
                    <path d="M8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.4 1.4M11.6 11.6L13 13M13 3l-1.4 1.4M4.4 11.6L3 13"
                      fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
                  </svg>
                  {{ t('settings.light') }}
                </button>
                <button
                  class="seg-btn"
                  :class="{ active: ui.theme === 'dark' }" :aria-pressed="ui.theme === 'dark'"
                  @click="ui.setTheme('dark')"
                >
                  <svg viewBox="0 0 16 16" width="14" height="14">
                    <path d="M13.5 9.5A6 6 0 0 1 6.5 2.5a6 6 0 1 0 7 7z"
                      fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" />
                  </svg>
                  {{ t('settings.dark') }}
                </button>
                <button class="seg-btn" :class="{ active: ui.theme === 'system' }"
                  :aria-pressed="ui.theme === 'system'" @click="ui.setTheme('system')">
                  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden="true">
                    <rect x="1.5" y="2.5" width="13" height="9" rx="1.5" stroke="currentColor" stroke-width="1.3" />
                    <path d="M8 11.5v2M5.5 13.5h5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
                  </svg>
                  {{ t('settings.system') }}
                </button>
              </div>
            </div>
            <div class="setting-row">
              <div class="setting-label">
                <span class="label-text">{{ t('settings.language') }}</span>
                <p v-if="ui.locale === 'system'" class="setting-hint">{{ t('settings.languageSystemHint') }}</p>
              </div>
              <el-select class="language-select" popper-class="settings-language-menu" :model-value="ui.locale" :aria-label="t('settings.language')" @change="ui.setLocale">
                <el-option value="system" :label="t('settings.languageSystem')" />
                <el-option v-for="(label, value) in LOCALE_NAMES" :key="value" :value="value" :label="label" />
              </el-select>
            </div>
            </section>
            <section v-if="ui.sakuraUnlocked" class="setting-section skin-section">
              <h3 class="section-title">{{ t('skin.title') }}</h3>
              <div class="skin-options" role="group" :aria-label="t('skin.title')">
                <button v-for="skin in (['classic', 'sakura'] as const)" :key="skin" type="button"
                  class="skin-card" :class="{ 'is-selected': ui.skin === skin }"
                  :aria-pressed="ui.skin === skin" :disabled="ui.skinCelebrationActive" @click="ui.setSkin(skin)">
                  <span class="skin-preview" :class="`skin-preview--${skin}`" aria-hidden="true">
                    <span class="skin-preview-header"><i /><i /><i /></span>
                    <span class="skin-preview-sidebar"><i /><i /><i /></span>
                    <span class="skin-preview-workspace"><span class="skin-preview-board"><i /><i /><i /><i /></span></span>
                  </span>
                  <span class="skin-card-title">
                    <span>{{ t(`skin.${skin}`) }}</span>
                    <span class="skin-card-check" aria-hidden="true">
                      <svg viewBox="0 0 12 12" width="10" height="10" fill="none">
                        <path d="m2.5 6 2.3 2.3 4.7-4.6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
                      </svg>
                    </span>
                  </span>
                  <span class="skin-card-hint">{{ t(`skin.${skin}Hint`) }}</span>
                </button>
              </div>
            </section>
            <section class="setting-section">
              <h3 class="section-title">{{ t('settings.workflow') }}</h3>
              <div class="setting-row">
                <div class="setting-label">
                  <span class="label-text">{{ t('settings.startupUpdates') }}</span>
                  <p id="startup-updates-hint" class="setting-hint">{{ t('settings.startupUpdatesHint') }}</p>
                </div>
                <button type="button" class="setting-switch" :class="{ 'is-on': ui.checkUpdatesOnStartup }"
                  role="switch" :aria-checked="ui.checkUpdatesOnStartup" :aria-label="t('settings.startupUpdates')"
                  aria-describedby="startup-updates-hint" @click="ui.checkUpdatesOnStartup = !ui.checkUpdatesOnStartup"><span /></button>
              </div>
              <div class="setting-row">
                <div class="setting-label">
                  <span class="label-text">{{ t('settings.defaultExport') }}</span>
                  <p class="setting-hint">{{ t('settings.defaultExportHint') }}</p>
                </div>
                <div class="seg-group" role="group" :aria-label="t('settings.defaultExport')"
                  :style="{ '--segment-index': ui.defaultExportFormat === 'stl' ? 0 : 1 }">
                  <span class="seg-indicator" aria-hidden="true" />
                  <button class="seg-btn" :class="{ active: ui.defaultExportFormat === 'stl' }"
                    :aria-pressed="ui.defaultExportFormat === 'stl'" @click="ui.defaultExportFormat = 'stl'">STL</button>
                  <button class="seg-btn" :class="{ active: ui.defaultExportFormat === 'step' }"
                    :aria-pressed="ui.defaultExportFormat === 'step'" @click="ui.defaultExportFormat = 'step'">STEP</button>
                </div>
              </div>
            </section>
            <section class="setting-section">
              <div class="setting-row">
                <div class="setting-label">
                  <span class="label-text">{{ t('onboarding.replayTitle') }}</span>
                  <p class="setting-hint">{{ t('onboarding.replayHint') }}</p>
                </div>
                <el-button size="small" @click="replayTour = true; closeSettings()">{{ t('onboarding.replay') }}</el-button>
              </div>
            </section>
            <p class="save-hint">{{ t('settings.savedAutomatically') }}</p>
          </div>
        </div>
      </div>
    </div>
  </el-dialog>
</template>

<style scoped>
.settings-btn {
  position: relative;
  width: 32px;
  height: 32px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--border-neutral-l2);
  border-radius: var(--radius-control);
  corner-shape: var(--corner-shape);
  background: var(--bg-base-default);
  color: var(--text-secondary);
  cursor: pointer;
  transition: var(--control-transition);
}
.settings-btn:hover {
  background: var(--bg-overlay-l1);
  color: var(--text-default);
}
.settings-btn > svg { transform: rotate(0deg); transform-origin: center; transition: transform var(--motion-release) var(--ease-out); }
.settings-btn:hover:not(:disabled) > svg { transform: rotate(22deg); }

/* 对话框根容器 */
.dialog-root {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

/* 顶部栏 */
.dialog-header {
  background: var(--surface-raised);
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 44px;
  padding: 0 14px 0 16px;
  border-bottom: 1px solid var(--border-neutral-l1);
  flex-shrink: 0;
}
.header-left {
  display: flex;
  align-items: center;
  gap: 8px;
}
.header-icon {
  color: var(--text-brand);
  display: flex;
}
.header-title {
  font-size: 14px;
  line-height: var(--body-base-line-height);
  font-weight: var(--font-weight-strong);
  color: var(--text-default);
}
.close-btn {
  width: 28px;
  height: 28px;
  padding: 0;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  color: var(--text-tertiary);
  border-radius: var(--radius-control);
  corner-shape: var(--corner-shape);
  cursor: pointer;
  transition: var(--control-transition);
}
.close-btn:hover {
  background: var(--bg-overlay-l1);
  color: var(--text-default);
}
.header-left > svg, .close-btn > svg, .nav-item > svg, .seg-btn > svg, .link-cta > svg { display: block; flex-shrink: 0; }

/* The dialog frame stays fixed; each page scrolls inside the same content area. */
.dialog-body {
  display: flex;
  flex: 1;
  min-height: 0;
}

.update-dot { position: absolute; top: 2px; right: 2px; width: 7px; height: 7px; border-radius: 50%; background: var(--text-brand); }
.update-card { padding: 12px; border: 1px solid var(--surface-line); border-radius: var(--radius-popover); corner-shape: var(--corner-shape); background: var(--surface-well); font-size: 12px; color: var(--text-secondary); }
.update-card > strong { display: block; color: var(--text-default); font-size: var(--heading-2xs-font-size); font-weight: var(--font-weight-strong); line-height: var(--body-md-line-height); }
.update-card p { margin: 8px 0; line-height: var(--body-md-line-height); }
.update-notes { max-height: 140px; margin: 10px 0; padding-top: 10px; border-top: 1px solid var(--surface-line); overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; line-height: var(--body-md-line-height); }
.update-error { color: var(--el-color-danger); overflow-wrap: anywhere; }
.update-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
.update-actions .el-button { max-width: 100%; height: auto; min-height: 24px; margin-left: 0; padding-block: 2px; line-height: 18px; white-space: normal; }
.update-actions :deep(.el-button > span) { min-width: 0; white-space: normal; overflow-wrap: anywhere; }

/* 侧边栏 */
.sidebar {
  position: relative;
  background: var(--surface-sidebar);
  width: 132px;
  flex-shrink: 0;
  padding: 10px 8px;
  border-right: 1px solid var(--border-neutral-l1);
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.nav-indicator {
  position: absolute;
  top: 10px;
  left: 8px;
  right: 8px;
  height: 36px;
  border-radius: var(--radius-control);
  corner-shape: var(--corner-shape);
  background: var(--status-success-surface-l1);
  box-shadow: none;
  transform: translateY(0);
  transition: transform var(--motion-release) cubic-bezier(.2, .9, .24, 1);
  pointer-events: none;
}
.nav-indicator.is-general { transform: translateY(40px); }
.nav-item {
  position: relative;
  z-index: 1;
  height: 36px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border: none;
  border-radius: var(--radius-control);
  corner-shape: var(--corner-shape);
  background: transparent;
  color: var(--text-secondary);
  font-size: 13px;
  font-weight: var(--font-weight-medium);
  cursor: pointer;
  text-align: left;
  transition: var(--control-transition);
}
.nav-item:hover {
  background: var(--bg-overlay-l1);
  color: var(--text-default);
}
.nav-item.active {
  background: transparent;
  color: var(--text-brand);
}

/* 内容区 */
.content {
  position: relative;
  flex: 1;
  min-width: 0;
  min-height: 0;
  background: var(--surface-raised);
  overflow: hidden;
}
.pane {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 22px 24px;
  overflow-y: auto;
  scrollbar-gutter: stable;
  visibility: hidden;
  opacity: 0;
  pointer-events: none;
  transform: translateY(7px);
  transition: opacity 120ms var(--ease-out), transform 220ms var(--ease-out), visibility 220ms;
}
.pane > * { flex-shrink: 0; }
.pane-about { transform: translateY(-7px); }

.pane.is-active {
  z-index: 1;
  visibility: visible;
  opacity: 1;
  pointer-events: auto;
  transform: translateY(0);
  transition: opacity 200ms 20ms var(--ease-out), transform 260ms var(--ease-out), visibility 0ms;
}

/* 关于页 - 头部 */
.about-hero {
  display: flex;
  align-items: center;
  gap: 12px;
}
.app-logo {
  color: var(--control-mark, var(--text-onbrand, #fff));
  flex-shrink: 0;
  width: 48px;
  height: 48px;
  border-radius: var(--radius-12);
  background: var(--bg-brand);
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: var(--settings-logo-shadow, 0 2px 8px rgba(62, 125, 98, 0.22));
}
.app-meta {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.app-name {
  font-size: 15px;
  font-weight: var(--font-weight-strong);
  color: var(--text-default);
  line-height: 22px;
}
.app-version {
  font-size: var(--body-md-font-size);
  line-height: var(--body-md-line-height);
  color: var(--text-tertiary);
  font-family: var(--font-family-metric);
  font-variant-numeric: tabular-nums;
}
.language-select { width: 180px; flex-shrink: 0; }
.about-desc {
  margin: 0;
  font-size: 13px;
  line-height: var(--body-base-line-height);
  color: var(--text-secondary);
}

/* 链接列表 */
.link-list {
  display: flex;
  flex-direction: column;
  border-top: 1px solid var(--border-neutral-l1);
}
.link-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--spacer-12);
  padding: 10px 0;
  border-bottom: 1px solid var(--border-neutral-l1);
  font-size: 13px;
  line-height: var(--body-base-line-height);
  cursor: pointer;
  text-decoration: none;
  transition: background-color 0.1s ease;
}
.link-row:last-child {
  border-bottom: none;
}
a.link-row:hover .link-label {
  color: var(--text-default);
}
a.link-row:focus-visible {
  outline: 2px solid var(--interaction-border);
  outline-offset: 2px;
  border-radius: var(--radius-inner);
}
.link-label {
  min-width: 0;
  color: var(--text-tertiary);
  font-weight: var(--font-weight-medium);
  transition: color 0.1s ease;
}
.link-cta {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  text-align: right;
  overflow-wrap: anywhere;
  color: var(--text-brand);
  font-weight: var(--font-weight-medium);
}
.link-cta .arrow {
  opacity: 0.7;
}
.link-cta.link-value {
  color: var(--text-secondary);
  font-weight: var(--font-weight-default);
}

/* 设置行(外观/通用) */
.setting-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 4px 0;
}
.setting-label {
  min-width: 0;
  flex: 1;
}
.setting-section { display: flex; flex-direction: column; gap: 12px; }
.setting-section + .setting-section { border-top: 1px solid var(--border-neutral-l1); padding-top: 16px; }
.section-title { margin: 0 0 2px; font-size: var(--heading-2xs-font-size); font-weight: var(--font-weight-strong); line-height: var(--body-md-line-height); color: var(--text-secondary); }
.setting-hint { margin: var(--spacer-4) 0 0; font-size: var(--body-sm-font-size); line-height: var(--body-md-line-height); color: var(--text-tertiary); overflow-wrap: anywhere; }
.save-hint { margin: 0; padding-top: 2px; font-size: var(--body-sm-font-size); line-height: var(--body-md-line-height); color: var(--text-tertiary); overflow-wrap: anywhere; }
.setting-switch { flex: 0 0 36px; width: 36px; height: 22px; padding: 3px; border: 0; border-radius: 99px; background: var(--border-neutral-l2); cursor: pointer; transition: var(--control-transition); }
.setting-switch span { display: block; width: 16px; height: 16px; border-radius: 99px; background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,.12); transform: translateX(0); transition: transform var(--motion-release) var(--ease-settle), width var(--motion-release) var(--ease-settle); }
.setting-switch.is-on { background: var(--bg-brand); }
.setting-switch.is-on span { transform: translateX(14px); }
.setting-switch:active:not(:disabled) span { width: 19px; transition-duration: var(--motion-press); transition-timing-function: var(--ease-out); }
.setting-switch.is-on:active:not(:disabled) span { transform: translateX(11px); }
.label-text {
  font-size: 13px;
  line-height: var(--body-base-line-height);
  color: var(--text-default);
  font-weight: var(--font-weight-medium);
}

.skin-options { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.skin-card { display: flex; flex-direction: column; min-width: 0; padding: 8px; border: 1px solid var(--surface-line); border-radius: 13px; background: var(--surface-raised); text-align: left; cursor: pointer; }
.skin-card:hover:not(:disabled) { background: var(--surface-well); }
.skin-card.is-selected { border-color: var(--bg-brand); background: color-mix(in srgb, var(--bg-brand) 4%, var(--surface-raised)); }
.skin-card:focus-visible { outline: 2px solid var(--interaction-ink, var(--bg-brand)); outline-offset: 2px; }
.skin-card:disabled { cursor: default; }
.skin-card-title { display: flex; align-items: center; justify-content: space-between; gap: 6px; width: 100%; margin-top: 8px; color: var(--text-default); font-size: 12px; font-weight: 600; line-height: 18px; }
.skin-card-check { display: grid; place-items: center; width: 15px; height: 15px; flex-shrink: 0; border-radius: 50%; background: var(--bg-brand); color: var(--text-onbrand); opacity: 0; transition: opacity var(--motion-fast) var(--ease-out); }
.skin-card.is-selected .skin-card-check { opacity: 1; }
.skin-card-hint { margin-top: 3px; color: var(--text-tertiary); font-size: 11px; line-height: 16px; }
.skin-preview {
  --preview-bg: #f1f5f2;
  --preview-side: #e5eee8;
  --preview-head: #fff;
  --preview-line: #d2dfd6;
  --preview-board: #dce9df;
  --preview-brand: #3e7d62;
  --preview-dot: #ce8c5d;
  position: relative; display: block; width: 100%; height: 66px; overflow: hidden;
  border: 1px solid var(--preview-line); border-radius: 8px; background: var(--preview-bg);
}
.skin-preview--sakura { --preview-bg: #fff; --preview-side: #fff; --preview-head: #fff; --preview-line: #e8e7eb; --preview-board: #fff7fa; --preview-brand: #d85c8a; --preview-dot: #f3d9e4; --preview-export: var(--sakura-accent); --preview-pad: var(--sakura-accent); }
.skin-preview-header { position: absolute; inset: 0 0 auto; display: flex; align-items: center; gap: 3px; height: 11px; padding-left: 5px; border-bottom: 1px solid var(--preview-line); background: var(--preview-head); }
.skin-preview-header i { width: 2px; height: 2px; border-radius: 50%; background: var(--preview-line); }
.skin-preview-header i:first-child { background: var(--preview-brand); }
.skin-preview-sidebar { position: absolute; top: 11px; bottom: 0; left: 0; display: flex; flex-direction: column; gap: 5px; width: 30%; padding: 9px 5px; border-right: 1px solid var(--preview-line); background: var(--preview-side); }
.skin-preview-sidebar i { width: 100%; height: 3px; border-radius: 2px; background: var(--preview-line); }
.skin-preview-sidebar i:first-child { width: 72%; background: var(--preview-brand); opacity: .65; }
.skin-preview-workspace { position: absolute; inset: 11px 0 0 30%; display: grid; place-items: center; }
.skin-preview-board { display: grid; grid-template-columns: repeat(2, 6px); justify-content: center; align-content: center; gap: 5px 8px; width: 42px; height: 30px; border: 1px solid var(--preview-brand); border-radius: 5px; background: var(--preview-board); transform: rotate(-8deg); }
.skin-preview-board i { width: 6px; height: 3px; border-radius: 1px; background: var(--preview-brand); opacity: .7; }
.skin-preview-board i:last-child { background: var(--preview-dot); opacity: 1; }
.skin-preview--sakura .skin-preview-header::after { content: ''; width: 16px; height: 4px; margin: 0 5px 0 auto; border-radius: 2px; background: var(--preview-export); }
.skin-preview--sakura .skin-preview-board { border-color: var(--preview-brand); }
.skin-preview--sakura .skin-preview-board i { background: var(--preview-pad); opacity: 1; }
.skin-preview--sakura .skin-preview-board i:last-child { background: var(--preview-dot); }
html.dark .skin-preview { --preview-bg: #202825; --preview-side: #2b3730; --preview-head: #303a34; --preview-line: #45574b; --preview-board: #2c4335; --preview-brand: #7fb392; --preview-dot: #d49a70; }
html.dark .skin-preview--sakura { --preview-bg: #242329; --preview-side: #29282e; --preview-head: #2e2d33; --preview-line: #45444c; --preview-board: #302e35; --preview-brand: #f0aac6; --preview-dot: #f3d9e4; }

/* 分段控件 */
.seg-group {
  --segment-count: 2;
  --segment-index: 0;
  position: relative;
  flex: 0 0 auto;
  display: inline-grid;
  grid-template-columns: repeat(var(--segment-count), minmax(0, 1fr));
  background: var(--surface-well);
  border: 1px solid var(--surface-line);
  border-radius: var(--radius-full);
  padding: 3px;
}
.seg-indicator {
  position: absolute;
  top: 3px;
  bottom: 3px;
  left: 3px;
  width: calc((100% - 6px) / var(--segment-count));
  border-radius: var(--radius-full);
  background: var(--surface-selected);
  box-shadow: var(--shadow-control);
  transform: translateX(calc(var(--segment-index) * 100%));
  transition: transform var(--motion-release) cubic-bezier(.2, .9, .24, 1);
  pointer-events: none;
}
.seg-btn {
  position: relative;
  z-index: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 5px 14px;
  min-width: 64px;
  border: none;
  border-radius: var(--radius-full);
  background: transparent;
  color: var(--text-secondary);
  font-size: 12px;
  font-weight: var(--font-weight-medium);
  cursor: pointer;
  transition: var(--control-transition);
}
.seg-btn:hover {
  color: var(--text-default);
}
.seg-btn.active {
  background: transparent;
  color: var(--text-brand);
}

@media (max-height: 600px) {
  .pane { gap: 12px; padding-block: 16px; }
  .update-notes { max-height: 100px; }
}

@media (max-width: 600px) {
  .dialog-body { flex-direction: column; }
  .sidebar { width: auto; flex-direction: row; padding: 8px; border-right: 0; border-bottom: 1px solid var(--border-neutral-l1); }
  .nav-item { flex: 1; min-width: 0; }
  .nav-indicator { top: 8px; right: auto; width: calc((100% - 20px) / 2); }
  .nav-indicator.is-general { transform: translateX(calc(100% + 4px)); }
  .pane { padding: 16px; }
  .setting-row { flex-direction: column; align-items: stretch; gap: 10px; }
  .setting-label { flex: auto; }
  .setting-switch { flex: none; align-self: flex-start; }
  .language-select, .seg-group { width: 100%; max-width: 100%; }
  .seg-btn { min-width: 0; padding-inline: 8px; line-height: 18px; overflow-wrap: anywhere; }
}

@media (max-width: 420px) {
  .seg-btn { flex-direction: column; gap: 3px; }
}
</style>

<style>
/* The teleported language menu must sit above the settings overlay. */
.settings-language-menu.el-popper { z-index: 3100 !important; }
/* settings-dialog 专用覆盖（非 scoped，因对话框 teleport 到 body，scoped :deep() 无法命中） */
.settings-dialog.el-dialog {
  height: min(560px, calc(100vh - 48px));
  height: min(560px, calc(100dvh - 48px));
  max-width: calc(100vw - 32px);
  margin: 0 auto !important;
  padding: 0 !important;
  border: 1px solid var(--surface-line);
  border-radius: var(--radius-dialog);
  corner-shape: var(--corner-shape);
  box-shadow: var(--shadow-float);
  overflow: hidden;
  align-self: center;
}
.settings-overlay.el-overlay {
  z-index: 3000 !important;
}
/* Fade the mask while the fixed-size frame settles gently into place. */
.settings-overlay.settings-reveal-enter-active { transition: opacity 220ms var(--ease-out); }
.settings-overlay.settings-reveal-leave-active { transition: opacity 180ms ease; }
.settings-overlay.settings-reveal-enter-from,
.settings-overlay.settings-reveal-leave-to { opacity: 0; }
.settings-reveal-enter-active .settings-dialog { transition: transform 300ms var(--ease-out); }
.settings-reveal-leave-active .settings-dialog { transition: transform 180ms var(--ease-out); }
.settings-reveal-enter-from .settings-dialog { transform: translateY(10px) scale(.98); }
.settings-reveal-leave-to .settings-dialog { transform: translateY(5px) scale(.985); }
.settings-dialog .el-dialog__header {
  display: none !important;
  margin: 0;
  padding: 0;
  border: none;
}
.settings-dialog .el-dialog__body {
  height: 100%;
  min-height: 0;
  padding: 0 !important;
  margin: 0;
}
</style>
