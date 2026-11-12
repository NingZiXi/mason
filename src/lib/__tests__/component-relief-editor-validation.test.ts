import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Vue from 'vue';
import { createRenderer, defineComponent, h, nextTick, reactive, type Component } from 'vue';
import { readFileSync } from 'node:fs';
import { compileScript, parse } from '@vue/compiler-sfc';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import * as editorHelpers from '../component-relief-editor';
import * as relief from '../component-relief';
import * as padGuide from '../relief-pad-guide';
import * as historyShortcuts from '../history-shortcuts';
import type { ComponentReliefMergeResult, ComponentReliefRegion } from '../component-relief';
import type { PadPolygon } from '../gerber/pads';

// Vitest serves SFCs as SSR modules in this Node suite. Compile the real template
// for Vue's in-memory renderer so these tests exercise the actual button logic.
const source = readFileSync(new URL('../../components/ComponentReliefEditor.vue', import.meta.url), 'utf8');
const script = compileScript(parse(source).descriptor, { id: 'relief-race-test', inlineTemplate: true });
const javascript = transpileModule(script.content, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText;
const autoHelper = {
  generateAutomaticRelief: (_pads: unknown, _outline: unknown, _holes: unknown, _width: number, _height: number,
    existing: ComponentReliefRegion[]) => ({ regions: [...existing,
    { id: 'automatic', shape: 'rect', x: 3, y: 3, width: 4, height: 4 }], added: 1, limited: false }),
};
const compiled = { exports: {} as { default: Component } };
const translations: Array<{ key: string; values?: Record<string, number> }> = [];
const resolveImport = (name: string) => {
  if (name === 'vue') return Vue;
  if (name === 'element-plus') return { ElSwitch: defineComponent({ props: { modelValue: Boolean }, emits: ['update:modelValue'],
    setup: (props, { attrs, emit }) => () => h('button', { ...attrs, role: 'switch', 'aria-checked': props.modelValue,
      onClick: () => emit('update:modelValue', !props.modelValue) }) }) };
  if (name === 'vue-i18n') return { useI18n: () => ({ t: (key: string, values?: Record<string, number>) => {
    translations.push({ key, values }); return key;
  } }) };
  if (name.endsWith('/component-relief')) return relief;
  if (name.endsWith('/relief-pad-guide')) return padGuide;
  if (name.endsWith('/component-relief-editor')) return editorHelpers;
  if (name.endsWith('/component-relief-auto')) return autoHelper;
  if (name.endsWith('/history-shortcuts')) return historyShortcuts;
  if (name.endsWith('/SlidingIndicator.vue')) return { default: { render: () => null } };
  throw new Error(`Unexpected editor dependency: ${name}`);
};
new Function('require', 'exports', 'module', javascript)(resolveImport, compiled.exports, compiled);
const Editor = compiled.exports.default;

interface Node {
  tag: string;
  props: Record<string, unknown>;
  children: Node[];
  parent: Node | null;
  text: string;
  closest(selector: string): { dataset: Record<string, string> } | null;
}
const node = (tag: string, text = ''): Node => Vue.markRaw({ tag, props: {}, children: [], parent: null, text,
  closest(this: Node, selector: string) {
    if (selector.includes('input, textarea') && ['input', 'textarea', 'select'].includes(this.tag)) return { dataset: {} };
    let current: Node | null = this;
    while (current) {
      if (current.props['data-relief-id']) return { dataset: { reliefId: String(current.props['data-relief-id']),
        ...(current.props['data-corner'] ? { corner: String(current.props['data-corner']) } : {}),
        ...(current.props['data-vertex'] !== undefined ? { vertex: String(current.props['data-vertex']) } : {}) } };
      current = current.parent;
    }
    return null;
  } });
const renderer = createRenderer<Node, Node>({
  createElement: tag => {
    const element = node(tag);
    if (tag === 'svg') {
      const captured = new Set<number>();
      Object.assign(element, { clientWidth: 600, clientHeight: 400, getScreenCTM: () => ({ inverse: () => ({}) }), focus: () => {},
        setPointerCapture: (id: number) => captured.add(id), hasPointerCapture: (id: number) => captured.has(id),
        releasePointerCapture: (id: number) => captured.delete(id) });
    }
    return element;
  }, createText: text => node('#text', text), createComment: text => node('#comment', text),
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
    const element = node('#static', content);
    element.parent = parent;
    const index = anchor ? parent.children.indexOf(anchor) : -1;
    if (index < 0) parent.children.push(element); else parent.children.splice(index, 0, element);
    return [element, element];
  },
});
const all = (root: Node): Node[] => [root, ...root.children.flatMap(all)];
const text = (root: Node): string => root.text + root.children.map(text).join('');
function deferred<T = { valid: boolean }>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const mounted: Array<() => void> = [];
let nextFrame = 0;
const frames = new Map<number, FrameRequestCallback>();
const flushFrames = () => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback(0)); };
beforeEach(() => {
  translations.length = 0;
  frames.clear(); nextFrame = 0;
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal('document', { hidden: false, addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal('DOMPoint', class { constructor(public x: number, public y: number) {} matrixTransform() { return this; } });
  vi.stubGlobal('Element', class { static [Symbol.hasInstance](value: unknown) { return Boolean(value && typeof value === 'object' && 'tag' in value); } });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { const id = ++nextFrame; frames.set(id, callback); return id; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
});
afterEach(() => { mounted.splice(0).forEach(unmount => unmount()); vi.unstubAllGlobals(); });
async function mountEditor(validate: (regions: ComponentReliefRegion[]) => Promise<{ valid: boolean }>,
  initialRegions?: ComponentReliefRegion[],
  merge: (regions: ComponentReliefRegion[], gap: number, selectedIds: string[]) => Promise<ComponentReliefMergeResult> =
    async regions => ({ valid: true, regions, merged: 0, skipped: 0 }),
  history?: { canUndo: boolean; canRedo: boolean; undo: () => Promise<void> | void; redo: () => Promise<void> | void }) {
  const old: ComponentReliefRegion = { id: 'manual', shape: 'rect', x: -3, y: -3, width: 3, height: 3 };
  const state = reactive({ modelValue: true, regions: initialRegions ?? [old], outline: [[-10, -10], [10, -10], [10, 10], [-10, 10]] as Array<[number, number]>,
    holes: [] as Array<Array<[number, number]>>, pads: [{ type: 'rect', cx: 0, cy: 0, polarity: 'D', parts: [] }] as PadPolygon[],
    printSide: 'top' as 'top' | 'bottom', width: 20, height: 20, depth: 3, ejectHoleEnabled: true, validateRegions: validate, mergeRegions: merge, ...history });
  const commits: ComponentReliefRegion[][] = [];
  const depthUpdates: number[] = [];
  const ejectHoleUpdates: boolean[] = [];
  const interactions: string[] = [];
  const root = node('root');
  const app = renderer.createApp(defineComponent({ setup: () => () => h(Editor, { ...state,
    'onUpdate:modelValue': (value: boolean) => { state.modelValue = value; },
    'onUpdate:regions': (regions: ComponentReliefRegion[]) => { commits.push(regions); state.regions = regions; },
    'onUpdate:ejectHoleEnabled': (value: boolean) => { ejectHoleUpdates.push(value); state.ejectHoleEnabled = value; },
    'onUpdate:depth': (depth: number) => {
      depthUpdates.push(depth);
      // Match the parent store: changing the creation default freezes legacy
      // depths instead of changing the already drawn pockets.
      state.regions = relief.materializeReliefDepths({ top: state.regions, bottom: [] }, state.depth).top;
      state.depth = depth;
    },
    onInteractionStart: () => interactions.push('start'), onInteractionEnd: () => interactions.push('end'),
  }) }));
  app.component('ElDialog', defineComponent({ setup: (_props, { slots }) => () => h('div', [slots.default?.(), slots.footer?.()]) }));
  app.component('ElInputNumber', defineComponent({ props: { modelValue: Number }, emits: ['update:modelValue'],
    setup: (props, { attrs, emit }) => () => h('input', { ...attrs, modelValue: props.modelValue,
      'onUpdate:modelValue': (value: number) => emit('update:modelValue', value) }) }));
  app.mount(root);
  mounted.push(() => app.unmount());
  await nextTick(); await nextTick();
  const auto = () => all(root).find(element => String(element.props.class ?? '').includes('automatic-button')
    && !String(element.props.class ?? '').includes('merge-button'))!;
  const mergeButton = () => all(root).find(element => String(element.props.class ?? '').includes('merge-button'))!;
  const ejectHoleSwitch = () => all(root).find(element => element.props.role === 'switch' && element.props['aria-label'] === 'config.ejectSlot')!;
  const click = (element: Node, event: Record<string, unknown> = {}) => (element.props.onClick as (event: unknown) => Promise<void> | void)(event);
  const chooseTool = (label: string) => click(all(root).find(element => element.tag === 'button' && text(element).includes(`relief.${label}`))!);
  const choosePolygon = () => chooseTool('polygonTool');
  const canvas = () => all(root).find(element => element.tag === 'svg' && element.props.onPointerdown)!;
  const pointer = (event: 'onPointerdown' | 'onPointermove' | 'onPointerup' | 'onPointercancel' | 'onLostpointercapture',
    x: number, y: number, options: Record<string, unknown> = {}) => {
    const element = canvas();
    (element.props[event] as (event: unknown) => void)({ button: 0, pointerId: 1, isPrimary: true,
      clientX: x, clientY: state.printSide === 'top' ? -y : y, target: element, preventDefault: () => {}, ...options });
    flushFrames();
  };
  const key = (key: string, options: Record<string, unknown> = {}) => {
    const handler = all(root).find(element => element.props.onKeydown)!.props.onKeydown as (event: unknown) => void;
    handler({ key, target: canvas(), preventDefault: () => {}, stopPropagation: () => {}, ...options });
  };
  const enter = () => key('Enter');
  const regionButton = (index: number) => all(root).find(element => element.tag === 'button'
    && element.props['aria-label'] === 'relief.selectedRegion' && text(element) === String(index + 1))!;
  const selectRegion = (index: number, event: Record<string, unknown> = {}) => click(regionButton(index), event);
  const selectedIndices = () => state.regions.flatMap((_region, index) => regionButton(index).props['aria-pressed'] ? [index] : []);
  const selectAll = () => click(all(root).find(element => element.props.class === 'select-all')!);
  const clearSelection = () => click(all(root).find(element => element.props.class === 'clear-selection')!);
  const depthInput = () => all(root).find(element => element.tag === 'input' && element.props['aria-label'] === 'relief.regionDepth')!;
  const updateDepth = (value: number) => (depthInput().props['onUpdate:modelValue'] as (value: number) => void)(value);
  const cutMode = (mode: 'blind' | 'through') => all(root).find(element => element.tag === 'button'
    && text(element) === `relief.${mode}`)!;
  const numericInput = (label: 'allowance' | 'defaultDepth') => all(root).find(element => element.tag === 'input'
    && element.props['aria-label'] === `relief.${label}`)!;
  const updateInput = (label: 'allowance' | 'defaultDepth', value: number) =>
    (numericInput(label).props['onUpdate:modelValue'] as (value: number) => void)(value);
  return { state, commits, depthUpdates, ejectHoleUpdates, ejectHoleSwitch, interactions, root, canvas, auto, merge: mergeButton, click, chooseTool, choosePolygon, pointer, enter, key,
    numericInput, updateInput,
    selectRegion, selectAll, clearSelection, selectedIndices, depthInput, updateDepth, cutMode,
    unmount: () => { mounted.splice(mounted.length - 1, 1); app.unmount(); } };
}

describe('relief editor bottom eject hole', () => {
  it('toggles the shared setting while keeping regions, selection and view unchanged', async () => {
    const editor = await mountEditor(async () => ({ valid: true }), mergeInputs());
    editor.selectRegion(1); await nextTick();
    const original = JSON.stringify(editor.state.regions), view = editor.canvas().props.viewBox;
    expect(editor.ejectHoleSwitch().props['aria-checked']).toBe(true);
    await editor.click(editor.ejectHoleSwitch()); await nextTick();
    expect(editor.state.ejectHoleEnabled).toBe(false);
    expect(editor.ejectHoleSwitch().props['aria-checked']).toBe(false);
    await editor.click(editor.ejectHoleSwitch()); await nextTick();
    expect(editor.state.ejectHoleEnabled).toBe(true);
    expect(editor.ejectHoleUpdates).toEqual([false, true]);
    expect(editor.interactions).toEqual(['start', 'end', 'start', 'end']);
    expect(editor.commits).toHaveLength(0);
    expect(JSON.stringify(editor.state.regions)).toBe(original);
    expect(editor.selectedIndices()).toEqual([1]);
    expect(editor.canvas().props.viewBox).toBe(view);
  });

  it('reflects changes from the main settings without emitting an extra edit', async () => {
    const editor = await mountEditor(async () => ({ valid: true }));
    editor.state.ejectHoleEnabled = false; await nextTick();
    expect(editor.ejectHoleSwitch().props['aria-checked']).toBe(false);
    editor.state.ejectHoleEnabled = true; await nextTick();
    expect(editor.ejectHoleSwitch().props['aria-checked']).toBe(true);
    expect(editor.ejectHoleUpdates).toEqual([]);
    expect(editor.interactions).toEqual([]);
  });

  it.each([
    ['auto', 'editor'], ['auto', 'external'], ['merge', 'editor'], ['merge', 'external'],
  ] as const)('discards a pending %s result after the eject hole changes via %s', async (action, origin) => {
    const automatic = deferred(), merged = deferred<ComponentReliefMergeResult>();
    const editor = await mountEditor(() => automatic.promise, mergeInputs(), () => merged.promise);
    if (action === 'merge') { editor.selectAll(); await nextTick(); }
    const pending = editor.click(action === 'auto' ? editor.auto() : editor.merge()); await nextTick();
    expect((action === 'auto' ? editor.auto() : editor.merge()).props['aria-busy']).toBe(true);
    if (origin === 'editor') await editor.click(editor.ejectHoleSwitch());
    else editor.state.ejectHoleEnabled = false;
    await nextTick();
    automatic.resolve({ valid: true }); merged.resolve(mergeResult());
    await pending; await nextTick();
    expect(editor.commits).toHaveLength(0);
    expect(editor.state.regions).toEqual(mergeInputs());
    expect(editor.state.ejectHoleEnabled).toBe(false);
    expect(editor.auto().props['aria-busy']).toBe(false);
    expect(editor.merge().props['aria-busy']).toBe(false);
  });
});

describe('relief editor history and focus', () => {
  it('paints local macro and image exposures in order in the actual editor template', async () => {
    const editor = await mountEditor(async () => ({ valid: true }));
    editor.state.pads = [{ type: 'rect', cx: 0, cy: 0, polarity: 'D', parts: [
      { polarity: 'D', points: [[-5, -5], [5, -5], [5, 5], [-5, 5]] },
      { polarity: 'C', points: [[-1, -1], [1, -1], [1, 1], [-1, 1]] },
      { polarity: 'D', points: [[-.5, -.5], [.5, -.5], [.5, .5], [-.5, .5]] },
    ] },
    { type: 'rect', cx: 0, cy: 0, polarity: 'C', parts: [
      { polarity: 'D', points: [[-2, -2], [2, -2], [2, 2], [-2, 2]] },
    ] },
    { type: 'rect', cx: 0, cy: 0, polarity: 'D', parts: [
      { polarity: 'D', points: [[-.2, -.2], [.2, -.2], [.2, .2], [-.2, .2]] },
    ] }];
    await nextTick();
    const elements = all(editor.canvas());
    const masks = elements.filter(element => element.tag === 'mask');
    expect(masks).toHaveLength(2);
    const guide = elements.find(element => element.props.class === 'pad-guide')!;
    expect(guide.tag).toBe('rect');
    expect(guide.props.mask).toMatch(/^url\(#relief-.*-pads\)$/);
    const imageMask = masks.find(mask => guide.props.mask === `url(#${mask.props.id})`)!;
    const imagePaths = all(imageMask).filter(element => element.tag === 'path');
    expect(imagePaths.map(path => path.props.fill)).toEqual(['white', 'black', 'white']);
    const macroMask = masks.find(mask => mask !== imageMask)!;
    expect(imagePaths[0].props.mask).toBe(`url(#${macroMask.props.id})`);
    expect(all(macroMask).filter(element => element.tag === 'path').map(path => path.props.fill))
      .toEqual(['white', 'black', 'white']);
    expect(masks.every(mask => mask.props.maskUnits === 'userSpaceOnUse')).toBe(true);
    expect(elements.filter(element => element.tag === 'path' && element.props['fill-rule'] === 'nonzero'))
      .toHaveLength(6);
  });

  const focusEvent = (kind: 'blur' | 'hidden') => {
    if (kind === 'hidden') Reflect.set(document, 'hidden', true);
    const calls = vi.mocked(kind === 'blur' ? window.addEventListener : document.addEventListener).mock.calls;
    const listener = calls.find(([name]) => name === (kind === 'blur' ? 'blur' : 'visibilitychange'))![1] as () => void;
    listener();
  };

  it.each(['blur', 'hidden'] as const)('keeps a pending automatic result after %s', async kind => {
    const check = deferred(), editor = await mountEditor(() => check.promise);
    const pending = editor.click(editor.auto()); await nextTick();
    focusEvent(kind); await nextTick();
    expect(editor.auto().props['aria-busy']).toBe(true);
    check.resolve({ valid: true }); await pending; await nextTick();
    expect(editor.commits).toHaveLength(1);
  });

  it.each(['blur', 'hidden'] as const)('keeps a pending merge result after %s', async kind => {
    const check = deferred<ComponentReliefMergeResult>();
    const editor = await mountEditor(async () => ({ valid: true }), mergeInputs(), () => check.promise);
    editor.selectAll(); await nextTick();
    const pending = editor.click(editor.merge()); await nextTick();
    focusEvent(kind); await nextTick();
    expect(editor.merge().props['aria-busy']).toBe(true);
    check.resolve(mergeResult()); await pending; await nextTick();
    expect(editor.commits).toHaveLength(1);
  });

  it.each(['blur', 'hidden'] as const)('keeps unfinished polygon points after %s', async kind => {
    const editor = await mountEditor(async () => ({ valid: true }));
    editor.choosePolygon(); await nextTick();
    editor.pointer('onPointerdown', -6, -6); editor.pointer('onPointerdown', 6, -6); editor.pointer('onPointerdown', 6, 6);
    focusEvent(kind); await nextTick();
    editor.enter(); await nextTick();
    expect(editor.commits).toHaveLength(1);
    expect(editor.state.regions[editor.state.regions.length - 1]).toMatchObject({ shape: 'polygon', points: [[-6, -6], [6, -6], [6, 6]] });
  });

  it('handles undo and redo locally while keeping editable inputs and IME native', async () => {
    const undo = vi.fn(), redo = vi.fn();
    const editor = await mountEditor(async () => ({ valid: true }), undefined, undefined,
      { canUndo: true, canRedo: true, undo, redo });
    const preventDefault = vi.fn(), stopPropagation = vi.fn();
    editor.key('z', { ctrlKey: true, preventDefault, stopPropagation }); await nextTick();
    editor.key('z', { metaKey: true, shiftKey: true }); await nextTick();
    editor.key('y', { ctrlKey: true }); await nextTick();
    expect(undo).toHaveBeenCalledOnce(); expect(redo).toHaveBeenCalledTimes(2);
    expect(preventDefault).toHaveBeenCalledOnce(); expect(stopPropagation).toHaveBeenCalledOnce();
    editor.key('z', { ctrlKey: true, target: editor.numericInput('defaultDepth') });
    editor.key('z', { ctrlKey: true, isComposing: true }); await nextTick();
    expect(undo).toHaveBeenCalledOnce();
  });

  it('runs history once while pending and invalidates the older automatic result', async () => {
    const check = deferred(), history = deferred<void>();
    const undo = vi.fn(() => history.promise), redo = vi.fn();
    const editor = await mountEditor(() => check.promise, undefined, undefined,
      { canUndo: true, canRedo: true, undo, redo });
    const pending = editor.click(editor.auto()); await nextTick();
    const undoButton = all(editor.root).find(element => element.props['aria-label'] === 'history.undo')!;
    const first = editor.click(undoButton);
    editor.click(undoButton); editor.key('y', { ctrlKey: true }); await nextTick();
    expect(undo).toHaveBeenCalledOnce(); expect(redo).not.toHaveBeenCalled();
    expect(undoButton.props.disabled).toBe(true);
    check.resolve({ valid: true }); await pending; await nextTick();
    expect(editor.commits).toHaveLength(0);
    history.resolve(); await first; await nextTick();
    expect(undoButton.props.disabled).toBe(false);
  });

  it('updates the visible regions and enabled history actions without closing the editor', async () => {
    const original = mergeInputs();
    const undo = vi.fn(() => {
      editor.state.regions = original.slice(0, 1);
      editor.state.canUndo = false; editor.state.canRedo = true;
    });
    const redo = vi.fn(() => {
      editor.state.regions = original;
      editor.state.canUndo = true; editor.state.canRedo = false;
    });
    const editor = await mountEditor(async () => ({ valid: true }), original, undefined,
      { canUndo: true, canRedo: false, undo, redo });
    editor.selectRegion(2); await nextTick();
    const historyButton = (action: string) => all(editor.root).find(element => element.props['aria-label'] === `history.${action}`)!;
    await editor.click(historyButton('undo')); await nextTick();
    expect(editor.state.modelValue).toBe(true);
    expect(editor.state.regions).toEqual(original.slice(0, 1));
    expect(editor.selectedIndices()).toEqual([]);
    expect(historyButton('undo').props.disabled).toBe(true);
    expect(historyButton('redo').props.disabled).toBe(false);
    await editor.click(historyButton('redo')); await nextTick();
    expect(editor.state.modelValue).toBe(true);
    expect(editor.state.regions).toEqual(original);
    expect(historyButton('redo').props.disabled).toBe(true);
  });

  it('undoes a polygon vertex or live gesture before changing committed history', async () => {
    const undo = vi.fn(), redo = vi.fn();
    const editor = await mountEditor(async () => ({ valid: true }), undefined, undefined,
      { canUndo: false, canRedo: true, undo, redo });
    editor.choosePolygon(); await nextTick();
    editor.pointer('onPointerdown', -6, -6); editor.pointer('onPointerdown', 6, -6); editor.pointer('onPointerdown', 6, 6);
    editor.key('z', { ctrlKey: true }); await nextTick();
    editor.enter(); await nextTick();
    expect(editor.commits).toHaveLength(0); expect(undo).not.toHaveBeenCalled();
    editor.pointer('onPointerdown', 5, 5); editor.enter(); await nextTick();
    expect(editor.commits).toHaveLength(1);
    expect(editor.state.regions[editor.state.regions.length - 1]?.points).toEqual([[-6, -6], [6, -6], [5, 5]]);
    editor.chooseTool('rectangleTool'); await nextTick();
    editor.pointer('onPointerdown', -6, -6); editor.pointer('onPointermove', 5, 5);
    editor.key('z', { ctrlKey: true }); editor.pointer('onPointerup', 5, 5); await nextTick();
    expect(editor.commits).toHaveLength(1); expect(undo).not.toHaveBeenCalled();
  });
});

describe('automatic relief support validation', () => {
  it.each(['centerX', 'centerY', 'width', 'height'] as const)(
    'does not round a merged polygon or cancel support validation after repeating %s', async field => {
      const check = deferred();
      const region: ComponentReliefRegion = { id: 'merged', shape: 'polygon', x: .123456, y: .345678,
        width: 10.246912, height: 8.691356, depth: 3,
        points: [[-5, -4], [5.246912, -4], [5.246912, 4.691356], [-5, 4.691356]] };
      const before = JSON.stringify(region);
      const editor = await mountEditor(() => check.promise, [region]);
      editor.selectRegion(0); await nextTick();
      const pending = editor.click(editor.auto()); await nextTick();
      const label = all(editor.root).find(element => element.tag === 'label' && text(element).startsWith(`relief.${field}`))!;
      const input = all(label).find(element => element.tag === 'input')!;
      (input.props['onUpdate:modelValue'] as (value: number) => void)(input.props.modelValue as number);
      await nextTick();
      expect(editor.auto().props['aria-busy']).toBe(true);
      expect(editor.commits).toHaveLength(0);
      expect(editor.interactions).toEqual([]);
      expect(JSON.stringify(editor.state.regions[0])).toBe(before);
      check.resolve({ valid: true }); await pending; await nextTick();
      expect(editor.commits).toHaveLength(1);
      expect(JSON.stringify(editor.state.regions[0])).toBe(before);
    });

  it.each(['same', 'invalid', 'clamped', 'sameDepth', 'invalidDepth'] as const)(
    'keeps automatic support validation pending after a %s numeric non-edit', async action => {
      const check = deferred();
      const region: ComponentReliefRegion = { id: 'manual', shape: 'rect', x: 0, y: 0, width: 20, height: 3, depth: 3 };
      const editor = await mountEditor(() => check.promise, [region]);
      editor.selectRegion(0); await nextTick();
      const pending = editor.click(editor.auto()); await nextTick();
      if (action === 'sameDepth' || action === 'invalidDepth') editor.updateDepth(action === 'sameDepth' ? 3 : NaN);
      else {
        const label = all(editor.root).find(element => element.tag === 'label' && text(element).startsWith('relief.width'))!;
        const input = all(label).find(element => element.tag === 'input')!;
        (input.props['onUpdate:modelValue'] as (value: number) => void)(action === 'same' ? 20 : action === 'clamped' ? 50 : NaN);
      }
      await nextTick();
      expect(editor.auto().props['aria-busy']).toBe(true);
      expect(editor.commits).toHaveLength(0);
      expect(editor.interactions).toEqual([]);
      check.resolve({ valid: true }); await pending; await nextTick();
      expect(editor.commits).toHaveLength(1);
    });

  it.each(['Tab', 'Shift', 'ArrowRight', 'zoom', 'fit', 'pan'])('keeps automatic validation pending during non-editing %s', async action => {
    const check = deferred(), editor = await mountEditor(() => check.promise);
    const pending = editor.click(editor.auto()); await nextTick();
    if (action === 'zoom' || action === 'fit') {
      editor.click(all(editor.root).find(element => element.props['aria-label'] === 'relief.zoomIn')!);
      if (action === 'fit') editor.click(all(editor.root).find(element => element.tag === 'button' && text(element) === 'relief.fit')!);
    } else if (action === 'pan') {
      editor.pointer('onPointerdown', -8, -8, { button: 2 });
      editor.pointer('onPointermove', -4, -5, { button: 2 });
      editor.pointer('onPointerup', -4, -5, { button: 2 });
    } else editor.key(action);
    await nextTick();
    const view = editor.canvas().props.viewBox;
    expect(editor.auto().props['aria-busy']).toBe(true);
    check.resolve({ valid: true }); await pending; await nextTick();
    expect(editor.commits).toHaveLength(1);
    expect(editor.state.regions.map(region => region.id)).toEqual(['manual', 'automatic']);
    expect(editor.canvas().props.viewBox).toBe(view);
  });

  it('commits once only after validation succeeds, preserving existing manual regions', async () => {
    const check = deferred(), editor = await mountEditor(() => check.promise);
    const pending = editor.click(editor.auto());
    await nextTick();
    expect(editor.commits).toHaveLength(0);
    expect(editor.auto().props.disabled).toBe(true);
    check.resolve({ valid: true }); await pending; await nextTick();
    expect(editor.commits).toHaveLength(1);
    expect(editor.commits[0].map(region => region.id)).toEqual(['manual', 'automatic']);
    expect(editor.commits[0][0]).not.toHaveProperty('depth');
    expect(editor.commits[0][1].depth).toBe(3);
    expect(editor.auto().props.disabled).toBe(false);
  });

  it('changes only the selected region depth in one immutable, undoable interaction', async () => {
    const first: ComponentReliefRegion = { id: 'one', shape: 'rect', x: -3, y: -3, width: 3, height: 3, depth: 2 };
    const second: ComponentReliefRegion = { id: 'two', shape: 'circle', x: 3, y: 3, width: 3, height: 3, depth: 6 };
    const editor = await mountEditor(async () => ({ valid: true }), [first, second]);
    editor.selectRegion(0); await nextTick();
    expect(editor.depthInput().props.modelValue).toBe(2);
    editor.updateDepth(4.5); await nextTick();
    expect(editor.commits).toHaveLength(1);
    expect(editor.state.regions.map(region => region.depth)).toEqual([4.5, 6]);
    expect(first.depth).toBe(2);
    expect(editor.interactions).toEqual(['start', 'end']);
    editor.state.depth = 9; await nextTick();
    editor.selectRegion(0); await nextTick();
    expect(editor.depthInput().props.modelValue).toBe(4.5);
    editor.updateDepth(0); editor.updateDepth(21); editor.updateDepth(NaN); await nextTick();
    expect(editor.commits).toHaveLength(1);
  });

  it('shows the effective legacy depth and stores an explicit value after a selected edit', async () => {
    const editor = await mountEditor(async () => ({ valid: true }));
    editor.selectRegion(0); await nextTick();
    expect(editor.depthInput().props.modelValue).toBe(3);
    editor.updateDepth(5); await nextTick();
    expect(editor.state.regions[0].depth).toBe(5);
    expect(editor.commits).toHaveLength(1);
  });

  it.each(['rectangleTool', 'circleTool', 'polygonTool'] as const)('creates %s using the new-region default depth', async label => {
    const editor = await mountEditor(async () => ({ valid: true }), []);
    editor.state.depth = 7.5; await nextTick();
    editor.chooseTool(label); await nextTick();
    editor.pointer('onPointerdown', -8, -8);
    if (label === 'polygonTool') {
      editor.pointer('onPointerdown', -2, -8);
      editor.pointer('onPointerdown', -2, -2);
      await nextTick();
      editor.enter();
    } else editor.pointer('onPointerup', -2, -2);
    await nextTick();
    expect(editor.commits).toHaveLength(1);
    expect(editor.state.regions[0].depth).toBe(7.5);
    expect(editor.interactions).toEqual(['start', 'end']);
    editor.state.depth = 10; await nextTick();
    expect(editor.state.regions[0].depth).toBe(7.5);
  });

  it('materializes automatic depth before support validation and preserves explicit existing depths', async () => {
    const validate = vi.fn(async (_regions: ComponentReliefRegion[]) => ({ valid: true }));
    const old: ComponentReliefRegion = { id: 'manual', shape: 'rect', x: -3, y: -3, width: 3, height: 3, depth: 2 };
    const editor = await mountEditor(validate, [old]);
    editor.state.depth = 8; await nextTick();
    await editor.click(editor.auto()); await nextTick();
    expect(validate.mock.calls[0][0].map(region => region.depth)).toEqual([2, 8]);
    expect(editor.state.regions.map(region => region.depth)).toEqual([2, 8]);
    expect(old.depth).toBe(2);
  });

  it('keeps a manual region-depth edit when an older automatic validation finishes', async () => {
    const check = deferred(), editor = await mountEditor(() => check.promise);
    editor.selectRegion(0); await nextTick();
    const pending = editor.click(editor.auto());
    editor.updateDepth(6); await nextTick();
    check.resolve({ valid: true }); await pending; await nextTick();
    expect(editor.commits).toHaveLength(1);
    expect(editor.state.regions).toHaveLength(1);
    expect(editor.state.regions[0]).toMatchObject({ id: 'manual', depth: 6 });
  });

  it.each(['invalid', 'error'] as const)('keeps all previous regions when validation is %s', async outcome => {
    const check = deferred(), editor = await mountEditor(() => check.promise);
    const pending = editor.click(editor.auto());
    if (outcome === 'error') check.reject(new Error('engine unavailable')); else check.resolve({ valid: false });
    await pending; await nextTick();
    expect(editor.commits).toHaveLength(0);
    expect(editor.state.regions.map(region => region.id)).toEqual(['manual']);
    expect(text(editor.root)).toContain(outcome === 'error' ? 'relief.autoFailed' : 'relief.autoSupportWarning');
  });

  it('ignores an old result after manual editing without clearing a newer request busy state', async () => {
    const first = deferred(), second = deferred();
    const validate = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const editor = await mountEditor(validate);
    const old = editor.click(editor.auto());
    editor.choosePolygon(); await nextTick();
    expect(editor.auto().props.disabled).toBe(false);
    const latest = editor.click(editor.auto()); await nextTick();
    first.resolve({ valid: true }); await old; await nextTick();
    expect(editor.commits).toHaveLength(0);
    expect(editor.auto().props.disabled).toBe(true);
    second.resolve({ valid: true }); await latest; await nextTick();
    expect(editor.commits).toHaveLength(1);
    expect(editor.auto().props.disabled).toBe(false);
  });

  it.each(['close', 'side', 'depth', 'regions', 'unmount'] as const)('discards a pending result after %s', async action => {
    const check = deferred(), editor = await mountEditor(() => check.promise);
    const pending = editor.click(editor.auto());
    if (action === 'close') editor.state.modelValue = false;
    else if (action === 'side') editor.state.printSide = 'bottom';
    else if (action === 'depth') editor.state.depth = 8;
    else if (action === 'regions') editor.state.regions = [{ id: 'new-manual', shape: 'rect', x: 0, y: 0, width: 2, height: 2 }];
    else editor.unmount();
    await nextTick(); check.resolve({ valid: true }); await pending; await nextTick();
    expect(editor.commits).toHaveLength(0);
    if (action === 'regions') expect(editor.state.regions[0].id).toBe('new-manual');
  });
});

const mergeInputs = (): ComponentReliefRegion[] => [
  { id: 'left', shape: 'polygon', x: -2, y: 0, width: 4, height: 4, depth: 2,
    points: [[-4, -2], [0, -2], [0, 2], [-4, 2]] },
  { id: 'right', shape: 'rect', x: 2, y: 0, width: 4, height: 4, depth: 2 },
  { id: 'deep', shape: 'circle', x: 0, y: 7, width: 2, height: 2, depth: 6 },
];
const mergeResult = (): ComponentReliefMergeResult => ({ valid: true, merged: 1, skipped: 0, regions: [
  { id: 'left', shape: 'rect', x: 0, y: 0, width: 8, height: 4, depth: 2 }, mergeInputs()[2],
] });

describe('relief selection interactions', () => {
  it('resizes grips with the actual canvas and disconnects its observer on teardown', async () => {
    let notify!: (entries: Array<{ target: unknown; contentRect: { width: number; height: number } }>) => void;
    let observed: unknown;
    const disconnect = vi.fn();
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: typeof notify) { notify = callback; }
      observe(target: unknown) { observed = target; }
      disconnect = disconnect;
    });
    const editor = await mountEditor(async () => ({ valid: true }));
    editor.selectRegion(0); await nextTick();
    const grip = () => all(editor.root).find(element => element.tag === 'rect' && String(element.props.class).includes('resize-handle'))!;
    const before = Number(grip().props.width);
    expect(observed).toBe(editor.canvas());
    notify([{ target: observed, contentRect: { width: 1200, height: 200 } }]); await nextTick();
    expect(Number(grip().props.width)).toBeCloseTo(before * 2);
    const after = Number(grip().props.width);
    notify([{ target: observed, contentRect: { width: 0, height: 0 } }]); await nextTick();
    expect(Number(grip().props.width)).toBe(after);
    editor.unmount();
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it('requires at least two selected regions before invoking merge', async () => {
    const merge = vi.fn(async (regions: ComponentReliefRegion[]) => ({ valid: true, regions, merged: 0, skipped: 0 }));
    const editor = await mountEditor(async () => ({ valid: true }), mergeInputs(), merge);
    expect(editor.merge().props.disabled).toBe(true);
    await editor.click(editor.merge());
    editor.selectRegion(0); await nextTick();
    expect(editor.merge().props.disabled).toBe(true);
    await editor.click(editor.merge());
    expect(merge).not.toHaveBeenCalled();
    editor.selectAll(); await nextTick();
    expect(editor.merge().props.disabled).toBe(false);
    await editor.click(editor.merge());
    expect(merge).toHaveBeenCalledOnce();
  });

  it.each(['top', 'bottom'] as const)('box-selects only touched regions on the %s side and merges that subset', async side => {
    const merge = vi.fn(async (_regions: ComponentReliefRegion[], _gap: number, _ids: string[]) => mergeResult());
    const editor = await mountEditor(async () => ({ valid: true }), mergeInputs(), merge);
    editor.state.printSide = side; await nextTick();
    editor.pointer('onPointerdown', -6, -3);
    editor.pointer('onPointermove', 6, 3); await nextTick();
    expect(editor.selectedIndices()).toEqual([0, 1]);
    expect(all(editor.root).some(element => element.props.class === 'marquee-selection')).toBe(true);
    expect(editor.interactions).toEqual([]);
    editor.pointer('onPointerup', 6, 3); await nextTick();
    expect(editor.selectedIndices()).toEqual([0, 1]);
    expect(all(editor.root).some(element => element.props.class === 'marquee-selection')).toBe(false);
    expect(editor.commits).toHaveLength(0);
    expect(editor.depthInput().props.modelValue).toBe(2);
    expect(editor.cutMode('through').props['aria-pressed']).toBe(false);
    await editor.click(editor.merge()); await nextTick();
    expect(merge.mock.calls[0][0].map(region => region.id)).toEqual(['left', 'right', 'deep']);
    expect(merge.mock.calls[0][2]).toEqual(['left', 'right']);
    expect(editor.state.regions[1]).toEqual(mergeInputs()[2]);
    expect(editor.selectedIndices()).toEqual([0]);
    expect(editor.interactions).toEqual(['start', 'end']);
  });

  it('adds a marquee to an existing selection and toggles listed regions with Shift or Ctrl', async () => {
    const editor = await mountEditor(async () => ({ valid: true }), mergeInputs());
    editor.selectRegion(2); await nextTick();
    editor.pointer('onPointerdown', 6, 3, { shiftKey: true });
    editor.pointer('onPointermove', -6, -3, { shiftKey: true });
    editor.pointer('onPointerup', -6, -3, { shiftKey: true }); await nextTick();
    expect(editor.selectedIndices()).toEqual([0, 1, 2]);
    editor.selectRegion(0, { shiftKey: true }); await nextTick();
    expect(editor.selectedIndices()).toEqual([1, 2]);
    editor.selectRegion(1, { ctrlKey: true }); await nextTick();
    expect(editor.selectedIndices()).toEqual([2]);
    editor.clearSelection(); await nextTick();
    expect(editor.selectedIndices()).toEqual([]);
    expect(editor.commits).toHaveLength(0);
    expect(editor.interactions).toEqual([]);
  });

  it.each(['pointercancel', 'lostpointercapture', 'escape'] as const)('restores the previous selection when a marquee ends with %s', async action => {
    const editor = await mountEditor(async () => ({ valid: true }), mergeInputs());
    editor.selectRegion(2); await nextTick();
    editor.pointer('onPointerdown', -6, -3);
    editor.pointer('onPointermove', 6, 3); await nextTick();
    expect(editor.selectedIndices()).toEqual([0, 1]);
    if (action === 'escape') editor.key('Escape');
    else editor.pointer(action === 'pointercancel' ? 'onPointercancel' : 'onLostpointercapture', 6, 3);
    await nextTick();
    expect(editor.selectedIndices()).toEqual([2]);
    expect(editor.interactions).toEqual([]);
    expect(editor.commits).toHaveLength(0);
  });

  it('keeps selection and history unchanged during right-button panning', async () => {
    const editor = await mountEditor(async () => ({ valid: true }), mergeInputs());
    editor.selectRegion(2); await nextTick();
    const before = editor.canvas().props.viewBox;
    editor.pointer('onPointerdown', -8, -8, { button: 2 });
    editor.pointer('onPointermove', -4, -5, { button: 2 });
    editor.pointer('onPointerup', -4, -5, { button: 2 }); await nextTick();
    expect(editor.canvas().props.viewBox).not.toBe(before);
    expect(editor.selectedIndices()).toEqual([2]);
    expect(editor.interactions).toEqual([]);
    expect(editor.commits).toHaveLength(0);
  });

  it('selects all with Ctrl+A on the canvas and deletes the selection in one undoable change', async () => {
    const editor = await mountEditor(async () => ({ valid: true }), mergeInputs());
    editor.key('a', { ctrlKey: true, target: editor.numericInput('defaultDepth') }); await nextTick();
    expect(editor.selectedIndices()).toEqual([]);
    editor.key('a', { ctrlKey: true }); await nextTick();
    expect(editor.selectedIndices()).toEqual([0, 1, 2]);
    editor.key('Delete'); await nextTick();
    expect(editor.state.regions).toEqual([]);
    expect(editor.selectedIndices()).toEqual([]);
    expect(editor.commits).toHaveLength(1);
    expect(editor.interactions).toEqual(['start', 'end']);
  });

  it('deletes only the selected subset with the toolbar action', async () => {
    const editor = await mountEditor(async () => ({ valid: true }), mergeInputs());
    editor.selectRegion(0); await nextTick();
    editor.selectRegion(1, { shiftKey: true }); await nextTick();
    const remove = all(editor.root).find(element => element.props.class === 'delete-region')!;
    editor.click(remove); await nextTick();
    expect(editor.state.regions.map(region => region.id)).toEqual(['deep']);
    expect(editor.commits).toHaveLength(1);
    expect(editor.interactions).toEqual(['start', 'end']);
  });

  it('still moves a single selected region with a left-button drag', async () => {
    const editor = await mountEditor(async () => ({ valid: true }), mergeInputs());
    const target = all(editor.root).find(element => element.tag === 'g' && element.props['data-relief-id'] === 'left')!;
    editor.pointer('onPointerdown', -2, 0, { target });
    editor.pointer('onPointermove', -1, 0, { target });
    editor.pointer('onPointerup', -1, 0, { target }); await nextTick();
    expect(editor.state.regions[0]).toMatchObject({ id: 'left', x: -1, y: 0 });
    expect(editor.state.regions[0].points![0]).toEqual([-3, -2]);
    expect(editor.selectedIndices()).toEqual([0]);
    expect(editor.interactions).toEqual(['start', 'end']);
  });

  it.each(['clear', 'single', 'marquee'] as const)('drops an outstanding selected merge after the selection changes via %s', async action => {
    const check = deferred<ComponentReliefMergeResult>();
    const merge = vi.fn(() => check.promise);
    const editor = await mountEditor(async () => ({ valid: true }), mergeInputs(), merge);
    editor.selectAll(); await nextTick();
    const pending = editor.click(editor.merge());
    expect(merge).toHaveBeenCalledOnce();
    if (action === 'clear') editor.clearSelection();
    else if (action === 'single') editor.selectRegion(2);
    else {
      editor.pointer('onPointerdown', -6, -3);
      editor.pointer('onPointermove', 6, 3);
      editor.pointer('onPointerup', 6, 3);
    }
    await nextTick();
    check.resolve(mergeResult()); await pending; await nextTick();
    expect(editor.state.regions).toEqual(mergeInputs());
    expect(editor.commits).toHaveLength(0);
    expect(editor.interactions).toEqual([]);
  });
});

describe('relief selected batch properties', () => {
  const pockets = (): ComponentReliefRegion[] => [
    { id: 'first', shape: 'rect', x: -5, y: 0, width: 3, height: 3, depth: 2 },
    { id: 'second', shape: 'circle', x: 0, y: 0, width: 3, height: 3, depth: 4 },
    { id: 'untouched', shape: 'rect', x: 5, y: 0, width: 3, height: 3, depth: 6 },
  ];
  const selectPair = async (editor: Awaited<ReturnType<typeof mountEditor>>) => {
    editor.selectRegion(0); await nextTick();
    editor.selectRegion(1, { shiftKey: true }); await nextTick();
  };

  it('shows mixed depths and applies one undoable change to the selected subset', async () => {
    const editor = await mountEditor(async () => ({ valid: true }), pockets());
    const untouched = editor.state.regions[2];
    await selectPair(editor);
    expect(editor.depthInput().props.modelValue).toBeUndefined();
    expect(editor.depthInput().props.placeholder).toBe('relief.mixedValues');
    expect(editor.cutMode('blind').props['aria-pressed']).toBe(true);
    expect(text(editor.root)).toContain('relief.batchProperties');
    expect(text(editor.root)).not.toContain('relief.centerX');
    editor.updateDepth(5.5); await nextTick();
    expect(editor.state.regions.map(region => region.depth)).toEqual([5.5, 5.5, 6]);
    expect(editor.state.regions[2]).toBe(untouched);
    expect(editor.selectedIndices()).toEqual([0, 1]);
    expect(editor.depthInput().props.modelValue).toBe(5.5);
    expect(editor.commits).toHaveLength(1);
    expect(editor.interactions).toEqual(['start', 'end']);
    editor.updateDepth(5.5); await nextTick();
    expect(editor.commits).toHaveLength(1);
  });

  it('switches the selected subset through and back without losing individual pocket depths', async () => {
    const editor = await mountEditor(async () => ({ valid: true }), pockets());
    await selectPair(editor);
    editor.click(editor.cutMode('through')); await nextTick();
    expect(editor.state.regions.map(region => Boolean(region.through))).toEqual([true, true, false]);
    expect(editor.state.regions.map(region => region.depth)).toEqual([2, 4, 6]);
    expect(editor.depthInput()).toBeUndefined();
    expect(editor.cutMode('through').props['aria-pressed']).toBe(true);
    expect(editor.commits).toHaveLength(1);
    editor.click(editor.cutMode('through')); await nextTick();
    expect(editor.commits).toHaveLength(1);
    editor.click(editor.cutMode('blind')); await nextTick();
    expect(editor.state.regions.map(region => Boolean(region.through))).toEqual([false, false, false]);
    expect(editor.state.regions.map(region => region.depth)).toEqual([2, 4, 6]);
    expect(editor.depthInput().props.placeholder).toBe('relief.mixedValues');
    expect(editor.selectedIndices()).toEqual([0, 1]);
    expect(editor.commits).toHaveLength(2);
    expect(editor.interactions).toEqual(['start', 'end', 'start', 'end']);
  });

  it.each(['blind', 'through'] as const)('represents mixed modes until they are unified as %s', async mode => {
    const regions = pockets(); regions[1].through = true;
    const editor = await mountEditor(async () => ({ valid: true }), regions);
    const alreadyMatching = editor.state.regions[mode === 'blind' ? 0 : 1];
    await selectPair(editor);
    expect(editor.cutMode('blind').props['aria-pressed']).toBe(false);
    expect(editor.cutMode('through').props['aria-pressed']).toBe(false);
    expect(editor.depthInput()).toBeUndefined();
    expect(text(editor.root)).toContain('relief.mixedCutMode');
    editor.click(editor.cutMode(mode)); await nextTick();
    expect(editor.state.regions.slice(0, 2).map(region => Boolean(region.through)))
      .toEqual([mode === 'through', mode === 'through']);
    expect(editor.state.regions[mode === 'blind' ? 0 : 1]).toBe(alreadyMatching);
    expect(editor.state.regions.map(region => region.depth)).toEqual([2, 4, 6]);
    expect(editor.selectedIndices()).toEqual([0, 1]);
    expect(editor.commits).toHaveLength(1);
  });

  it('materializes legacy depths per region when a batch becomes through', async () => {
    const regions = pockets(); delete regions[0].depth;
    const editor = await mountEditor(async () => ({ valid: true }), regions);
    await selectPair(editor);
    editor.click(editor.cutMode('through')); await nextTick();
    expect(editor.state.regions.map(region => region.depth)).toEqual([3, 4, 6]);
    editor.state.depth = 7; await nextTick();
    editor.click(editor.cutMode('blind')); await nextTick();
    expect(editor.state.regions.map(region => region.depth)).toEqual([3, 4, 6]);
  });

  it.each(['depth', 'through'] as const)('discards a pending merge after a batch %s edit', async action => {
    const check = deferred<ComponentReliefMergeResult>();
    const editor = await mountEditor(async () => ({ valid: true }), pockets(), () => check.promise);
    await selectPair(editor);
    const pending = editor.click(editor.merge()); await nextTick();
    if (action === 'depth') editor.updateDepth(5);
    else editor.click(editor.cutMode('through'));
    await nextTick();
    check.resolve(mergeResult()); await pending; await nextTick();
    expect(editor.state.regions.map(region => region.id)).toEqual(['first', 'second', 'untouched']);
    expect(editor.state.regions.slice(0, 2).map(region => action === 'depth' ? region.depth : region.through))
      .toEqual(action === 'depth' ? [5, 5] : [true, true]);
    expect(editor.commits).toHaveLength(1);
    expect(editor.selectedIndices()).toEqual([0, 1]);
  });

  it.each(['depth', 'through'] as const)('discards pending automatic generation after a batch %s edit', async action => {
    const check = deferred();
    const editor = await mountEditor(() => check.promise, pockets());
    await selectPair(editor);
    const pending = editor.click(editor.auto()); await nextTick();
    if (action === 'depth') editor.updateDepth(5);
    else editor.click(editor.cutMode('through'));
    await nextTick();
    check.resolve({ valid: true }); await pending; await nextTick();
    expect(editor.state.regions.map(region => region.id)).toEqual(['first', 'second', 'untouched']);
    expect(editor.state.regions.slice(0, 2).map(region => action === 'depth' ? region.depth : region.through))
      .toEqual(action === 'depth' ? [5, 5] : [true, true]);
    expect(editor.commits).toHaveLength(1);
    expect(editor.selectedIndices()).toEqual([0, 1]);
  });

  it('keeps an automatic check pending when all selected pockets emit their existing depth', async () => {
    const check = deferred();
    const regions = pockets(); regions[1].depth = 2;
    const editor = await mountEditor(() => check.promise, regions);
    await selectPair(editor);
    const pending = editor.click(editor.auto()); await nextTick();
    editor.updateDepth(2); await nextTick();
    expect(editor.commits).toHaveLength(0);
    expect(editor.auto().props['aria-busy']).toBe(true);
    check.resolve({ valid: true }); await pending; await nextTick();
    expect(editor.commits).toHaveLength(1);
  });

  it('ignores invalid batch depths and delayed depth input after switching to through', async () => {
    const editor = await mountEditor(async () => ({ valid: true }), pockets());
    await selectPair(editor);
    const oldHandler = editor.depthInput().props['onUpdate:modelValue'] as (value: number) => void;
    for (const value of [0, 21, NaN]) oldHandler(value);
    await nextTick();
    expect(editor.commits).toHaveLength(0);
    editor.click(editor.cutMode('through')); await nextTick();
    oldHandler(5); await nextTick();
    expect(editor.state.regions.map(region => region.depth)).toEqual([2, 4, 6]);
    expect(editor.commits).toHaveLength(1);
  });
});

describe('relief creation defaults inside the editor', () => {
  it('emits the new default while preserving selected pocket depth and the zoomed view', async () => {
    const editor = await mountEditor(async () => ({ valid: true }));
    editor.selectRegion(0); await nextTick();
    editor.click(all(editor.root).find(element => element.props['aria-label'] === 'relief.zoomIn')!); await nextTick();
    const view = editor.canvas().props.viewBox;
    editor.updateInput('defaultDepth', 7.5); await nextTick();
    expect(editor.depthUpdates).toEqual([7.5]);
    expect(editor.state.depth).toBe(7.5);
    expect(editor.depthInput().props.modelValue).toBe(3);
    expect(editor.selectedIndices()).toEqual([0]);
    expect(editor.canvas().props.viewBox).toBe(view);
    expect(editor.state.regions[0].depth).toBe(3);
    expect(editor.interactions).toEqual(['start', 'end']);
    editor.updateInput('defaultDepth', NaN); editor.updateInput('defaultDepth', 0); editor.updateInput('defaultDepth', 21);
    editor.updateInput('defaultDepth', 7.5); await nextTick();
    expect(editor.depthUpdates).toEqual([7.5]);
  });

  it.each(['rectangleTool', 'circleTool', 'polygonTool'] as const)('uses the edited default for the next %s without altering existing regions', async label => {
    const editor = await mountEditor(async () => ({ valid: true }));
    editor.updateInput('defaultDepth', 6); await nextTick();
    editor.chooseTool(label); await nextTick();
    editor.pointer('onPointerdown', 1, 1);
    if (label === 'polygonTool') {
      editor.pointer('onPointerdown', 5, 1); editor.pointer('onPointerdown', 5, 5); editor.enter();
    } else editor.pointer('onPointerup', 5, 5);
    await nextTick();
    expect(editor.state.regions.map(region => region.depth)).toEqual([3, 6]);
    expect(editor.depthUpdates).toEqual([6]);
    expect(editor.commits).toHaveLength(1);
    expect(editor.interactions).toEqual(['start', 'end', 'start', 'end']);
  });
});

describe('relief region merging', () => {
  it.each(['Tab', 'ArrowRight', 'zoom', 'fit', 'pan'])('keeps a merge result and current view after non-editing %s', async action => {
    const check = deferred<ComponentReliefMergeResult>();
    const editor = await mountEditor(async () => ({ valid: true }), mergeInputs(), () => check.promise);
    editor.selectAll(); await nextTick();
    const pending = editor.click(editor.merge()); await nextTick();
    if (action === 'zoom' || action === 'fit') {
      editor.click(all(editor.root).find(element => element.props['aria-label'] === 'relief.zoomIn')!);
      if (action === 'fit') editor.click(all(editor.root).find(element => element.tag === 'button' && text(element) === 'relief.fit')!);
    } else if (action === 'pan') {
      editor.pointer('onPointerdown', -8, -8, { button: 2 });
      editor.pointer('onPointermove', -4, -5, { button: 2 });
      editor.pointer('onPointerup', -4, -5, { button: 2 });
    } else editor.key(action);
    await nextTick();
    const view = editor.canvas().props.viewBox;
    expect(editor.merge().props['aria-busy']).toBe(true);
    check.resolve(mergeResult()); await pending; await nextTick();
    expect(editor.commits).toHaveLength(1);
    expect(editor.state.regions).toEqual(mergeResult().regions);
    expect(editor.canvas().props.viewBox).toBe(view);
  });

  it('merges the selected areas without a connection width and commits once with independent depths intact', async () => {
    const check = deferred<ComponentReliefMergeResult>();
    const validate = vi.fn(async () => ({ valid: true }));
    const merge = vi.fn((_regions: ComponentReliefRegion[], _gap: number, _selectedIds: string[]) => check.promise);
    const editor = await mountEditor(validate, mergeInputs(), merge);
    editor.selectAll(); await nextTick();
    expect(all(editor.root).some(element => element.props['aria-label'] === 'relief.mergeGap')).toBe(false);
    const pending = editor.click(editor.merge()); await nextTick();
    expect(merge).toHaveBeenCalledOnce();
    expect(merge.mock.calls[0][1]).toBe(0);
    expect(merge.mock.calls[0][2]).toEqual(['left', 'right', 'deep']);
    merge.mock.calls[0][0][0].points![0][0] = 99;
    expect(editor.state.regions[0].points![0][0]).toBe(-4);
    expect(editor.commits).toHaveLength(0);
    expect(editor.auto().props.disabled).toBe(true);
    check.resolve(mergeResult()); await pending; await nextTick();
    expect(validate).not.toHaveBeenCalled();
    expect(editor.commits).toHaveLength(1);
    expect(editor.state.regions.map(region => region.depth)).toEqual([2, 6]);
    expect(editor.state.regions[0]).toMatchObject({ shape: 'rect', x: 0, y: 0, width: 8, height: 4 });
    expect(editor.interactions).toEqual(['start', 'end']);
    expect(text(editor.root)).toContain('relief.mergeDone');
    expect(editor.merge().props.disabled).toBe(false);
  });

  it.each(['invalid', 'error', 'unchanged'] as const)('preserves all input regions after %s', async outcome => {
    const check = deferred<ComponentReliefMergeResult>();
    const editor = await mountEditor(async () => ({ valid: true }), mergeInputs(), () => check.promise);
    editor.selectAll(); await nextTick();
    const before = JSON.stringify(editor.state.regions);
    const pending = editor.click(editor.merge());
    if (outcome === 'error') check.reject(new Error('worker stopped'));
    else check.resolve({ valid: outcome !== 'invalid', regions: [], merged: 0, skipped: outcome === 'unchanged' ? 2 : 0 });
    await pending; await nextTick();
    expect(editor.commits).toHaveLength(0);
    expect(JSON.stringify(editor.state.regions)).toBe(before);
    expect(text(editor.root)).toContain(outcome === 'invalid' ? 'relief.mergeInvalid'
      : outcome === 'error' ? 'relief.mergeError' : 'relief.mergeUnchanged');
    if (outcome === 'unchanged') expect(text(editor.root)).toContain('relief.mergeSkipped');
  });

  it.each(['close', 'side', 'allowance', 'regions', 'tool', 'manual', 'unmount'] as const)(
    'discards the old merge result after %s', async action => {
      const check = deferred<ComponentReliefMergeResult>();
      const editor = await mountEditor(async () => ({ valid: true }), mergeInputs(), () => check.promise);
      editor.selectAll(); await nextTick();
      const pending = editor.click(editor.merge());
      if (action === 'close') editor.state.modelValue = false;
      else if (action === 'side') editor.state.printSide = 'bottom';
      else if (action === 'allowance') editor.updateInput('allowance', 2);
      else if (action === 'regions') editor.state.regions = [mergeInputs()[2]];
      else if (action === 'tool') editor.choosePolygon();
      else if (action === 'manual') { editor.selectRegion(0); await nextTick(); editor.updateDepth(4); }
      else editor.unmount();
      await nextTick(); check.resolve(mergeResult()); await pending; await nextTick();
      expect(editor.commits).toHaveLength(action === 'manual' ? 1 : 0);
      if (action === 'manual') expect(editor.state.regions[0].depth).toBe(4);
      if (action === 'regions') expect(editor.state.regions.map(region => region.id)).toEqual(['deep']);
    });

  it('keeps requests mutually exclusive and an old response cannot clear the newer spinner', async () => {
    const first = deferred<ComponentReliefMergeResult>(), second = deferred<ComponentReliefMergeResult>();
    const merge = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const validate = vi.fn(async () => ({ valid: true }));
    const editor = await mountEditor(validate, mergeInputs(), merge);
    editor.selectAll(); await nextTick();
    const old = editor.click(editor.merge()); await nextTick();
    await editor.click(editor.auto());
    await editor.click(editor.merge());
    expect(validate).not.toHaveBeenCalled();
    expect(merge).toHaveBeenCalledOnce();
    editor.updateInput('allowance', 2); await nextTick();
    const current = editor.click(editor.merge()); await nextTick();
    first.resolve(mergeResult()); await old; await nextTick();
    expect(editor.commits).toHaveLength(0);
    expect(editor.merge().props['aria-busy']).toBe(true);
    second.resolve(mergeResult()); await current; await nextTick();
    expect(editor.commits).toHaveLength(1);
    expect(editor.merge().props['aria-busy']).toBe(false);
  });
});

describe('relief region cut modes', () => {
  it('switches only the selected region with one undoable commit and retains its blind depth', async () => {
    const original = mergeInputs();
    const editor = await mountEditor(async () => ({ valid: true }), original);
    editor.selectRegion(0); await nextTick();
    expect(editor.cutMode('blind').props['aria-pressed']).toBe(true);
    editor.click(editor.cutMode('through')); await nextTick();
    expect(editor.commits).toHaveLength(1);
    expect(editor.interactions).toEqual(['start', 'end']);
    expect(editor.state.regions[0]).toMatchObject({ through: true, depth: 2 });
    expect(editor.state.regions.slice(1)).toEqual(original.slice(1));
    expect(original[0]).not.toHaveProperty('through');
    expect(editor.depthInput()).toBeUndefined();
    expect(text(editor.root)).toContain('relief.throughHint');
    expect(all(editor.root).find(element => element.props['data-relief-id'] === original[0].id
      && element.tag === 'g')?.props.class).toContain('through');
    editor.click(editor.cutMode('through')); await nextTick();
    expect(editor.commits).toHaveLength(1);
    editor.click(editor.cutMode('blind')); await nextTick();
    expect(editor.commits).toHaveLength(2);
    expect(editor.interactions).toEqual(['start', 'end', 'start', 'end']);
    expect(editor.state.regions[0]).toMatchObject({ through: false, depth: 2 });
    expect(editor.depthInput().props.modelValue).toBe(2);
    expect(editor.state.regions.map(region => region.depth)).toEqual([2, 2, 6]);
    editor.state.regions[0].points![0][0] = 99;
    expect(original[0].points![0][0]).toBe(-4);
  });

  it('remembers a legacy region depth even if the new-region default changes while it is through', async () => {
    const editor = await mountEditor(async () => ({ valid: true }));
    editor.selectRegion(0); await nextTick();
    editor.click(editor.cutMode('through')); await nextTick();
    expect(editor.state.regions[0]).toMatchObject({ through: true, depth: 3 });
    editor.state.depth = 9; await nextTick();
    editor.selectRegion(0); await nextTick();
    editor.click(editor.cutMode('blind')); await nextTick();
    expect(editor.depthInput().props.modelValue).toBe(3);
    expect(editor.state.regions[0]).toMatchObject({ through: false, depth: 3 });
  });

  it('rejects a stale depth-input event after switching to through', async () => {
    const editor = await mountEditor(async () => ({ valid: true }));
    editor.selectRegion(0); await nextTick();
    const oldDepthHandler = editor.depthInput().props['onUpdate:modelValue'] as (value: number) => void;
    editor.click(editor.cutMode('through')); await nextTick();
    oldDepthHandler(12); await nextTick();
    expect(editor.commits).toHaveLength(1);
    expect(editor.state.regions[0]).toMatchObject({ through: true, depth: 3 });
  });

  it.each(['auto', 'merge'] as const)('ignores a pending %s result after a cut-mode edit', async action => {
    const check = deferred(), merged = deferred<ComponentReliefMergeResult>();
    const editor = await mountEditor(() => check.promise, mergeInputs(), () => merged.promise);
    if (action === 'merge') editor.selectAll(); else editor.selectRegion(0);
    await nextTick();
    const pending = editor.click(action === 'auto' ? editor.auto() : editor.merge());
    if (action === 'merge') { editor.selectRegion(0); await nextTick(); }
    editor.click(editor.cutMode('through')); await nextTick();
    check.resolve({ valid: true }); merged.resolve(mergeResult());
    await pending; await nextTick();
    expect(editor.commits).toHaveLength(1);
    expect(editor.interactions).toEqual(['start', 'end']);
    expect(editor.state.regions).toHaveLength(3);
    expect(editor.state.regions[0]).toMatchObject({ through: true, depth: 2 });
  });

  it('preserves through flags and the retained depth in merge requests and responses', async () => {
    const initial = mergeInputs().map((region, index) => index < 2 ? { ...region, through: true } : region);
    const result = mergeResult();
    result.regions[0].through = true;
    const merge = vi.fn(async (_regions: ComponentReliefRegion[]) => result);
    const editor = await mountEditor(async () => ({ valid: true }), initial, merge);
    editor.selectAll(); await nextTick();
    await editor.click(editor.merge()); await nextTick();
    expect(merge.mock.calls[0][0].map(region => region.through)).toEqual([true, true, undefined]);
    expect(editor.state.regions[0]).toMatchObject({ through: true, depth: 2 });
    expect(editor.commits).toHaveLength(1);
    result.regions[0].x = 99;
    expect(editor.state.regions[0].x).toBe(0);
    editor.selectRegion(0); await nextTick();
    expect(editor.cutMode('through').props['aria-pressed']).toBe(true);
    expect(editor.depthInput()).toBeUndefined();
  });
});
