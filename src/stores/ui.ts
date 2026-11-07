/**
 * UI 全局状态:主题、语言、启动更新检查与默认导出格式
 * 持久化到 localStorage,主题写入 html class(Element Plus dark 也用同一 class)
 */
import { defineStore } from "pinia";
import { computed, onScopeDispose, ref, watch } from "vue";
import { i18n } from "../i18n";
import { getSystemLocale, SUPPORTED_LOCALES, type LocalePreference } from "../lib/locales";

export type Theme = "light" | "dark" | "system";
export type ExportFormat = "stl" | "step";

const THEME_KEY = "psj_theme";
const LOCALE_KEY = "psj_locale";
const STARTUP_UPDATES_KEY = "psj_check_updates_on_startup";
const EXPORT_FORMAT_KEY = "psj_default_export_format";
const ONBOARDING_KEY = "psj_onboarding_seen_v1";
const INSPECTION_ONBOARDING_KEY = "psj_inspection_onboarding_seen_v1";

function readStored<T extends string>(key: string, fallback: T, allowed: readonly T[]): T {
  try {
    const v = localStorage.getItem(key);
    if (v !== null && allowed.includes(v as T)) return v as T;
  } catch { /* ignore */ }
  return fallback;
}

function readBoolean(key: string, fallback: boolean): boolean {
  try {
    const value = localStorage.getItem(key);
    if (value === "true") return true;
    if (value === "false") return false;
  } catch { /* ignore */ }
  return fallback;
}

export const useUiStore = defineStore("ui", () => {
  const theme = ref<Theme>(readStored<Theme>(THEME_KEY, "light", ["light", "dark", "system"]));
  const locale = ref<LocalePreference>(readStored<LocalePreference>(LOCALE_KEY, "system", ['system', ...SUPPORTED_LOCALES]));
  const systemLocale = ref(getSystemLocale());
  const resolvedLocale = computed(() => locale.value === 'system' ? systemLocale.value : locale.value);
  const onLanguageChange = () => { systemLocale.value = getSystemLocale(); };
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('languagechange', onLanguageChange);
    onScopeDispose(() => window.removeEventListener('languagechange', onLanguageChange));
  }
  const checkUpdatesOnStartup = ref(readBoolean(STARTUP_UPDATES_KEY, true));
  const defaultExportFormat = ref<ExportFormat>(readStored<ExportFormat>(EXPORT_FORMAT_KEY, "stl", ["stl", "step"]));
  const onboardingSeen = ref(readBoolean(ONBOARDING_KEY, false));
  const inspectionOnboardingSeen = ref(readBoolean(INSPECTION_ONBOARDING_KEY, false));

  function dismissOnboarding() {
    onboardingSeen.value = true;
    try { localStorage.setItem(ONBOARDING_KEY, "true"); } catch { /* keep usable without storage */ }
  }

  function dismissInspectionOnboarding() {
    inspectionOnboardingSeen.value = true;
    try { localStorage.setItem(INSPECTION_ONBOARDING_KEY, "true"); } catch { /* keep usable without storage */ }
  }

  const systemTheme = typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-color-scheme: dark)") : null;
  const systemDark = ref(systemTheme?.matches ?? false);
  // Persist the chosen mode; renderers consume the currently resolved color.
  const resolvedTheme = computed<"light" | "dark">(() => theme.value === "system"
    ? (systemDark.value ? "dark" : "light") : theme.value);
  const onSystemThemeChange = (event: MediaQueryListEvent) => { systemDark.value = event.matches; };
  if (systemTheme) {
    if (typeof systemTheme.addEventListener === "function") {
      systemTheme.addEventListener("change", onSystemThemeChange);
      onScopeDispose(() => systemTheme.removeEventListener("change", onSystemThemeChange));
    } else {
      systemTheme.addListener(onSystemThemeChange);
      onScopeDispose(() => systemTheme.removeListener(onSystemThemeChange));
    }
  }

  function applyTheme() {
    document.documentElement.classList.toggle("dark", resolvedTheme.value === "dark");
  }

  function setTheme(t: Theme) {
    theme.value = t;
  }

  function setLocale(l: LocalePreference) {
    if (l === 'system') onLanguageChange();
    locale.value = l;
  }

  // 初始化时应用一次
  applyTheme();
  // Clear the former in-app override; desktop motion stays enabled independently of the OS.
  document.documentElement.classList.toggle("reduce-motion", false);
  watch(resolvedLocale, (value) => {
    i18n.global.locale.value = value;
    document.documentElement.lang = value === 'zh' ? 'zh-Hans' : value;
  }, { immediate: true });

  watch(resolvedTheme, applyTheme);
  watch(theme, (t) => {
    try { localStorage.setItem(THEME_KEY, t); } catch { /* ignore */ }
  });

  watch(locale, (l) => {
    try { localStorage.setItem(LOCALE_KEY, l); } catch { /* ignore */ }
  });

  watch(checkUpdatesOnStartup, (enabled) => {
    try { localStorage.setItem(STARTUP_UPDATES_KEY, String(enabled)); } catch { /* ignore */ }
  });
  watch(defaultExportFormat, (format) => {
    try { localStorage.setItem(EXPORT_FORMAT_KEY, format); } catch { /* ignore */ }
  });

  return { theme, resolvedTheme, locale, resolvedLocale, checkUpdatesOnStartup, defaultExportFormat,
    onboardingSeen, dismissOnboarding, inspectionOnboardingSeen, dismissInspectionOnboarding, setTheme, setLocale };
});
