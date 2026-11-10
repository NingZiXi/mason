import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { nextTick } from "vue";
import { useUiStore } from "../../stores/ui";

let disk: Map<string, string>;
let classes: Set<string>;
let attributes: Map<string, string>;
let systemDark: boolean;
let themeListeners: Set<(event: { matches: boolean }) => void>;

function changeSystemTheme(dark: boolean) {
  systemDark = dark;
  themeListeners.forEach((listener) => listener({ matches: dark }));
}

beforeEach(() => {
  disk = new Map();
  classes = new Set();
  attributes = new Map();
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
  vi.stubGlobal("document", { documentElement: { setAttribute: (name: string, value: string) => attributes.set(name, value), classList: {
    toggle: (name: string, enabled: boolean) => enabled ? classes.add(name) : classes.delete(name),
  } } });
  setActivePinia(createPinia());
});

describe("hidden skin preferences", () => {
  it("starts with the classic skin and guards the locked skin", () => {
    const ui = useUiStore();
    expect(ui.skin).toBe("classic");
    expect(ui.sakuraUnlocked).toBe(false);
    expect(ui.skinCelebrationActive).toBe(false);
    expect(attributes.get("data-skin")).toBe("classic");
    ui.setSkin("sakura");
    expect(ui.skin).toBe("classic");
    expect(disk.has("psj_skin")).toBe(false);
  });

  it.each([
    ["sakura", "false"],
    ["sakura", "invalid"],
    ["invalid", "true"],
  ])("rejects invalid or locked saved skin %s with unlock value %s", (savedSkin, unlocked) => {
    disk.set("psj_skin", savedSkin);
    disk.set("psj_sakura_unlocked", unlocked);
    expect(useUiStore().skin).toBe("classic");
    expect(attributes.get("data-skin")).toBe("classic");
  });

  it("ignores a preview outside the celebration", () => {
    const ui = useUiStore();
    ui.previewCelebrationSkin();
    expect(ui.skin).toBe("classic");
    expect(ui.sakuraUnlocked).toBe(false);
    expect(disk.has("psj_sakura_unlocked")).toBe(false);
  });

  it("permanently unlocks on preview while allowing the original skin to be restored", () => {
    const ui = useUiStore();
    expect(ui.beginSkinCelebration()).toBe(true);
    expect(ui.skinCelebrationWasUnlocked).toBe(false);
    expect(ui.skinBeforeCelebration).toBe("classic");
    expect(ui.skinCelebrationTarget).toBe("sakura");
    ui.previewCelebrationSkin();
    expect(ui.sakuraUnlocked).toBe(true);
    expect(attributes.get("data-skin")).toBe("sakura");
    ui.endSkinCelebration(false);
    expect(ui.skin).toBe("classic");
    expect(attributes.get("data-skin")).toBe("classic");
    expect(ui.skinCelebrationActive).toBe(false);
    setActivePinia(createPinia());
    const restored = useUiStore();
    expect(restored.skin).toBe("classic");
    expect(restored.sakuraUnlocked).toBe(true);
    restored.setSkin("sakura");
    expect(restored.skin).toBe("sakura");
  });

  it("persists the selected skin before an immediate reload without replaying the celebration", () => {
    const ui = useUiStore();
    ui.beginSkinCelebration();
    ui.previewCelebrationSkin();
    ui.endSkinCelebration(true);
    expect(disk.get("psj_skin")).toBe("sakura");
    expect(disk.get("psj_sakura_unlocked")).toBe("true");
    setActivePinia(createPinia());
    const restored = useUiStore();
    expect(restored.skin).toBe("sakura");
    expect(restored.sakuraUnlocked).toBe(true);
    expect(restored.skinCelebrationActive).toBe(false);
    expect(restored.beginSkinCelebration()).toBe(true);
    expect(restored.skinCelebrationWasUnlocked).toBe(true);
    restored.previewCelebrationSkin();
    restored.endSkinCelebration(false);
    expect(restored.skin).toBe("sakura");
  });

  it("also persists an unlock if the app closes while the celebration is active", () => {
    const ui = useUiStore();
    ui.beginSkinCelebration();
    ui.previewCelebrationSkin();
    setActivePinia(createPinia());
    const restored = useUiStore();
    expect(restored.skin).toBe("sakura");
    expect(restored.sakuraUnlocked).toBe(true);
    expect(restored.skinCelebrationActive).toBe(false);
  });

  it.each([
    ["classic", true], ["classic", false], ["sakura", true], ["sakura", false],
  ] as const)("previews the opposite of %s and honors keep=%s", (skin, keep) => {
    disk.set("psj_sakura_unlocked", "true");
    disk.set("psj_skin", skin);
    const ui = useUiStore();
    expect(ui.beginSkinCelebration()).toBe(true);
    expect(ui.skinCelebrationWasUnlocked).toBe(true);
    expect(ui.skinBeforeCelebration).toBe(skin);
    const destination = skin === "classic" ? "sakura" : "classic";
    expect(ui.skinCelebrationTarget).toBe(destination);
    ui.previewCelebrationSkin();
    expect(ui.skin).toBe(destination);
    expect(attributes.get("data-skin")).toBe(destination);
    expect(disk.get("psj_skin")).toBe(destination);
    ui.previewCelebrationSkin();
    expect(ui.skin).toBe(destination);
    // A transient external change must not overwrite the replay snapshot.
    ui.setSkin(skin);
    expect(ui.beginSkinCelebration()).toBe(false);
    expect(ui.skinBeforeCelebration).toBe(skin);
    expect(ui.skinCelebrationTarget).toBe(destination);
    expect(ui.skinCelebrationWasUnlocked).toBe(true);
    // The result/skip path applies the skin again without changing the greeting.
    ui.previewCelebrationSkin();
    expect(ui.skin).toBe(destination);
    expect(ui.skinCelebrationWasUnlocked).toBe(true);
    ui.endSkinCelebration(keep);
    const expected = keep ? destination : skin;
    expect(ui.skin).toBe(expected);
    expect(attributes.get("data-skin")).toBe(expected);
    expect(disk.get("psj_skin")).toBe(expected);
    expect(ui.skinCelebrationActive).toBe(false);
    expect(ui.sakuraUnlocked).toBe(true);
    ui.endSkinCelebration(!keep);
    expect(ui.skin).toBe(expected);
  });

  it.each(["classic", "sakura"] as const)("persists the destination of a replay from %s without showing the first unlock again", skin => {
    disk.set("psj_sakura_unlocked", "true");
    disk.set("psj_skin", skin);
    const ui = useUiStore();
    const destination = skin === "classic" ? "sakura" : "classic";
    ui.beginSkinCelebration();
    ui.previewCelebrationSkin();
    expect(ui.skinCelebrationWasUnlocked).toBe(true);
    ui.endSkinCelebration(true);
    setActivePinia(createPinia());
    const restored = useUiStore();
    expect(restored.skin).toBe(destination);
    expect(restored.sakuraUnlocked).toBe(true);
    expect(restored.skinCelebrationActive).toBe(false);
    restored.beginSkinCelebration();
    expect(restored.skinCelebrationWasUnlocked).toBe(true);
    expect(restored.skinCelebrationTarget).toBe(skin);
  });

  it("alternates destinations across consecutive eggs while repeated previews stay idempotent", () => {
    const ui = useUiStore();
    for (const [index, destination] of ["sakura", "classic", "sakura", "classic"].entries()) {
      expect(ui.beginSkinCelebration()).toBe(true);
      expect(ui.skinCelebrationWasUnlocked).toBe(index !== 0);
      expect(ui.skinCelebrationTarget).toBe(destination);
      ui.previewCelebrationSkin();
      ui.previewCelebrationSkin();
      expect(ui.skin).toBe(destination);
      expect(ui.skinCelebrationTarget).toBe(destination);
      ui.endSkinCelebration(true);
      expect(ui.skin).toBe(destination);
      expect(disk.get("psj_skin")).toBe(destination);
      expect(ui.sakuraUnlocked).toBe(true);
    }
  });

  it.each(["classic", "sakura"] as const)("restores %s after a replay abort and preserves the unlock", skin => {
    disk.set("psj_sakura_unlocked", "true");
    disk.set("psj_skin", skin);
    const ui = useUiStore();
    ui.beginSkinCelebration();
    ui.previewCelebrationSkin();
    ui.endSkinCelebration(false);
    ui.previewCelebrationSkin();
    expect(ui.skin).toBe(skin);
    expect(ui.skinCelebrationActive).toBe(false);
    expect(disk.get("psj_skin")).toBe(skin);
    expect(disk.get("psj_sakura_unlocked")).toBe("true");
    setActivePinia(createPinia());
    expect(useUiStore().skin).toBe(skin);
    expect(useUiStore().sakuraUnlocked).toBe(true);
  });

  it("leaves a cancelled first egg locked when aborted before any preview", () => {
    const ui = useUiStore();
    ui.beginSkinCelebration();
    ui.endSkinCelebration(false);
    expect(ui.skin).toBe("classic");
    expect(ui.sakuraUnlocked).toBe(false);
    expect(ui.skinCelebrationActive).toBe(false);
  });

  it("finalizes the snapshotted destination on keep even after an external skin change", () => {
    disk.set("psj_sakura_unlocked", "true");
    disk.set("psj_skin", "sakura");
    const ui = useUiStore();
    ui.beginSkinCelebration();
    ui.previewCelebrationSkin();
    ui.setSkin("sakura");
    ui.endSkinCelebration(true);
    expect(ui.skin).toBe("classic");
    expect(disk.get("psj_skin")).toBe("classic");
  });

  it("does not replace the original snapshot on duplicate starts or act on repeated ends", () => {
    const ui = useUiStore();
    expect(ui.beginSkinCelebration()).toBe(true);
    ui.previewCelebrationSkin();
    expect(ui.beginSkinCelebration()).toBe(false);
    expect(ui.skinBeforeCelebration).toBe("classic");
    expect(ui.skinCelebrationWasUnlocked).toBe(false);
    ui.endSkinCelebration(false);
    ui.endSkinCelebration(true);
    expect(ui.skin).toBe("classic");
    ui.setSkin("sakura");
    ui.endSkinCelebration(false);
    expect(ui.skin).toBe("sakura");
  });

  it("keeps skin and light, dark, or system preferences independent", async () => {
    const ui = useUiStore();
    ui.setTheme("system");
    ui.beginSkinCelebration();
    ui.previewCelebrationSkin();
    ui.endSkinCelebration(true);
    changeSystemTheme(true);
    await nextTick();
    expect(ui.theme).toBe("system");
    expect(classes.has("dark")).toBe(true);
    expect(attributes.get("data-skin")).toBe("sakura");
    ui.setSkin("classic");
    expect(classes.has("dark")).toBe(true);
    changeSystemTheme(false);
    await nextTick();
    expect(classes.has("dark")).toBe(false);
    expect(attributes.get("data-skin")).toBe("classic");
    ui.setTheme("dark");
    ui.setSkin("sakura");
    await nextTick();
    expect(classes.has("dark")).toBe(true);
    expect(attributes.get("data-skin")).toBe("sakura");
    ui.setTheme("light");
    await nextTick();
    expect(classes.has("dark")).toBe(false);
    expect(attributes.get("data-skin")).toBe("sakura");
  });

  it("can unlock and switch skins for the session when storage is unavailable", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("blocked"); },
    });
    const ui = useUiStore();
    expect(() => {
      ui.beginSkinCelebration();
      ui.previewCelebrationSkin();
      ui.endSkinCelebration(false);
      ui.setSkin("sakura");
    }).not.toThrow();
    expect(ui.sakuraUnlocked).toBe(true);
    expect(ui.skin).toBe("sakura");
    expect(attributes.get("data-skin")).toBe("sakura");
  });
});

afterEach(() => vi.unstubAllGlobals());

describe("application preferences", () => {
  it("remembers the inspection guide separately from the application guide", () => {
    const ui = useUiStore();
    ui.dismissOnboarding();
    expect(ui.inspectionOnboardingSeen).toBe(false);
    ui.dismissInspectionOnboarding();
    setActivePinia(createPinia());
    const restored = useUiStore();
    expect(restored.inspectionOnboardingSeen).toBe(true);
    expect(restored.onboardingSeen).toBe(true);
  });

  it("does not dismiss the application guide when closing the inspection guide", () => {
    const ui = useUiStore();
    ui.dismissInspectionOnboarding();
    setActivePinia(createPinia());
    expect(useUiStore().onboardingSeen).toBe(false);
    expect(useUiStore().inspectionOnboardingSeen).toBe(true);
  });

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
    expect(() => ui.dismissInspectionOnboarding()).not.toThrow();
    expect(ui.inspectionOnboardingSeen).toBe(true);
  });

  it("preserves existing defaults for users without saved settings", () => {
    const ui = useUiStore();
    expect(ui.theme).toBe("light");
    expect(ui.locale).toBe("system");
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
    expect(ui.locale).toBe("system");
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
