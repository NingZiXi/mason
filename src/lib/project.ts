import type { AppConfig } from "../stores/config";
import type { PadPart, PadPolygon } from "./gerber/pads";
import type { PanelVariant } from "./gerber/panel";

export interface GerberVariants {
  panel: PanelVariant;
  single: PanelVariant;
  hasPads: boolean;
}

export interface ProjectFile {
  version: number;
  config: Record<string, unknown>;
  gerber_filename: string | null;
}

const snakeCase = (key: string) => key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid project object");
  }
  return value as Record<string, unknown>;
}

function points(value: unknown): Array<[number, number]> {
  if (!Array.isArray(value) || !value.every((p) =>
    Array.isArray(p) && p.length === 2 && p.every((n) => typeof n === "number" && Number.isFinite(n))
  )) throw new Error("Invalid project outline points");
  return value;
}

function rings(value: unknown): Array<Array<[number, number]>> {
  if (!Array.isArray(value)) throw new Error("Invalid project outline holes");
  return value.map(points);
}

function polarity(value: unknown): "D" | "C" {
  if (value !== undefined && value !== "D" && value !== "C") throw new Error("Invalid pad polarity");
  return value === "C" ? "C" : "D";
}

/** Accept legacy vertex lists, part lists, and complete pad objects. */
function pads(value: unknown): PadPolygon[] {
  if (!Array.isArray(value)) throw new Error("Invalid project pads");
  return value.map((entry) => {
    const pad = Array.isArray(entry) ? null : object(entry);
    const raw = pad ? pad.parts : entry;
    if (!Array.isArray(raw)) throw new Error("Invalid pad parts");
    const parts: PadPart[] = raw.length > 0 && Array.isArray(raw[0])
      ? [{ polarity: "D", points: points(raw) }]
      : raw.map((part) => {
        const p = object(part);
        return {
          polarity: polarity(p.polarity), points: points(p.points),
          ...(p.holes === undefined ? {} : { holes: rings(p.holes) }),
        };
      });
    const type = pad?.type ?? "macro";
    if (!["circle", "rect", "obround", "line", "polygon", "region", "roundrect", "macro", "arc"].includes(String(type))) {
      throw new Error("Invalid pad type");
    }
    const cx = pad?.cx ?? 0;
    const cy = pad?.cy ?? 0;
    if (typeof cx !== "number" || !Number.isFinite(cx) || typeof cy !== "number" || !Number.isFinite(cy)) {
      throw new Error("Invalid pad center");
    }
    return { type: type as PadPolygon["type"], cx, cy, polarity: polarity(pad?.polarity), parts };
  });
}

function variants(value: unknown): GerberVariants | null {
  if (value == null) return null;
  const v = object(value);
  const variant = (raw: unknown): PanelVariant => {
    const p = object(raw);
    const center = points([[object(p.center).x, object(p.center).y]])[0];
    if (typeof p.width !== "number" || !Number.isFinite(p.width) || p.width <= 0 ||
        typeof p.height !== "number" || !Number.isFinite(p.height) || p.height <= 0) {
      throw new Error("Invalid panel size");
    }
    return {
      width: p.width, height: p.height, center: { x: center[0], y: center[1] },
      outlinePoints: points(p.outlinePoints), outlineHoles: rings(p.outlineHoles),
      ...(p.topPads === undefined ? {} : { topPads: pads(p.topPads) }),
      ...(p.bottomPads === undefined ? {} : { bottomPads: pads(p.bottomPads) }),
    };
  };
  if (typeof v.hasPads !== "boolean") throw new Error("Invalid panel pad state");
  return { panel: variant(v.panel), single: variant(v.single), hasPads: v.hasPads };
}

/** Persist every AppConfig field, including pad metadata and both panel scopes. */
export function serializeProjectConfig(config: AppConfig, panelVariants: GerberVariants | null) {
  return clone({
    ...Object.fromEntries(Object.entries(config).map(([key, value]) => [snakeCase(key), value])),
    panel_variants: panelVariants,
  });
}

export function deserializeProjectConfig(raw: unknown, defaults: AppConfig): {
  config: AppConfig;
  panelVariants: GerberVariants | null;
} {
  const source = object(raw);
  const config = clone(defaults);
  // Build and validate the complete result before changing the active project.
  const restored: Record<string, unknown> = { ...config };
  for (const [key, fallback] of Object.entries(defaults)) {
    const value = source[snakeCase(key)];
    if (value == null) continue;
    if (typeof fallback === "number" && (typeof value !== "number" || !Number.isFinite(value)) ||
        typeof fallback === "boolean" && typeof value !== "boolean" ||
        typeof fallback === "string" && typeof value !== "string") {
      throw new Error(`Invalid project setting: ${snakeCase(key)}`);
    }
    restored[key] = value;
  }
  Object.assign(config, restored);
  const enumValue = (value: string, allowed: string[]) => {
    if (!allowed.includes(value)) throw new Error(`Invalid project option: ${value}`);
  };
  enumValue(config.appMode, ["jig", "stencil"]);
  enumValue(config.panelMode, ["panel", "single"]);
  enumValue(config.screwSpec, ["M2.5", "M3", "M3.5", "M4", "M5"]);
  enumValue(config.stencilFrameShape, ["outline", "rect"]);
  if (config.gerberFilename !== null && typeof config.gerberFilename !== "string") throw new Error("Invalid Gerber filename");
  config.pcbOutlinePoints = points(config.pcbOutlinePoints);
  config.pcbOutlineHoles = rings(config.pcbOutlineHoles);
  config.stencilPadsTop = pads(source.stencil_pads_top ?? source.stencil_pads ?? []);
  config.stencilPadsBottom = pads(source.stencil_pads_bottom ?? []);
  if (!Array.isArray(config.pryNotchSides)) throw new Error("Invalid notch sides");
  config.pryNotchSides.forEach((side) => enumValue(side, ["up", "down", "left", "right"]));

  // v1 used a square stencil and older platter/notch representations.
  const stencilSize = (value: unknown, fallback: number) =>
    typeof value === "number" && value > 0 ? value : fallback;
  const legacyStencil = stencilSize(source.stencil_size, defaults.stencilSizeX);
  config.stencilSizeX = stencilSize(source.stencil_size_x, legacyStencil);
  config.stencilSizeY = stencilSize(source.stencil_size_y, legacyStencil);
  if (source.stencil_lip == null) {
    const half = Math.max(config.stencilSizeX, config.stencilSizeY) / 2;
    if (typeof source.platter_width === "number" && source.platter_width > 0) {
      config.stencilLip = Math.max(0, half - source.platter_width / 2);
    } else if (typeof source.platter_margin === "number") {
      config.stencilLip = Math.max(0, half - Math.max(config.pcbSizeX, config.pcbSizeY) / 2 - config.pcbPocketClearance - source.platter_margin);
    }
  }
  if (source.pry_notch_sides == null && typeof source.pry_notch_side === "string") {
    const side = source.pry_notch_side;
    if (side === "off") config.pryNotchSides = [];
    else if (side !== "auto") {
      enumValue(side, ["up", "down", "left", "right"]);
      config.pryNotchSides = [side as AppConfig["pryNotchSides"][number]];
    }
  }
  const panelVariants = variants(source.panel_variants);
  // Old projects contain only the active geometry; never reuse the previous project's scopes.
  if (!panelVariants) {
    config.panelAvailable = false;
    config.panelGrid = null;
  } else if (config.panelGrid !== null) {
    const grid = object(config.panelGrid);
    if (![grid.nx, grid.ny].every((n) => typeof n === "number" && Number.isInteger(n) && n > 0)) {
      throw new Error("Invalid panel grid");
    }
  }
  return clone({ config, panelVariants });
}
