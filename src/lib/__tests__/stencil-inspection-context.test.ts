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
import * as completionFeedback from '../../composables/useCompletionFeedback';
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
  if (name.endsWith('/directives/app-tooltip')) return { vAppTooltip: {} };
  if (name.endsWith('/useStencilInspection')) return inspectionRequests;
  if (name.endsWith('/useFirstUseTour')) return { useFirstUseTour: () => ({ open: Vue.ref(false), start: vi.fn(), close: vi.fn() }) };
  if (name.endsWith('/useCompletionFeedback')) return completionFeedback;
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
  querySelector: (selector: string) => Node | null;
  focus: () => void;
}
const node = (tag: string, text = ''): Node => Vue.markRaw({ tag, props: {}, children: [], parent: null, text, style: {},
  setAttribute(this: Node, key: string, value: string) { this.props[key] = value; },
  querySelector(this: Node) { return all(this).find(n => n.tag === 'button' && !n.props.disabled) ?? null; },
  focus() {},
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
const engineResult = (padCount = 1): StencilInspection => ({ side: 'top', mirrored: true,
  outline: [{ outer: square(-10), holes: [] }], original: [], openings: [], filtered: [],
  pads: Array.from({ length: padCount }, (_, sourceIndex) => ({ sourceIndex, width: 2, height: 2, decision: 'auto',
    polygons: [{ outer: [[sourceIndex * 4 - 1, -1], [sourceIndex * 4 + 1, -1], [sourceIndex * 4 + 1, 1], [sourceIndex * 4 - 1, 1]], holes: [] }] })),
  summary: { sourcePads: padCount, filteredPads: 0, openings: padCount, invalidPads: 0 } });
beforeEach(() => {
  vi.useFakeTimers(); setActivePinia(createPinia());
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  invoke.mockReset(); invoke.mockImplementation(async (command: string) => command === 'inspect_stencil' ? engineResult() : undefined);
});
afterEach(() => { mounted.splice(0).forEach(unmount => unmount()); vi.useRealTimers(); vi.unstubAllGlobals(); });
async function mountInspection(panel = false) {
  const store = useConfigStore();
  store.pythonDetected = true; store.applyGerberImport({ ...payload(), mode: panel ? 'panel' : 'board' });
  const state = reactive({ active: true, side: 'top' as 'top' | 'bottom' });
  const root = node('root');
  const app = renderer.createApp(defineComponent({ setup: () => () => h(Inspection, state) }));
  app.mount(root); mounted.push(() => app.unmount());
  await vi.advanceTimersByTimeAsync(220); await nextTick();
  const canvases = () => all(root).filter(n => n.tag === 'svg' && n.props['aria-label'] === 'inspection.title');
  return { store, state, root, canvases };
}
const engineCalls = () => invoke.mock.calls.filter(([command]) => command === 'inspect_stencil').length;
const hasClass = (n: Node, name: string) => typeof n.props.class === 'string' && n.props.class.split(' ').includes(name);
const withClass = (root: Node, name: string) => all(root).filter(n => hasClass(n, name));
const textOf = (root: Node): string => root.text + root.children.map(textOf).join('');
const button = (root: Node, text: string) => all(root).find(n => n.tag === 'button' && textOf(n).includes(text))!;
async function click(n: Node) { expect(n).toBeDefined(); expect(n.props.disabled).toBeFalsy(); await (n.props.onClick as () => unknown)(); await nextTick(); }
async function selectPad(root: Node, index: number) {
  const pad = all(root).find(n => n.props['data-pad-index'] === index)!;
  const handlers = [pad.props.onKeydown].flat() as Array<(event: Partial<KeyboardEvent>) => unknown>;
  const event = { key: 'Enter', preventDefault() {}, stopPropagation() {} };
  for (const handler of handlers) await handler(event);
  await nextTick();
}

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

  it('keeps raw geometry and selection usable through consecutive in-flight decisions', async () => {
    invoke.mockImplementation(async (command: string) => command === 'inspect_stencil' ? engineResult(2) : undefined);
    const s = await mountInspection(true);
    const canvas = s.canvases()[0], viewBox = canvas.props.viewBox;
    const hit = all(s.root).find(n => n.props['data-pad-index'] === 0);
    const pending: Array<(result: StencilInspection) => void> = [];
    invoke.mockImplementation((command: string) => command === 'inspect_stencil'
      ? new Promise<StencilInspection>(resolve => { pending.push(resolve); }) : Promise.resolve());

    await selectPad(s.root, 0);
    await click(button(s.root, 'inspection.decision_closed'));
    expect(s.store.config.stencilPadsTop[0].apertureOverride).toBe('closed');
    expect(withClass(s.root, 'manual-mask').map(n => n.props.class)).toEqual(['manual-mask closed']);
    expect(hasClass(canvas, 'is-stale')).toBe(true);
    expect(textOf(withClass(s.root, 'inspection-counts')[0])).toContain('inspection.openingCount —');
    expect(withClass(s.root, 'is-complete')).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(200);
    expect(pending).toHaveLength(1);

    await selectPad(s.root, 1);
    await click(button(s.root, 'inspection.decision_open'));
    expect(s.store.config.stencilPadsTop[1].apertureOverride).toBe('open');
    expect(withClass(s.root, 'manual-mask').map(n => n.props.class)).toEqual(['manual-mask closed', 'manual-mask open']);
    expect(button(s.root, 'inspection.restoreAuto').props.disabled).toBe(false);
    expect(s.canvases()[0]).toBe(canvas);
    expect(canvas.props.viewBox).toBe(viewBox);
    expect(all(s.root).find(n => n.props['data-pad-index'] === 0)).toBe(hit);
    await vi.advanceTimersByTimeAsync(200);
    expect(pending).toHaveLength(2);

    pending[0]({ ...engineResult(2), summary: { sourcePads: 2, filteredPads: 0, openings: 99, invalidPads: 0 } });
    await vi.advanceTimersByTimeAsync(1); await nextTick();
    expect(hasClass(canvas, 'is-stale')).toBe(true);
    expect(textOf(withClass(s.root, 'inspection-counts')[0])).not.toContain('99');
    pending[1](engineResult(2));
    await vi.advanceTimersByTimeAsync(1); await nextTick();
    expect(hasClass(canvas, 'is-stale')).toBe(false);
    expect(withClass(s.root, 'is-complete')).toHaveLength(1);
    expect(withClass(s.root, 'manual-mask')).toHaveLength(2);
  });

  it('updates reset and undo immediately and never exposes editing in result-only modes', async () => {
    const s = await mountInspection();
    await selectPad(s.root, 0);
    await click(button(s.root, 'inspection.decision_closed'));
    expect(withClass(s.root, 'manual-mask')).toHaveLength(1);
    await click(button(s.root, 'inspection.restoreAuto'));
    expect(withClass(s.root, 'manual-mask')).toHaveLength(0);
    await click(button(s.root, 'inspection.decision_open'));
    await click(button(s.root, 'inspection.resetSide'));
    expect(withClass(s.root, 'manual-mask')).toHaveLength(0);
    await s.store.undo(); await nextTick();
    expect(withClass(s.root, 'manual-mask').map(n => n.props.class)).toEqual(['manual-mask open']);
    await click(button(s.root, 'inspection.openings'));
    expect(button(s.root, 'inspection.decision_closed').props.disabled).toBe(true);
    await click(button(s.root, 'inspection.compare'));
    expect(button(s.root, 'inspection.decision_closed').props.disabled).toBe(true);
  });

  it('keeps a failed background result editable, with stale counts and retry instead of success', async () => {
    const s = await mountInspection();
    invoke.mockImplementation(async (command: string) => {
      if (command === 'inspect_stencil') throw new Error('engine failed');
    });
    await selectPad(s.root, 0);
    await click(button(s.root, 'inspection.decision_closed'));
    await vi.advanceTimersByTimeAsync(200); await nextTick();
    const status = withClass(s.root, 'inspection-state')[0];
    expect(hasClass(status, 'compact')).toBe(true);
    expect(hasClass(status, 'has-error')).toBe(true);
    expect(withClass(s.root, 'is-complete')).toHaveLength(0);
    expect(textOf(withClass(s.root, 'inspection-counts')[0])).toContain('inspection.openingCount —');
    expect(button(s.root, 'inspection.decision_open').props.disabled).toBe(false);
    invoke.mockImplementation(async (command: string) => command === 'inspect_stencil' ? engineResult() : undefined);
    await click(button(s.root, 'inspection.retry'));
    expect(withClass(s.root, 'has-error')).toHaveLength(0);
    expect(hasClass(s.canvases()[0], 'is-stale')).toBe(false);
  });

  it('clears old manual decisions and selection while a new side is loading', async () => {
    const s = await mountInspection();
    await selectPad(s.root, 0);
    await click(button(s.root, 'inspection.decision_closed'));
    invoke.mockImplementation((command: string) => command === 'inspect_stencil' ? new Promise(() => {}) : Promise.resolve());
    s.state.side = 'bottom'; await nextTick();
    expect(s.canvases()).toHaveLength(0);
    expect(withClass(s.root, 'manual-mask')).toHaveLength(0);
    expect(button(s.root, 'inspection.decision_open').props.disabled).toBe(true);
  });
});
