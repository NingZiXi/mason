import type { AppConfig } from "../stores/config";

// Only reusable manufacturing settings. Board geometry, dimensions, file identity,
// panel scope and derived values belong to the current board, never to presets.
export const PRESET_KEYS = [
  "stencilThickness", "padShrink", "stencilFrameWidth", "stencilCornerRadius",
  "stencilFrameShape", "pocketClearance", "stencilTaper", "stencilStagger",
  "stencilStaggerGap", "stencilStaggerOffset", "stencilFilterTestPoints",
  "stencilTestPointMaxDia", "stencilTestPointIsolation", "stencilGrid",
  "stencilGridSize", "stencilGridBar", "screwSpacing", "screwSpec",
  "baseHeight", "topCoverHeight", "pcbPocketClearance", "insertHeight",
  "platterCornerRadius", "windowGap", "ejectSlotWidth", "pryNotchSides",
  "pryNotchScale", "cornerScrewD", "postClearance", "periScrewD",
  "outerCornerRadius", "useHexNut", "nutAcrossFlats", "nutHeight", "nutPocketClearance",
] as const satisfies readonly (keyof AppConfig)[];

export type PresetSettings = Pick<AppConfig, typeof PRESET_KEYS[number]>;
export interface UserPreset { id: string; name: string; settings: PresetSettings }
export const DEFAULT_PRESET_ID = "default";
export const PRESETS_STORAGE_KEY = "psj_config_presets_v1";

export function pickPresetSettings(config: AppConfig): PresetSettings {
  return JSON.parse(JSON.stringify(Object.fromEntries(PRESET_KEYS.map((key) => [key, config[key]]))));
}

const ranges: Partial<Record<keyof PresetSettings, [number, number]>> = {
  stencilThickness: [0.05, 1], padShrink: [0, 50], stencilFrameWidth: [3, 30],
  stencilCornerRadius: [0, 20], pocketClearance: [0, 2], stencilTaper: [100, 115],
  stencilStaggerGap: [0.3, 2], stencilStaggerOffset: [0.05, 0.5],
  stencilTestPointMaxDia: [0.5, 3], stencilTestPointIsolation: [0.5, 5],
  stencilGridSize: [1, 10], stencilGridBar: [0.3, 2], screwSpacing: [0, 500],
  baseHeight: [0.1, 100], topCoverHeight: [0.1, 100], pcbPocketClearance: [0, 2],
  insertHeight: [4, 20], platterCornerRadius: [0, 10], windowGap: [0, 5],
  ejectSlotWidth: [0, 40], pryNotchScale: [0.5, 1.5], cornerScrewD: [3, 15],
  postClearance: [0, 1], periScrewD: [1.5, 6], outerCornerRadius: [0, 10],
  nutAcrossFlats: [0.1, 100], nutHeight: [0.1, 100], nutPocketClearance: [0, 1],
};

/** Validate before mutating state; fill fields added in later app versions. */
export function readPresetSettings(raw: unknown, defaults: AppConfig): PresetSettings {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("presets.invalidData");
  const source = raw as Record<string, unknown>;
  const result = pickPresetSettings(defaults);
  for (const key of PRESET_KEYS) {
    const value = source[key];
    if (value === undefined) continue;
    const fallback = result[key];
    let valid = false;
    if (typeof fallback === "number") {
      const [min, max] = ranges[key]!;
      valid = typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
    } else if (typeof fallback === "boolean") valid = typeof value === "boolean";
    else if (key === "screwSpec") valid = ["M2.5", "M3", "M3.5", "M4", "M5"].includes(String(value));
    else if (key === "stencilFrameShape") valid = ["outline", "rect"].includes(String(value));
    else if (key === "pryNotchSides") valid = Array.isArray(value) && value.every((s) => ["up", "down", "left", "right"].includes(s)) && new Set(value).size === value.length;
    if (!valid) throw new Error("presets.invalidData");
    Object.assign(result, { [key]: value });
  }
  return JSON.parse(JSON.stringify(result));
}

export function presetName(raw: string, presets: UserPreset[], exceptId?: string): string {
  const name = raw.trim();
  if (!name || name.length > 40 || ["default", "默认配置", "デフォルト", "기본 설정"].includes(name.toLowerCase()) ||
      presets.some((p) => p.id !== exceptId && p.name.toLowerCase() === name.toLowerCase())) {
    throw new Error("presets.invalidName");
  }
  return name;
}
