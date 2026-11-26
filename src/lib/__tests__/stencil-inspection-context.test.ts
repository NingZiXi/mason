import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Vue from 'vue';
import { createRenderer, defineComponent, h, nextTick, reactive, type Component } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { readFileSync } from 'node:fs';
import { compileScript, parse } from '@vue/compiler-sfc';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import { useConfigStore } from '../../stores/config';
import * as modelParams from '../model-params';
import * as padOverrides from '../pad-overrides';
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
  if (name.endsWith('/pad-overrides')) return padOverrides;
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
  offsetWidth: number;
}
const node = (tag: string, text = ''): Node => Vue.markRaw({ tag, props: {}, children: [], parent: null, text, style: {},
  setAttribute(this: Node, key: string, value: string) { this.props[key] = value; },
  querySelector(this: Node, selector: string) {
    if (selector === 'button:not(:disabled)') return all(this).find(n => n.tag === 'button' && !n.props.disabled) ?? null;
    if (selector === 'input:checked') return all(this).find(n => n.tag === 'input' && n.props.checked) ?? null;
    return null;
  },
  focus: vi.fn(),
  offsetWidth: 0,
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
  outline: [{ outer: square(-10), holes: [] }], original: [], openings: [], filtered: [], overlaps: [],
  pads: Array.from({ length: padCount }, (_, sourceIndex) => ({ sourceIndex, width: 2, height: 2, shortEdge: 2, area: 4, decision: 'auto',
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
const findButton = (root: Node, label: string) => all(root).find(n => n.tag === 'button'
  && (n.props['aria-label'] === label || textOf(n).includes(label)));
const button = (root: Node, label: string) => findButton(root, label)!;
const sidebar = (root: Node) => withClass(root, 'inspection-sidebar').find(n => n.tag === 'aside')!;
const openingSummary = (root: Node) => withClass(sidebar(root), 'inspection-counts').map(textOf).join('');
async function click(n: Node) { expect(n).toBeDefined(); expect(n.props.disabled).toBeFalsy(); await (n.props.onClick as () => unknown)(); await nextTick(); }
async function keyDown(target: Node, key: string, modifiers: Partial<KeyboardEvent> = {}) {
  let stopped = false;
  const preventDefault = vi.fn();
  const event = { key, target, preventDefault, stopPropagation() { stopped = true; }, ...modifiers };
  for (let n: Node | null = target; n && !stopped; n = n.parent) {
    const handlers = [n.props.onKeydown].flat().filter(Boolean) as Array<(event: object) => unknown>;
    for (const handler of handlers) await handler({ ...event, currentTarget: n });
  }
  await nextTick();
  return preventDefault;
}
async function selectPad(root: Node, index: number) {
  const pad = all(root).find(n => n.props['data-pad-index'] === index)!;
  const handlers = [pad.props.onKeydown].flat() as Array<(event: Partial<KeyboardEvent>) => unknown>;
  const event = { key: 'Enter', preventDefault() {}, stopPropagation() {} };
  for (const handler of handlers) await handler(event);
  await nextTick();
}

const rangeInput = (root: Node, control: 'size' | 'scale' = 'size') =>
  withClass(root, `inspection-${control}-range`).find(n => n.tag === 'input' && n.props.type === 'range');
const padPath = (root: Node, index: number) => all(root).find(n => n.props['data-pad-index'] === index)!.props.d;
const scaleGuideFactor = (root: Node) => (withClass(root, 'scale-draft-preview')[0]?.props.style as
  Record<string, number> | undefined)?.['--aperture-draft-factor'];
async function changeInput(input: Node, value: string) {
  (input.props.onInput as (e: object) => void)({ target: { value, valueAsNumber: Number(value) } }); await nextTick();
}
async function submitEditPanel(root: Node, control: 'size' | 'scale') {
  const form = withClass(sidebar(root), `inspection-${control}-panel`).find(n => n.tag === 'form')!;
  expect(form).toBeDefined();
  (form.props.onSubmit as (e: object) => void)({ preventDefault() {} }); await nextTick();
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
    const openingCount = () => openingSummary(s.root);
    invoke.mockImplementation((command: string) => command === 'inspect_stencil'
      ? new Promise<StencilInspection>(resolve => { pending.push(resolve); }) : Promise.resolve());

    await selectPad(s.root, 0);
    await click(button(s.root, 'inspection.decision_closed'));
    expect(s.store.config.stencilPadsTop[0].apertureOverride).toBe('closed');
    expect(withClass(s.root, 'manual-mask').map(n => n.props.class)).toEqual(['manual-mask closed']);
    expect(hasClass(canvas, 'is-stale')).toBe(true);
    expect(openingCount()).toMatch(/inspection\.openingCount\s*—/);
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
    expect(openingCount()).toMatch(/inspection\.openingCount\s*—/);
    pending[1](engineResult(2));
    await vi.advanceTimersByTimeAsync(1); await nextTick();
    expect(hasClass(canvas, 'is-stale')).toBe(false);
    expect(openingCount()).toMatch(/inspection\.openingCount\s*2\b/);
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
    expect(findButton(s.root, 'inspection.resetSide')).toBeUndefined();
    await click(button(s.root, 'inspection.details'));
    await click(button(s.root, 'inspection.resetSide'));
    expect(withClass(s.root, 'manual-mask')).toHaveLength(0);
    await s.store.undo(); await nextTick();
    expect(withClass(s.root, 'manual-mask').map(n => n.props.class)).toEqual(['manual-mask open']);
    for (const mode of ['inspection.openings', 'inspection.compare']) {
      await click(button(s.root, mode));
      expect(findButton(sidebar(s.root), 'inspection.decision_closed')).toBeUndefined();
      expect(findButton(sidebar(s.root), 'inspection.selectBySize')).toBeUndefined();
      expect(rangeInput(sidebar(s.root), 'scale')).toBeUndefined();
      expect(openingSummary(s.root)).toContain('inspection.openingCount');
    }
  });

  it('only presents aperture controls for the current selection without disturbing the canvas', async () => {
    const s = await mountInspection();
    const canvas = s.canvases()[0];
    const viewBox = canvas.props.viewBox;
    const tools = sidebar(s.root);
    const expectIdle = () => {
      expect(findButton(tools, 'inspection.decision_open')).toBeUndefined();
      expect(findButton(tools, 'inspection.decision_closed')).toBeUndefined();
      expect(rangeInput(tools, 'scale')).toBeUndefined();
    };

    expectIdle();
    expect(button(tools, 'inspection.selectBySize').props.disabled).toBeFalsy();
    await selectPad(s.root, 0);
    const compactToggle = withClass(s.root, 'inspection-sidebar-toggle').find(n => n.tag === 'button')!;
    expect(compactToggle.props['aria-expanded']).toBe(false);
    expect(button(tools, 'inspection.decision_open').props.disabled).toBeFalsy();
    const initialScale = rangeInput(tools, 'scale')!.props.value;
    await changeInput(rangeInput(tools, 'scale')!, '120');
    await click(button(tools, 'inspection.clearSelection'));
    expectIdle();
    expect(withClass(s.root, 'selected-pad')).toHaveLength(0);
    expect(sidebar(s.root)).toBe(tools);
    expect(s.canvases()[0]).toBe(canvas);
    expect(canvas.props.viewBox).toBe(viewBox);
    expect(s.store.config.stencilPadsTop[0].apertureScale).toBeUndefined();
    await selectPad(s.root, 0);
    expect(rangeInput(tools, 'scale')?.props.value).toBe(initialScale);
  });

  it('opens the compact sidebar and focuses the first decision when selecting all pads from the canvas', async () => {
    invoke.mockResolvedValue(engineResult(2));
    const s = await mountInspection(true);
    const canvas = s.canvases()[0], viewBox = canvas.props.viewBox;
    const tools = sidebar(s.root);
    const toggle = withClass(s.root, 'inspection-sidebar-toggle').find(n => n.tag === 'button')!;
    toggle.offsetWidth = 28;
    expect(toggle.props['aria-controls']).toBe(tools.props.id);
    expect(toggle.props['aria-expanded']).toBe(false);

    const preventDefault = await keyDown(canvas, 'a', { ctrlKey: true });

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(toggle.props['aria-expanded']).toBe(true);
    expect(withClass(s.root, 'selected-pad')[0]?.props.d).toBe([padPath(s.root, 0), padPath(s.root, 1)].join(' '));
    expect(button(tools, 'inspection.decision_open').focus).toHaveBeenCalledOnce();
    expect(s.canvases()[0]).toBe(canvas);
    expect(canvas.props.viewBox).toBe(viewBox);
  });

  it('previews size steps before selecting the pads and applying a local scale', async () => {
    const result = engineResult(2);
    result.pads[0].shortEdge = .4;
    result.pads[1].shortEdge = .5;
    invoke.mockResolvedValue(result);
    const s = await mountInspection(true);
    const canvas = s.canvases()[0];
    const previewPath = () => withClass(s.root, 'size-preview-pad')[0]?.props.d;
    const bothPads = [padPath(s.root, 0), padPath(s.root, 1)].join(' ');
    await click(button(s.root, 'inspection.selectBySize'));
    expect(rangeInput(s.root)?.props.value).toBe(0);
    expect(previewPath()).toBe(padPath(s.root, 0));
    await changeInput(rangeInput(s.root)!, '1');
    expect(previewPath()).toBe(bothPads);
    expect(withClass(s.root, 'selected-pad')).toHaveLength(0);
    expect(rangeInput(s.root, 'scale')).toBeUndefined();
    await vi.advanceTimersByTimeAsync(220); await nextTick();
    expect(engineCalls()).toBe(1);
    await changeInput(rangeInput(s.root)!, '0');
    await submitEditPanel(s.root, 'size');
    expect(previewPath()).toBeUndefined();
    expect(withClass(sidebar(s.root), 'inspection-size-panel')).toHaveLength(0);
    expect(withClass(s.root, 'selected-pad')[0]?.props.d).toBe(padPath(s.root, 0));
    expect(engineCalls()).toBe(1);
    expect(button(s.root, 'inspection.applyScale').props.disabled).toBe(true);
    expect(scaleGuideFactor(s.root)).toBeUndefined();
    await changeInput(rangeInput(s.root, 'scale')!, '120');
    expect(button(s.root, 'inspection.applyScale').props.disabled).toBe(false);
    expect(scaleGuideFactor(s.root)).toBe(1.2);
    expect(s.store.config.stencilPadsTop.map(p => p.apertureScale)).toEqual([undefined, undefined]);
    await vi.advanceTimersByTimeAsync(220); await nextTick();
    expect(engineCalls()).toBe(1);
    await selectPad(s.root, 1);
    expect(scaleGuideFactor(s.root)).toBeUndefined();
    expect(button(s.root, 'inspection.applyScale').props.disabled).toBe(true);
    await selectPad(s.root, 0);
    await changeInput(rangeInput(s.root, 'scale')!, '120');
    await submitEditPanel(s.root, 'scale');
    expect(s.store.config.stencilPadsTop.map(p => p.apertureScale)).toEqual([120, undefined]);
    expect(s.canvases()[0]).toBe(canvas);
    expect(hasClass(canvas, 'is-stale')).toBe(true);
    expect(withClass(s.root, 'scaled-mask')).toHaveLength(1);
    await s.store.undo(); await nextTick();
    expect(s.store.config.stencilPadsTop.map(p => p.apertureScale)).toEqual([undefined, undefined]);
    expect(rangeInput(s.root, 'scale')?.props.disabled).toBeFalsy();
    await s.store.redo(); await nextTick();
    expect(rangeInput(s.root, 'scale')?.props.value).toBe(120);
    await click(button(s.root, 'inspection.restoreDefaultScale'));
    expect(s.store.config.stencilPadsTop.map(p => p.apertureScale)).toEqual([undefined, undefined]);
  });

  it('keeps a local scale independent of global shrink until the user restores the default', async () => {
    const s = await mountInspection();
    const expectScale = (percent: number, status: string) => {
      const slider = rangeInput(s.root, 'scale');
      expect(slider?.props.value).toBe(percent);
      expect(slider?.props['aria-valuetext']).toBe(status);
      const expectedGuide = status === 'inspection.scaleDraft' ? percent / 100 : undefined;
      expect(scaleGuideFactor(s.root)).toBe(expectedGuide);
    };
    const engineParams = () => invoke.mock.calls.filter(([command]) => command === 'inspect_stencil').slice(-1)[0][1]
      .params as ReturnType<typeof modelParams.buildScadParams>;

    s.store.config.padShrink = 20;
    await nextTick(); await vi.advanceTimersByTimeAsync(220); await nextTick();
    await selectPad(s.root, 0);
    expectScale(80, 'inspection.scaleInherited');
    expect(engineParams().pad_shrink).toBe(20);
    expect(s.store.config.stencilPadsTop[0].apertureScale).toBeUndefined();

    await changeInput(rangeInput(s.root, 'scale')!, '90');
    expectScale(90, 'inspection.scaleDraft');
    await click(button(s.root, 'inspection.selectBySize'));
    expect(rangeInput(s.root, 'scale')).toBeUndefined();
    expect(scaleGuideFactor(s.root)).toBeUndefined();
    await keyDown(sidebar(s.root), 'Escape');
    expectScale(90, 'inspection.scaleDraft');
    await keyDown(rangeInput(s.root, 'scale')!, 'Escape');
    expectScale(80, 'inspection.scaleInherited');
    expect(s.store.config.stencilPadsTop[0].apertureScale).toBeUndefined();
    await changeInput(rangeInput(s.root, 'scale')!, '90');
    await submitEditPanel(s.root, 'scale');
    expect(s.store.config.stencilPadsTop[0].apertureScale).toBe(90);
    await vi.advanceTimersByTimeAsync(220); await nextTick();
    expectScale(90, 'inspection.scaleIndividual');

    s.store.config.padShrink = 25;
    await nextTick(); await vi.advanceTimersByTimeAsync(220); await nextTick();
    expectScale(90, 'inspection.scaleIndividual');
    expect(engineParams().pad_shrink).toBe(25);
    expect(engineParams().stencil_pads_top[0].apertureScale).toBe(90);

    await click(button(s.root, 'inspection.restoreDefaultScale'));
    expect(s.store.config.stencilPadsTop[0].apertureScale).toBeUndefined();
    await vi.advanceTimersByTimeAsync(220); await nextTick();
    expectScale(75, 'inspection.scaleInherited');
    expect(engineParams().stencil_pads_top[0].apertureScale).toBeUndefined();
  });

  it('starts from the smallest size when changing the metric or the board side', async () => {
    const result = engineResult(2);
    Object.assign(result.pads[0], { shortEdge: .4, area: .8 });
    Object.assign(result.pads[1], { shortEdge: .5, area: .5 });
    invoke.mockResolvedValue(result);
    const s = await mountInspection(true);
    const metric = () => withClass(s.root, 'inspection-size-metric').find(n => n.props.role === 'radiogroup');
    const previewPath = () => withClass(s.root, 'size-preview-pad')[0]?.props.d;
    await click(button(s.root, 'inspection.selectBySize'));
    await changeInput(rangeInput(s.root)!, '1');
    const area = all(metric()!).find(n => n.tag === 'input' && n.props.type === 'radio' && n.props.value === 'area');
    (area!.props.onChange as () => void)();
    await nextTick();
    expect(metric()?.props['data-metric']).toBe('area');
    expect(rangeInput(s.root)?.props.value).toBe(0);
    expect(previewPath()).toBe(padPath(s.root, 1));
    await changeInput(rangeInput(s.root)!, '1');
    s.state.side = 'bottom'; await nextTick();
    await vi.advanceTimersByTimeAsync(220); await nextTick();
    expect(rangeInput(s.root)).toBeUndefined();
    expect(previewPath()).toBeUndefined();
    await click(button(s.root, 'inspection.selectBySize'));
    expect(metric()?.props['data-metric']).toBe('shortEdge');
    expect(rangeInput(s.root)?.props.value).toBe(0);
    expect(previewPath()).toBe(padPath(s.root, 0));
  });

  it('lets the user confirm the only size group without an inactive slider', async () => {
    const s = await mountInspection();
    await click(button(s.root, 'inspection.selectBySize'));
    expect(rangeInput(s.root)).toBeUndefined();
    expect(withClass(s.root, 'size-preview-pad')[0]?.props.d).toBe(padPath(s.root, 0));
    await submitEditPanel(s.root, 'size');
    expect(withClass(s.root, 'selected-pad')[0]?.props.d).toBe(padPath(s.root, 0));
  });

  it('toggles test point markers in the sidebar without changing aperture results', async () => {
    const result = engineResult(2);
    const pad = result.pads[1];
    result.filtered = [{ sourceIndex: pad.sourceIndex, reason: 'probe', polygons: pad.polygons, width: pad.width, height: pad.height }];
    result.summary = { ...result.summary, filteredPads: 1, openings: 1 };
    invoke.mockResolvedValue(result);
    const s = await mountInspection(true);
    const tools = sidebar(s.root);
    const markerLayer = () => withClass(s.root, 'filtered-mask')[0]?.parent;
    const markersVisible = () => !!markerLayer() && hasClass(markerLayer()!, 'is-visible');
    const filter = withClass(tools, 'filtered-toggle')[0];

    expect(filter.props['aria-pressed']).toBe(true);
    expect(markersVisible()).toBe(true);
    await click(filter);
    expect(filter.props['aria-pressed']).toBe(false);
    expect(markersVisible()).toBe(false);
    expect(s.store.config.stencilPadsTop.map(pad => pad.apertureOverride)).toEqual([undefined, undefined]);
    expect(engineCalls()).toBe(1);

    await selectPad(s.root, 1);
    expect(withClass(tools, 'inspection-details-panel')).toHaveLength(0);
    expect(textOf(tools)).toMatch(/#2.*2 mm.*4 mm²/);
    expect(textOf(tools)).toContain('inspection.reason_probe');
  });

  it('reveals an overlap in comparison and removes the old warning during recalculation', async () => {
    const result = engineResult(2);
    result.overlaps = [{ sourceIndices: [0, 1], polygons: [{ outer: [[0, 0], [.1, 0], [.1, .2], [0, .2]], holes: [] }] }];
    invoke.mockResolvedValue(result);
    const s = await mountInspection(true);
    expect(withClass(s.root, 'inspection-overlap-alert')).toHaveLength(1);
    expect(withClass(s.root, 'overlap-mask')).toHaveLength(0);
    await click(button(s.root, 'inspection.reviewOverlaps'));
    expect(withClass(s.root, 'overlap-mask')).toHaveLength(1);
    expect(rangeInput(s.root, 'scale')).toBeUndefined();
    s.store.setApertureScales('top', [0], 120); await nextTick();
    expect(withClass(s.root, 'inspection-overlap-alert')).toHaveLength(0);
    expect(withClass(s.root, 'overlap-mask')).toHaveLength(0);
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
    expect(openingSummary(s.root)).toMatch(/inspection\.openingCount\s*—/);
    expect(button(s.root, 'inspection.decision_open').props.disabled).toBe(false);
    invoke.mockImplementation(async (command: string) => command === 'inspect_stencil' ? engineResult() : undefined);
    await click(button(s.root, 'inspection.retry'));
    expect(withClass(s.root, 'has-error')).toHaveLength(0);
    expect(openingSummary(s.root)).toMatch(/inspection\.openingCount\s*1\b/);
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
    expect(!!findButton(s.root, 'inspection.decision_open')).toBe(false);
  });
});
