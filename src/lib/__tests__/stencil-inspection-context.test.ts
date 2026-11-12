import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Vue from 'vue';
import { createRenderer, defineComponent, h, nextTick, reactive, type Component } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { readFileSync } from 'node:fs';
import { compileScript, parse } from '@vue/compiler-sfc';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import { useConfigStore } from '../../stores/config';
import * as modelParams from '../model-params';
import * as generationTasks from '../generation-tasks';
import * as inspection from '../stencil-inspection';
import * as interaction from '../inspection-interaction';
import * as selection from '../inspection-selection';
import * as inspectionRequests from '../../composables/useStencilInspection';
import { makePanelVariant } from '../gerber/panel';
import type { PadPolygon } from '../gerber/pads';
import type { StencilInspection } from '../stencil-inspection';

// Compile the real SFC, including its context/reset watchers and SVG condition.
// A small Vue renderer exercises this lifecycle without controlling the desktop.
const source = readFileSync(new URL('../../components/StencilInspection.vue', import.meta.url), 'utf8');
const script = compileScript(parse(source).descriptor, { id: 'inspection-context', inlineTemplate: true });
const javascript = transpileModule(script.content, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText;
const invoke = vi.fn();
const Empty = defineComponent({ setup: () => () => null });
const Passthrough = defineComponent({ inheritAttrs: false, setup: (_props, { slots }) => () => slots.default?.() });
const resolveImport = (name: string) => {
  if (name === 'vue') return { ...Vue, Transition: Passthrough };
  if (name === 'vue-i18n') return { useI18n: () => ({ t: (key: string) => key, locale: Vue.ref('en') }) };
  if (name === '@tauri-apps/api/core') return { invoke };
  if (name.endsWith('/stores/config')) return { useConfigStore };
  if (name.endsWith('/stores/ui')) return { useUiStore: () => ({ inspectionOnboardingSeen: true }) };
  if (name.endsWith('/model-params')) return modelParams;
  if (name.endsWith('/generation-tasks')) return generationTasks;
  if (name.endsWith('/stencil-inspection')) return inspection;
  if (name.endsWith('/inspection-interaction')) return interaction;
  if (name.endsWith('/inspection-selection')) return selection;
  if (name.endsWith('/useStencilInspection')) return inspectionRequests;
  if (name.endsWith('/useFirstUseTour')) return { useFirstUseTour: () => ({ open: Vue.ref(false), start: vi.fn(), close: vi.fn() }) };
  if (name.endsWith('/useCompletionFeedback')) return { useCompletionFeedback: () => ({ completed: Vue.ref(false), complete: vi.fn(), reset: vi.fn() }) };
  if (name.endsWith('.vue')) return { default: Empty };
  throw new Error(`Unexpected inspection dependency: ${name}`);
};
const compiled = { exports: {} as { default: Component } };
new Function('require', 'exports', 'module', javascript)(resolveImport, compiled.exports, compiled);
const Inspection = compiled.exports.default;

interface Node {
  tag: string; props: Record<string, unknown>; children: Node[]; parent: Node | null; text: string;
  style: Record<string, string>;
  setAttribute: (key: string, value: string) => void;
}
const node = (tag: string, text = ''): Node => Vue.markRaw({ tag, props: {}, children: [], parent: null, text, style: {},
  setAttribute(this: Node, key: string, value: string) { this.props[key] = value; },
});
const renderer = createRenderer<Node, Node>({
  createElement: tag => node(tag), createText: text => node('#text', text), createComment: text => node('#comment', text),
  setText: (element, text) => { element.text = text; },
  setElementText: (element, text) => { element.text = text; element.children = []; },
  patchProp: (element, key, _previous, value) => { element.props[key] = value; },
  insert: (element, parent, anchor) => {
    if (element.parent) element.parent.children.splice(element.parent.children.indexOf(element), 1);
    element.parent = parent;
    const index = anchor ? parent.children.indexOf(anchor) : -1;
    if (index < 0) parent.children.push(element); else parent.children.splice(index, 0, element);
  },
  remove: element => {
    if (element.parent) element.parent.children.splice(element.parent.children.indexOf(element), 1);
    element.parent = null;
  },
  parentNode: element => element.parent,
  nextSibling: element => element.parent?.children[element.parent.children.indexOf(element) + 1] ?? null,
  insertStaticContent: (content, parent, anchor) => {
    const element = node('#static', content); element.parent = parent;
    const index = anchor ? parent.children.indexOf(anchor) : -1;
    if (index < 0) parent.children.push(element); else parent.children.splice(index, 0, element);
    return [element, element];
  },
});
const all = (root: Node): Node[] => [root, ...root.children.flatMap(all)];
const mounted: Array<() => void> = [];
const square = (x: number): Array<[number, number]> => [[x, 0], [x + 20, 0], [x + 20, 20], [x, 20], [x, 0]];
function payload() {
  const raw: PadPolygon[] = [10, 30].map(x => ({ type: 'rect', cx: x, cy: 10, polarity: 'D',
    parts: [{ polarity: 'D', points: [[x - 1, 9], [x + 1, 9], [x + 1, 11], [x - 1, 11], [x - 1, 9]] }] }));
  const board = (x: number) => makePanelVariant({ points: square(x), holes: [],
    bbox: { minX: x, minY: 0, maxX: x + 20, maxY: 20 } }, raw, []);
  const first = board(0), second = board(20);
  return { filename: 'identical-sr.zip', isPanel: true, hasPads: true, mode: 'board' as const, boardIndex: 0,
    variants: { panel: makePanelVariant({ points: [[0, 0], [40, 0], [40, 20], [0, 20], [0, 0]], holes: [],
      bbox: { minX: 0, minY: 0, maxX: 40, maxY: 20 } }, raw, []), single: first, boards: [first, second] } };
}
const engineResult = (): StencilInspection => ({ side: 'top', mirrored: true,
  outline: [{ outer: square(-10), holes: [] }], original: [], openings: [], filtered: [],
  pads: [{ sourceIndex: 0, width: 2, height: 2, decision: 'auto',
    polygons: [{ outer: [[-1, -1], [1, -1], [1, 1], [-1, 1]], holes: [] }] }],
  summary: { sourcePads: 1, filteredPads: 0, openings: 1, invalidPads: 0 } });
beforeEach(() => {
  vi.useFakeTimers(); setActivePinia(createPinia());
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  invoke.mockReset(); invoke.mockImplementation(async (command: string) => command === 'inspect_stencil' ? engineResult() : undefined);
});
afterEach(() => { mounted.splice(0).forEach(unmount => unmount()); vi.useRealTimers(); vi.unstubAllGlobals(); });
async function mountInspection() {
  const store = useConfigStore();
  store.pythonDetected = true; store.applyGerberImport(payload());
  const state = reactive({ active: true, side: 'top' as const });
  const root = node('root');
  const app = renderer.createApp(defineComponent({ setup: () => () => h(Inspection, state) }));
  app.mount(root); mounted.push(() => app.unmount());
  await vi.advanceTimersByTimeAsync(220); await nextTick();
  const canvases = () => all(root).filter(n => n.tag === 'svg' && n.props['aria-label'] === 'inspection.title');
  return { store, state, root, canvases };
}
const engineCalls = () => invoke.mock.calls.filter(([command]) => command === 'inspect_stencil').length;

describe('2D inspection board context lifecycle', () => {
  it('keeps a visible editable canvas when changing between identical SR boards with the same engine key', async () => {
    const s = await mountInspection();
    expect(s.canvases()).toHaveLength(1);
    expect(engineCalls()).toBe(1);
    s.store.setPanelBoard(1);
    await nextTick(); await vi.advanceTimersByTimeAsync(220);
    expect(s.canvases()).toHaveLength(1);
    expect(all(s.root).some(n => n.props['data-pad-index'] === 0)).toBe(true);
    expect(engineCalls()).toBe(1);
  });

  it('reuses the current result after reimporting identical geometry with new outline and pad references', async () => {
    const s = await mountInspection();
    const before = s.store.config.stencilPadsTop;
    s.store.applyGerberImport(payload());
    expect(s.store.config.stencilPadsTop).not.toBe(before);
    await nextTick(); await vi.advanceTimersByTimeAsync(220);
    expect(s.canvases()).toHaveLength(1);
    expect(engineCalls()).toBe(1);
  });

  it('does not reaccept the old result while replacement geometry with a different key is still loading', async () => {
    const s = await mountInspection();
    let resolve!: (result: StencilInspection) => void;
    invoke.mockImplementation((command: string) => command === 'inspect_stencil'
      ? new Promise<StencilInspection>(done => { resolve = done; }) : Promise.resolve());
    const changed = payload();
    changed.variants.boards![0].topPads![0].parts[0].points[0][0] -= 1;
    s.store.applyGerberImport(changed);
    await nextTick();
    expect(s.canvases()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(220);
    expect(s.canvases()).toHaveLength(0);
    resolve(engineResult());
    await vi.advanceTimersByTimeAsync(1); await nextTick();
    expect(s.canvases()).toHaveLength(1);
    expect(engineCalls()).toBe(2);
  });
});
