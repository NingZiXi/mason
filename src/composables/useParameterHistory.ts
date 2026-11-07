import { computed, nextTick, shallowRef, watch } from "vue";
import type { AppConfig } from "../stores/config";
import { PRESET_KEYS } from "../lib/config-presets";
import { apertureSnapshot, type ApertureSnapshot } from "../lib/pad-overrides";

// Keep only small parameter values. Never copy Gerber geometry into history.
const HISTORY_KEYS = [...PRESET_KEYS, "pcbSizeX", "pcbSizeY", "pcbThickness",
  "stencilSizeX", "stencilSizeY", "stencilLip", "jigSize", "platterHeight", "platterMargin"] as const;
export type ParameterSnapshot = Pick<AppConfig, typeof HISTORY_KEYS[number]> & { apertures: ApertureSnapshot };
const DERIVED_KEYS = new Set<string>(["jigSize", "platterHeight", "platterMargin", "periScrewD", "nutAcrossFlats", "nutHeight"]);
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const LIMIT = 50;

export function useParameterHistory(options: {
  config: () => AppConfig;
  context: () => unknown[];
  restore: (snapshot: ParameterSnapshot) => Promise<void>;
}) {
  function snapshot(): ParameterSnapshot {
    const config = options.config();
    return clone({ ...Object.fromEntries(HISTORY_KEYS.map((key) => [key, config[key]])),
      apertures: apertureSnapshot(config.stencilPadsTop, config.stencilPadsBottom) }) as ParameterSnapshot;
  }
  const past = shallowRef<ParameterSnapshot[]>([]);
  const future = shallowRef<ParameterSnapshot[]>([]);
  const busy = shallowRef(false);
  let present = snapshot();
  let context = options.context();
  let lastGroup = "";
  let lastEdit = 0;
  let dragging = false;

  function breakGroup() { lastGroup = ""; }
  function beginInteraction() { dragging = true; breakGroup(); }
  function endInteraction() { dragging = false; }
  function clear() {
    past.value = [];
    future.value = [];
    present = snapshot();
    context = options.context();
    breakGroup();
    dragging = false;
  }

  watch(() => ({ value: snapshot(), context: options.context() }), (state) => {
    if (state.context.some((value, index) => value !== context[index])) {
      clear();
      return;
    }
    if (busy.value || equal(present, state.value)) return;
    const changed = [...HISTORY_KEYS, "apertures" as const].filter((key) => !equal(present[key], state.value[key]));
    const primary = changed.filter((key) => !DERIVED_KEYS.has(key));
    const group = (primary.length ? primary : changed).join(",");
    const now = Date.now();
    if (!lastGroup || (!dragging && (group !== lastGroup || now - lastEdit > 600))) {
      past.value = [...past.value, present].slice(-LIMIT);
    }
    future.value = [];
    present = state.value;
    lastGroup = group;
    lastEdit = now;
    // Dragging a control back to its starting value is a net-zero edit.
    if (equal(past.value[past.value.length - 1], present)) {
      past.value = past.value.slice(0, -1);
      breakGroup();
    }
  }, { flush: "post" });

  async function move(direction: "undo" | "redo") {
    if (busy.value) return;
    // Include an input change from the same event before moving through history.
    await nextTick();
    if (busy.value) return;
    const from = direction === "undo" ? past : future;
    const to = direction === "undo" ? future : past;
    const target = from.value[from.value.length - 1];
    if (!target) return;
    busy.value = true;
    const previous = present;
    const previousContext = context;
    try {
      await options.restore(clone(target));
      // A new import takes precedence over an in-flight history action.
      if (previousContext !== context) return;
      from.value = from.value.slice(0, -1);
      to.value = [...to.value, previous].slice(-LIMIT);
      present = snapshot();
    } finally {
      busy.value = false;
      breakGroup();
    }
  }

  return {
    canUndo: computed(() => !busy.value && past.value.length > 0),
    canRedo: computed(() => !busy.value && future.value.length > 0),
    busy, undo: () => move("undo"), redo: () => move("redo"),
    clear, breakGroup, beginInteraction, endInteraction,
  };
}
