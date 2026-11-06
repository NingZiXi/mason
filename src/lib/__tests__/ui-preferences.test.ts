import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { nextTick } from "vue";
import { useUiStore } from "../../stores/ui";

let disk: Map<string, string>;
let classes: Set<string>;
let systemDark: boolean;
let themeListeners: Set<(event: { matches: boolean }) => void>;

function changeSystemTheme(dark: boolean) {
  systemDark = dark;
  themeListeners.forEach((listener) => listener({ matches: dark }));
}

beforeEach(() => {
  disk = new Map();
  classes = new Set();
  systemDark = false;
  themeListeners = new Set();
  vi.stubGlobal("window", { matchMedia: () => ({
    get matches() { return systemDark; },
    addEventListener: (_event: string, listener: (event: { matches: boolean }) => void) => themeListeners.add(listener),
    removeEventListener: (_event: string, listener: (event: { matches: boolean }) => void) => themeListeners.delete(listener),
  }) });
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => disk.get(key) ?? null,
    setItem: (key: string, value: string) => disk.set(key, value),
  });
  vi.stubGlobal("document", { documentElement: { classList: {
    toggle: (name: string, enabled: boolean) => enabled ? classes.add(name) : classes.delete(name),
  } } });
  setActivePinia(createPinia());
});

afterEach(() => vi.unstubAllGlobals());

describe("application preferences", () => {
  it("offers the tour once and remembers completion or skipping across restarts", () => {
    const ui = useUiStore();
    expect(ui.onboardingSeen).toBe(false);
    ui.dismissOnboarding();
    setActivePinia(createPinia());
    expect(useUiStore().onboardingSeen).toBe(true);
  });

  it("can dismiss the tour when preference storage is unavailable", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("blocked"); },
    });
    const ui = useUiStore();
    expect(() => ui.dismissOnboarding()).not.toThrow();
    expect(ui.onboardingSeen).toBe(true);
  });

  it("preserves existing defaults for users without saved settings", () => {
    const ui = useUiStore();
    expect(ui.theme).toBe("light");
    expect(ui.locale).toBe("zh");
    expect(ui.checkUpdatesOnStartup).toBe(true);
    expect(ui.defaultExportFormat).toBe("stl");
  });

  it("restores preferences after restart", async () => {
    const ui = useUiStore();
    ui.setTheme("dark");
    ui.setLocale("en");
    ui.checkUpdatesOnStartup = false;
    ui.defaultExportFormat = "step";
    await nextTick();
    classes.clear();
    setActivePinia(createPinia());
    const restored = useUiStore();
    expect(restored.theme).toBe("dark");
    expect(restored.locale).toBe("en");
    expect(restored.checkUpdatesOnStartup).toBe(false);
    expect(restored.defaultExportFormat).toBe("step");
    expect(classes.has("dark")).toBe(true);
    expect(classes.has("reduce-motion")).toBe(false);
  });

  it("rejects corrupt or mismatched stored values", () => {
    disk.set("psj_theme", "en");
    disk.set("psj_locale", "dark");
    disk.set("psj_animations_enabled", "0");
    disk.set("psj_check_updates_on_startup", "disabled");
    disk.set("psj_default_export_format", "obj");
    const ui = useUiStore();
    expect(ui.theme).toBe("light");
    expect(ui.locale).toBe("zh");
    expect(ui.checkUpdatesOnStartup).toBe(true);
    expect(ui.defaultExportFormat).toBe("stl");
  });

  it("keeps settings usable when local storage is unavailable", async () => {
    vi.stubGlobal("localStorage", {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("blocked"); },
    });
    const ui = useUiStore();
    ui.checkUpdatesOnStartup = false;
    ui.defaultExportFormat = "step";
    await nextTick();
    expect(classes.has("reduce-motion")).toBe(false);
    expect(ui.defaultExportFormat).toBe("step");
  });

  it("ignores a saved animation override and clears its stale class", () => {
    disk.set("psj_animations_enabled", "false");
    classes.add("reduce-motion");
    useUiStore();
    expect(classes.has("reduce-motion")).toBe(false);
  });

  it("restores system mode and follows live changes without overwriting the chosen mode", async () => {
    disk.set("psj_theme", "system");
    systemDark = true;
    const ui = useUiStore();
    expect(ui.theme).toBe("system");
    expect(ui.resolvedTheme).toBe("dark");
    expect(classes.has("dark")).toBe(true);

    changeSystemTheme(false);
    await nextTick();
    expect(ui.resolvedTheme).toBe("light");
    expect(classes.has("dark")).toBe(false);
    expect(disk.get("psj_theme")).toBe("system");
  });

  it("honors manual overrides and persists selecting system mode", async () => {
    const ui = useUiStore();
    ui.setTheme("dark");
    changeSystemTheme(false);
    await nextTick();
    expect(ui.resolvedTheme).toBe("dark");
    expect(classes.has("dark")).toBe(true);

    ui.setTheme("light");
    changeSystemTheme(true);
    await nextTick();
    expect(ui.resolvedTheme).toBe("light");
    expect(classes.has("dark")).toBe(false);

    ui.setTheme("system");
    await nextTick();
    expect(ui.resolvedTheme).toBe("dark");
    expect(disk.get("psj_theme")).toBe("system");
    setActivePinia(createPinia());
    const restored = useUiStore();
    expect(restored.theme).toBe("system");
    expect(restored.resolvedTheme).toBe("dark");
  });

  it("removes the system listener when its store is disposed", () => {
    const ui = useUiStore();
    expect(themeListeners.size).toBe(1);
    ui.$dispose();
    expect(themeListeners.size).toBe(0);
  });

  it("falls back to light when system theme detection is unavailable", async () => {
    vi.stubGlobal("window", {});
    const ui = useUiStore();
    ui.setTheme("system");
    await nextTick();
    expect(ui.resolvedTheme).toBe("light");
  });
});
