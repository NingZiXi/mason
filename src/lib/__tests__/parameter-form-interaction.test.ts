import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as Vue from 'vue';
import { createRenderer, defineComponent, h, markRaw, nextTick, ref, type Component } from 'vue';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import { readFileSync } from 'node:fs';
import { compileScript, parse } from '@vue/compiler-sfc';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import * as config from '../../stores/config';
import * as focusParameter from '../focus-parameter-control';
import * as ejectHole from '../eject-hole';
import * as componentRelief from '../component-relief';
import { useConfigStore, type AppMode } from '../../stores/config';

// Compile actual browser templates rather than Vitest's SSR-only SFC output.
const empty = defineComponent({ render: () => null });
const passSlots = defineComponent({ setup: (_props, { slots }) => () => h('section', [slots.default?.(), slots.trailing?.(), slots.control?.()]) });
function loadForm(name: 'ConfigForm' | 'StencilForm'): Component {
  const source = readFileSync(new URL(`../../components/${name}.vue`, import.meta.url), 'utf8');
  const script = compileScript(parse(source).descriptor, { id: name, inlineTemplate: true });
  const javascript = transpileModule(script.content, { compilerOptions: {
    module: ModuleKind.CommonJS, target: ScriptTarget.ES2022,
  } }).outputText;
  const compiled = { exports: {} as { default: Component } };
  const resolveImport = (dependency: string): unknown => {
    if (dependency === 'vue') return Vue;
    if (dependency === 'element-plus') return { ElSwitch: empty };
    if (dependency === 'vue-i18n') return { useI18n: () => ({ t: (key: string) => key }) };
    if (dependency.endsWith('/stores/config')) return config;
    if (dependency.endsWith('/lib/focus-parameter-control')) return focusParameter;
    if (dependency.endsWith('/lib/eject-hole')) return ejectHole;
    if (dependency.endsWith('/lib/component-relief')) return componentRelief;
    if (dependency.endsWith('/directives/app-tooltip')) return { vAppTooltip: {} };
    if (dependency.endsWith('.vue')) return { __esModule: true, default:
      /\/(MotionCollapse|InlineHelp)\.vue$/.test(dependency) ? passSlots : empty };
    throw new Error(`Unexpected dependency: ${dependency}`);
  };
  new Function('require', 'exports', 'module', javascript)(resolveImport, compiled.exports, compiled);
  return compiled.exports.default;
}
const ConfigForm = loadForm('ConfigForm'), StencilForm = loadForm('StencilForm');

interface Node { tag: string; props: Record<string, unknown>; children: Node[]; parent: Node | null; text: string }
const node = (tag: string, text = ''): Node => markRaw({ tag, props: {}, children: [], parent: null, text });
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
  remove: element => { if (element.parent) element.parent.children.splice(element.parent.children.indexOf(element), 1); },
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
const text = (root: Node): string => root.text + root.children.map(text).join('');
const click = (element: Node) => (element.props.onClick as () => void)();
let pinia: ReturnType<typeof createPinia>;
const mounted: Array<() => void> = [];
beforeEach(() => { pinia = createPinia(); setActivePinia(pinia); });
afterEach(() => { mounted.splice(0).forEach(unmount => unmount()); disposePinia(pinia); });

function mountForms(initialMode: AppMode) {
  const mode = ref(initialMode);
  const advancedOpen = ref({ jig: false, stencil: false });
  const input = defineComponent({ props: ['modelValue'], emits: ['focus', 'blur', 'update:modelValue'],
    setup(_props, { emit }) {
      return () => h('input', { onFocus: () => emit('focus'), onBlur: () => emit('blur'),
        onInput: (value: number | null) => emit('update:modelValue', value) });
    },
  });
  const parent = defineComponent({ setup: () => () => h(mode.value === 'jig' ? ConfigForm : StencilForm, {
    advancedOpen: advancedOpen.value[mode.value],
    'onUpdate:advancedOpen': (value: boolean) => { advancedOpen.value[mode.value] = value; },
  }) });
  const root = node('root');
  const app = renderer.createApp(parent);
  app.use(pinia);
  app.component('ElInputNumber', input);
  for (const name of ['ElSlider', 'ElCheckbox', 'ElSelect', 'ElOption']) app.component(name, { render: () => null });
  app.mount(root);
  mounted.push(() => app.unmount());
  const button = (label: string) => all(root).find(element => element.tag === 'button' && text(element).includes(label))!;
  const numberInput = (id: string) => all(root).find(element => element.tag === 'input' && element.props.id === id)!;
  const pressedThickness = () => all(root).find(element => element.props.class === 'preset-row')!.children
    .filter(element => element.props['aria-pressed'] === true).map(text);
  const advancedButton = () => all(root).find(element => element.tag === 'button' && element.props.class === 'advanced-toggle')!;
  return { mode, advancedOpen, root, button, numberInput, pressedThickness, advancedButton };
}

describe('parameter form editing', () => {
  it('keeps the selected thickness preset when the input is focused or cleared', async () => {
    const store = useConfigStore();
    store.config.stencilThickness = 0.2;
    const form = mountForms('stencil');
    const input = form.numberInput('stencil-thickness');
    expect(form.button('stencil.presetStandard').props['aria-pressed']).toBe(true);
    (input.props.onFocus as () => void)();
    await nextTick();
    expect(form.button('stencil.presetStandard').props['aria-pressed']).toBe(true);
    (input.props.onInput as (value: null) => void)(null);
    await nextTick();
    expect(form.button('stencil.presetStandard').props['aria-pressed']).toBe(true);
    expect(store.config.stencilThickness).toBe(0.2);
    (input.props.onBlur as () => void)();
    await nextTick();
    expect(form.button('stencil.presetStandard').props['aria-pressed']).toBe(true);
  });

  it.each([0.25, 0.3])('treats a manual %s mm adjustment separately from picking a preset', async value => {
    const store = useConfigStore();
    store.config.stencilThickness = 0.2;
    const form = mountForms('stencil');
    const input = form.numberInput('stencil-thickness');
    (input.props.onInput as (value: number) => void)(value);
    await nextTick();
    expect(store.config.stencilThickness).toBe(value);
    expect(form.pressedThickness()).toEqual([]);
    click(form.button('stencil.presetFdm'));
    await nextTick();
    expect(store.config.stencilThickness).toBe(0.3);
    expect(form.button('stencil.presetFdm').props['aria-pressed']).toBe(true);
  });

  it.each([
    ['jig', 'jig-length', 'pcbSizeX', 60],
    ['jig', 'jig-width', 'pcbSizeY', 65],
    ['jig', 'jig-thickness', 'pcbThickness', 1.4],
    ['stencil', 'stencil-pcb-thickness', 'pcbThickness', 1.4],
  ] as const)('keeps the model dimensions valid in %s when %s is cleared', async (mode, id, key, value) => {
    const store = useConfigStore();
    const form = mountForms(mode);
    const initial = store.config[key];
    const edit = form.numberInput(id).props.onInput as (next: number | null) => void;

    edit(null);
    await nextTick();
    expect(store.config[key]).toBe(initial);
    edit(value);
    await nextTick();
    expect(store.config[key]).toBe(value);
  });

  it.each([
    ['stencil-length', 'stencilSizeX'],
    ['stencil-width', 'stencilSizeY'],
  ] as const)('requires another size review after a numeric change to %s', async (id, key) => {
    const store = useConfigStore();
    const form = mountForms('jig');
    const initial = store.config[key];
    const edit = form.numberInput(id).props.onInput as (next: number | null) => void;
    store.confirmStencilSizeReview();

    edit(null);
    await nextTick();
    expect(store.config[key]).toBe(initial);
    expect(store.stencilSizeReviewed).toBe(true);
    edit(initial + 5);
    await nextTick();
    expect(store.config[key]).toBe(initial + 5);
    expect(store.stencilSizeReviewed).toBe(false);
  });

  it('retains separate advanced sections when the actual mode forms unmount and remount', async () => {
    const form = mountForms('jig');
    click(form.advancedButton());
    await nextTick();
    expect(form.advancedOpen.value).toEqual({ jig: true, stencil: false });
    form.mode.value = 'stencil';
    await nextTick();
    click(form.advancedButton());
    await nextTick();
    expect(form.advancedOpen.value).toEqual({ jig: true, stencil: true });
    form.mode.value = 'jig';
    await nextTick();
    expect(form.advancedButton().props['aria-expanded']).toBe(true);
    click(form.advancedButton());
    await nextTick();
    expect(form.advancedOpen.value).toEqual({ jig: false, stencil: true });
    form.mode.value = 'stencil';
    await nextTick();
    expect(form.advancedButton().props['aria-expanded']).toBe(true);
  });
});
