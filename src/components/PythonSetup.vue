<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, nextTick } from "vue";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useI18n } from "vue-i18n";
import { ElMessage } from "element-plus";
import { useConfigStore } from "../stores/config";

const { t } = useI18n();
const store = useConfigStore();

type Phase = "idle" | "install-python" | "install-deps";
const phase = ref<Phase>("idle");
const logLines = ref<string[]>([]);
const logEl = ref<HTMLDivElement | null>(null);

let unlistenLog: UnlistenFn | null = null;

// 状态视图:就绪 / 缺依赖 / 无 Python
const view = computed<"ok" | "missing" | "none">(() => {
  if (store.pythonPath) return store.depsMissing.length > 0 ? "missing" : "ok";
  return "none";
});

const busy = computed(() => phase.value !== "idle");

function appendLog(line: string) {
  logLines.value = [...logLines.value.slice(-300), line];
  nextTick(() => {
    if (logEl.value) logEl.value.scrollTop = logEl.value.scrollHeight;
  });
}

onMounted(async () => {
  unlistenLog = await listen<string>("install-log", (e) => appendLog(e.payload));
  store.detectPython();
});

onBeforeUnmount(() => {
  unlistenLog?.();
});

// 一键装依赖(python 已有)
async function installDeps() {
  if (!store.pythonPath) return;
  phase.value = "install-deps";
  try {
    await invoke("install_deps", { pythonPath: store.pythonPath });
    ElMessage.success(t("python.installDone"));
    await store.detectPython();
  } catch (e) {
    ElMessage.error(`${t("python.installFailed")}: ${e}`);
  } finally {
    phase.value = "idle";
  }
}

// 一键全自动:winget 装 Python → 装依赖
async function installAll() {
  phase.value = "install-python";
  try {
    const pyPath = await invoke<string>("install_python");
    appendLog(t("python.pythonInstalled"));
    phase.value = "install-deps";
    await invoke("install_deps", { pythonPath: pyPath });
    ElMessage.success(t("python.installDone"));
    await store.detectPython();
  } catch (e) {
    ElMessage.error(`${t("python.installFailed")}: ${e}`);
  } finally {
    phase.value = "idle";
  }
}

async function pickFile() {
  const selected = await open({
    title: t("python.pickFile"),
    filters: [
      { name: "python", extensions: ["exe"] },
      { name: "All", extensions: ["*"] },
    ],
    multiple: false,
  });
  if (!selected || Array.isArray(selected)) return;
  try {
    await invoke<string>("set_python_path", { path: selected });
    await store.detectPython();
  } catch (e) {
    ElMessage.error(String(e));
  }
}

function openPythonDownload() {
  openUrl("https://www.python.org/downloads/").catch(console.error);
}
</script>

<template>
  <div class="python-setup">
    <!-- 检测中 -->
    <div v-if="store.engineLoading" class="state-row checking">
      <svg class="spin" viewBox="0 0 16 16" width="14" height="14">
        <path d="M8 2a6 6 0 1 0 6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
      </svg>
      <span>{{ t('python.checking') }}</span>
    </div>

    <!-- ===== 状态:就绪 ===== -->
    <template v-else-if="view === 'ok'">
      <div class="state-row ok">
        <svg viewBox="0 0 16 16" width="15" height="15" class="ok-icon">
          <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.4" />
          <path d="M5 8.2l2 2L11 5.8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        <div class="ok-text">
          <span class="ok-title">
            {{ t('python.ready') }}
            <span v-if="store.bundledEngine" class="bundled-tag">{{ t('python.bundled') }}</span>
          </span>
          <span class="ok-hint">{{ store.bundledEngine ? t('python.readyHintBundled') : t('python.readyHint') }}</span>
        </div>
      </div>
      <div class="path-row">
        <code class="path">{{ store.pythonPath }}</code>
        <button class="link-btn" @click="store.detectPython">{{ t('python.reDetect') }}</button>
      </div>
    </template>

    <!-- ===== 状态:缺依赖 ===== -->
    <template v-else-if="view === 'missing'">
      <div class="banner warn">
        <svg viewBox="0 0 16 16" width="14" height="14" class="banner-icon">
          <path d="M8 2L1.5 13.5h13L8 2zM8 6.5v3.5M8 11.8v.4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        <div class="banner-text">
          <span class="banner-title">{{ t('python.missingDeps') }}</span>
          <span class="banner-sub">{{ t('python.missingDepsHint') }}</span>
          <div class="dep-tags">
            <code v-for="d in store.depsMissing" :key="d" class="dep-tag">{{ d }}</code>
          </div>
        </div>
      </div>
      <button class="primary-btn" :disabled="busy" @click="installDeps">
        <svg viewBox="0 0 16 16" width="13" height="13">
          <path d="M9 1.5L3 9h3.5L6 14.5 13 7H9.5L9 1.5z" fill="currentColor" />
        </svg>
        {{ busy && phase === 'install-deps' ? t('python.installing') : t('python.installDeps') }}
      </button>
      <p class="footnote">{{ t('python.pipHint') }}</p>
    </template>

    <!-- ===== 状态:无 Python ===== -->
    <template v-else>
      <div class="banner danger">
        <svg viewBox="0 0 16 16" width="14" height="14" class="banner-icon">
          <circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" stroke-width="1.4" />
          <path d="M8 4.8v4M8 11v.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
        </svg>
        <div class="banner-text">
          <span class="banner-title">{{ t('python.noPython') }}</span>
          <span class="banner-sub">{{ t('python.noPythonHint') }}</span>
        </div>
      </div>

      <button class="primary-btn" :disabled="busy" @click="installAll">
        <svg viewBox="0 0 16 16" width="13" height="13">
          <path d="M9 1.5L3 9h3.5L6 14.5 13 7H9.5L9 1.5z" fill="currentColor" />
        </svg>
        {{ busy ? t('python.installing') : t('python.installAll') }}
      </button>

      <div class="alt-actions">
        <button class="link-btn" @click="pickFile">{{ t('python.pickFile') }}</button>
        <span class="dot">·</span>
        <button class="link-btn" @click="openPythonDownload">{{ t('python.openDownload') }}</button>
      </div>
    </template>

    <!-- ===== 安装日志(终端风格) ===== -->
    <div v-if="busy || logLines.length > 0" class="log-panel">
      <div class="log-head">
        <span class="log-title">{{ t('python.installTitle') }}</span>
        <span v-if="busy" class="log-live">
          <span class="pulse" />{{ t('python.installing') }}
        </span>
      </div>
      <div ref="logEl" class="log-body">
        <div v-for="(l, i) in logLines" :key="i" class="log-line">{{ l }}</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.python-setup {
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  font-size: var(--body-md-font-size);
}

/* 检测中 */
.state-row.checking {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--text-tertiary);
  padding: 6px 0;
}

.spin {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

/* 就绪态 */
.state-row.ok {
  display: flex;
  align-items: flex-start;
  gap: 10px;
}

.ok-icon {
  color: var(--status-success-default);
  flex-shrink: 0;
  margin-top: 2px;
}

.ok-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.ok-title {
  font-size: 13px;
  font-weight: var(--font-weight-strong);
  color: var(--text-default);
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.bundled-tag {
  font-size: 10px;
  font-weight: var(--font-weight-medium);
  padding: 1px 6px;
  border-radius: var(--radius-full);
  background: var(--status-success-surface-l1);
  color: var(--status-success-default);
}

.ok-hint {
  font-size: 11px;
  color: var(--text-tertiary);
}

.path-row {
  display: flex;
  align-items: center;
  gap: 8px;
  background: var(--bg-overlay-l1);
  border-radius: var(--radius-6);
  padding: 8px 12px;
}

.path {
  flex: 1;
  font-family: var(--font-family-mono);
  font-size: 11px;
  color: var(--text-secondary);
  word-break: break-all;
}

/* 横幅(缺依赖/无 Python) */
.banner {
  display: flex;
  gap: 10px;
  padding: 10px 12px;
  border-radius: var(--radius-8);
  align-items: flex-start;
}

.banner.warn {
  background: var(--status-warning-surface-l1);
  color: var(--status-warning-default);
}

.banner.danger {
  background: var(--status-error-surface-l1);
  color: var(--status-error-default);
}

.banner-icon {
  flex-shrink: 0;
  margin-top: 2px;
}

.banner-text {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.banner-title {
  font-size: 12px;
  font-weight: var(--font-weight-strong);
  color: var(--text-default);
}

.banner-sub {
  font-size: 11px;
  line-height: 1.6;
  color: var(--text-secondary);
}

.dep-tags {
  display: flex;
  gap: 6px;
  margin-top: 4px;
  flex-wrap: wrap;
}

.dep-tag {
  font-family: var(--font-family-mono);
  font-size: 10px;
  padding: 2px 8px;
  border-radius: var(--radius-full);
  background: var(--bg-base-default);
  border: 1px solid var(--border-neutral-l2);
  color: var(--status-warning-default);
}

/* 主按钮 */
.primary-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 8px 14px;
  border: none;
  border-radius: var(--radius-6);
  background: var(--bg-brand);
  color: var(--text-onbrand);
  font-size: 12px;
  font-weight: var(--font-weight-medium);
  cursor: pointer;
  transition: var(--control-transition);
}

.primary-btn:hover:not(:disabled) {
  background: var(--bg-brand-hover);
}

.primary-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.footnote {
  margin: 0;
  font-size: 10px;
  color: var(--text-tertiary);
  line-height: 1.5;
}

/* 备选链接 */
.alt-actions {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
}

.link-btn {
  border: none;
  background: transparent;
  padding: 0;
  font-size: 11px;
  color: var(--text-brand);
  cursor: pointer;
}

.link-btn:hover {
  text-decoration: underline;
}

.dot {
  color: var(--text-disabled);
}

/* 终端日志 */
.log-panel {
  border-radius: var(--radius-8);
  overflow: hidden;
  border: 1px solid var(--border-neutral-l2);
}

.log-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 12px;
  background: var(--bg-base-tertiary);
}

.log-title {
  font-size: 10px;
  font-weight: var(--font-weight-strong);
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.log-live {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 10px;
  color: var(--text-brand);
}

.pulse {
  width: 6px;
  height: 6px;
  border-radius: var(--radius-full);
  background: var(--bg-brand);
  animation: pulse 1.2s ease-in-out infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}

.log-body {
  --terminal-background: #20262A;
  --terminal-text: #F1F4F4;
  background: var(--terminal-background);
  color: var(--terminal-text);
  padding: 10px 12px;
  max-height: 180px;
  overflow-y: auto;
  font-family: var(--font-family-mono);
  font-size: 10px;
  line-height: 1.7;
}

.log-line {
  color: inherit;
  white-space: pre-wrap;
  word-break: break-all;
}
</style>
