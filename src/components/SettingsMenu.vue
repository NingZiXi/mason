<script setup lang="ts">
import { ref, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { useUiStore } from "../stores/ui";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getVersion } from "@tauri-apps/api/app";

const { t } = useI18n();
const ui = useUiStore();
const showSettings = ref(false);
const appVersion = ref("");
const activeTab = ref<"about" | "appearance" | "general">("about");

onMounted(async () => {
  try {
    appVersion.value = await getVersion();
  } catch {
    appVersion.value = "";
  }
});

const REPO_URL = "https://github.com/NingZiXi/mason";
const ISSUE_URL = "https://github.com/NingZiXi/mason/issues";
const AUTHOR_URL = "https://github.com/NingZiXi";

function openLink(url: string) {
  openUrl(url).catch(console.error);
}

function closeSettings() {
  showSettings.value = false;
}
</script>

<template>
  <button class="settings-btn" :title="t('settings.button')" @click="showSettings = true">
    <svg viewBox="0 0 24 24" width="15" height="15">
      <circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="2" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1.08-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1.08 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33h.08a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.08a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"
        fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  </button>

  <el-dialog v-model="showSettings" width="540px" :show-close="false" align-center class="settings-dialog">
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
        <button class="close-btn" :title="t('settings.close')" @click="closeSettings">
          <svg viewBox="0 0 16 16" width="14" height="14">
            <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
          </svg>
        </button>
      </div>

      <!-- 主体:左菜单 + 右内容 -->
      <div class="dialog-body">
        <nav class="sidebar">
          <button
            class="nav-item"
            :class="{ active: activeTab === 'about' }"
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
            :class="{ active: activeTab === 'appearance' }"
            @click="activeTab = 'appearance'"
          >
            <svg viewBox="0 0 16 16" width="15" height="15">
              <circle cx="8" cy="8" r="3" fill="none" stroke="currentColor" stroke-width="1.3" />
              <path d="M8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.4 1.4M11.6 11.6L13 13M13 3l-1.4 1.4M4.4 11.6L3 13"
                fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" />
            </svg>
            <span>{{ t('settings.appearance') }}</span>
          </button>
          <button
            class="nav-item"
            :class="{ active: activeTab === 'general' }"
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
          <div v-show="activeTab === 'about'" class="pane">
            <div class="about-hero">
              <div class="app-logo">
                <svg viewBox="0 0 64 64" width="36" height="36">
                  <path d="M14 14 L50 14 L50 26 L26 26 L26 38 L50 38 L50 50 L14 50" fill="none" stroke="#fff" stroke-width="6" stroke-linecap="round" stroke-linejoin="round" />
                  <circle cx="14" cy="14" r="5" fill="#fff" />
                  <circle cx="14" cy="50" r="5" fill="#E07A3C" />
                </svg>
              </div>
              <div class="app-meta">
                <div class="app-name">{{ t('app.title') }}</div>
                <div class="app-version">v{{ appVersion || '0.1.0' }}</div>
              </div>
            </div>

            <p class="about-desc">{{ t('about.desc') }}</p>

            <div class="link-list">
              <a class="link-row" @click="openLink(REPO_URL)">
                <span class="link-label">{{ t('about.repo') }}</span>
                <span class="link-cta">
                  {{ t('about.openRepo') }}
                  <svg viewBox="0 0 16 16" width="12" height="12" class="arrow">
                    <path d="M4 3h7v7M11 3L4 10" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
                  </svg>
                </span>
              </a>
              <a class="link-row" @click="openLink(ISSUE_URL)">
                <span class="link-label">{{ t('about.feedback') }}</span>
                <span class="link-cta">
                  {{ t('about.submitIssue') }}
                  <svg viewBox="0 0 16 16" width="12" height="12" class="arrow">
                    <path d="M4 3h7v7M11 3L4 10" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
                  </svg>
                </span>
              </a>
              <a class="link-row" @click="openLink(AUTHOR_URL)">
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

          <!-- 外观 -->
          <div v-show="activeTab === 'appearance'" class="pane">
            <div class="setting-row">
              <div class="setting-label">
                <span class="label-text">{{ t('settings.theme') }}</span>
              </div>
              <div class="seg-group">
                <button
                  class="seg-btn"
                  :class="{ active: ui.theme === 'light' }"
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
                  :class="{ active: ui.theme === 'dark' }"
                  @click="ui.setTheme('dark')"
                >
                  <svg viewBox="0 0 16 16" width="14" height="14">
                    <path d="M13.5 9.5A6 6 0 0 1 6.5 2.5a6 6 0 1 0 7 7z"
                      fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" />
                  </svg>
                  {{ t('settings.dark') }}
                </button>
              </div>
            </div>
          </div>

          <!-- 通用 -->
          <div v-show="activeTab === 'general'" class="pane">
            <div class="setting-row">
              <div class="setting-label">
                <span class="label-text">{{ t('settings.language') }}</span>
              </div>
              <div class="seg-group">
                <button
                  class="seg-btn"
                  :class="{ active: ui.locale === 'zh' }"
                  @click="ui.setLocale('zh')"
                >中文</button>
                <button
                  class="seg-btn"
                  :class="{ active: ui.locale === 'en' }"
                  @click="ui.setLocale('en')"
                >English</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </el-dialog>
</template>

<style scoped>
.settings-btn {
  width: 32px;
  height: 32px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--border-neutral-l2);
  border-radius: var(--radius-6);
  background: var(--bg-base-default);
  color: var(--text-secondary);
  cursor: pointer;
  transition: background-color 0.12s ease, border-color 0.12s ease, color 0.12s ease;
}
.settings-btn:hover {
  background: var(--bg-overlay-l1);
  color: var(--text-default);
}

/* 对话框根容器 */
.dialog-root {
  display: flex;
  flex-direction: column;
}

/* 顶部栏 */
.dialog-header {
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
  font-weight: var(--font-weight-strong);
  color: var(--text-default);
}
.close-btn {
  width: 26px;
  height: 26px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  color: var(--text-tertiary);
  border-radius: var(--radius-6);
  cursor: pointer;
  transition: background-color 0.12s ease, color 0.12s ease;
}
.close-btn:hover {
  background: var(--bg-overlay-l1);
  color: var(--text-default);
}

/* 主体 — 固定高度确保三个标签页窗口大小一致 */
.dialog-body {
  display: flex;
  min-height: 380px;
}

/* 侧边栏 */
.sidebar {
  width: 132px;
  flex-shrink: 0;
  padding: 10px 8px;
  border-right: 1px solid var(--border-neutral-l1);
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.nav-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border: none;
  border-radius: var(--radius-6);
  background: transparent;
  color: var(--text-secondary);
  font-size: 13px;
  font-weight: var(--font-weight-medium);
  cursor: pointer;
  text-align: left;
  transition: background-color 0.12s ease, color 0.12s ease;
}
.nav-item:hover {
  background: var(--bg-overlay-l1);
  color: var(--text-default);
}
.nav-item.active {
  background: var(--bg-brand-popup);
  color: var(--text-brand);
  font-weight: var(--font-weight-strong);
}

/* 内容区 */
.content {
  flex: 1;
  min-width: 0;
  padding: 18px 20px;
  overflow-y: auto;
}
.pane {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

/* 关于页 - 头部 */
.about-hero {
  display: flex;
  align-items: center;
  gap: 12px;
}
.app-logo {
  flex-shrink: 0;
  width: 48px;
  height: 48px;
  border-radius: var(--radius-12);
  background: var(--bg-brand);
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 2px 8px rgba(62, 125, 98, 0.22);
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
  line-height: 1.3;
}
.app-version {
  font-size: 12px;
  color: var(--text-tertiary);
  font-family: "SF Mono", "Cascadia Code", "Roboto Mono", Consolas, monospace;
}
.about-desc {
  margin: 0;
  font-size: 13px;
  line-height: 1.6;
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
  padding: 10px 0;
  border-bottom: 1px solid var(--border-neutral-l1);
  font-size: 13px;
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
.link-label {
  color: var(--text-tertiary);
  font-weight: var(--font-weight-medium);
  transition: color 0.1s ease;
}
.link-cta {
  display: inline-flex;
  align-items: center;
  gap: 5px;
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
  flex-shrink: 0;
}
.label-text {
  font-size: 13px;
  color: var(--text-secondary);
  font-weight: var(--font-weight-medium);
}

/* 分段控件 */
.seg-group {
  display: inline-flex;
  gap: 2px;
  background: var(--bg-overlay-l1);
  border-radius: var(--radius-6);
  padding: 2px;
}
.seg-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 5px 14px;
  min-width: 64px;
  border: none;
  border-radius: var(--radius-4);
  background: transparent;
  color: var(--text-secondary);
  font-size: 12px;
  font-weight: var(--font-weight-medium);
  cursor: pointer;
  transition: background-color 0.12s ease, color 0.12s ease;
}
.seg-btn:hover {
  color: var(--text-default);
}
.seg-btn.active {
  background: var(--bg-base-default);
  color: var(--text-default);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08);
}
</style>

<style>
/* settings-dialog 专用覆盖（非 scoped，因对话框 teleport 到 body，scoped :deep() 无法命中） */
.settings-dialog.el-dialog {
  margin: 0 auto;
  padding: 0;
  border-radius: var(--radius-12);
  overflow: hidden;
  align-self: center;
}
.settings-dialog .el-dialog__header {
  display: none !important;
  margin: 0;
  padding: 0;
  border: none;
}
.settings-dialog .el-dialog__body {
  padding: 0 !important;
  margin: 0;
}
</style>
