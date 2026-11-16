import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as Vue from 'vue';
import { createRenderer, defineComponent, h, markRaw, nextTick, ref, type Component } from 'vue';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import { readFileSync } from 'node:fs';
import { compileScript, parse } from '@vue/compiler-sfc';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import * as config from '../../stores/config';
import * as ejectHole from '../eject-hole';
import { useConfigStore, type AppMode } from '../../stores/config';

// Compile actual browser templates rather than Vitest's SSR-only SFC output.
const empty = defineComponent({ render: () => null });
const passSlots = defineComponent({ setup: (_props, { slots }) => () => h('section', slots.default?.()) });
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
    if (dependency.endsWith('/lib/eject-hole')) return ejectHole;
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
  const focusValues: unknown[] = [];
  const input = defineComponent({ props: ['modelValue'], emits: ['focus', 'blur', 'update:modelValue'],
    setup(props, { emit, expose }) {
      expose({ focus: () => { focusValues.push(props.modelValue); emit('focus'); } });
      return () => h('input', { 'data-value': props.modelValue, onBlur: () => emit('blur') });
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
  const advancedButton = () => all(root).find(element => element.tag === 'button' && element.props.class === 'advanced-toggle')!;
  return { mode, advancedOpen, focusValues, root, button, advancedButton };
}

describe('parameter form editing', () => {
  it.each([0.2, 0.25])('focuses custom thickness without replacing the existing %s mm value', async value => {
    const store = useConfigStore();
    store.config.stencilThickness = value;
    const form = mountForms('stencil');
    click(form.button('stencil.presetCustom'));
    await nextTick();
    expect(store.config.stencilThickness).toBe(value);
    expect(form.focusValues).toEqual([value]);
    expect(form.button('stencil.presetCustom').props['aria-pressed']).toBe(true);
    expect(form.button('stencil.presetStandard').props['aria-pressed']).toBe(false);
    const focusedInput = all(form.root).find(element => element.tag === 'input' && element.props['data-value'] === value)!;
    (focusedInput.props.onBlur as () => void)();
    await nextTick();
    expect(form.button('stencil.presetCustom').props['aria-pressed']).toBe(value === 0.25);
  });

  it('returns from custom editing to a thickness preset with one click', async () => {
    const form = mountForms('stencil');
    click(form.button('stencil.presetCustom'));
    await nextTick();
    click(form.button('stencil.presetFdm'));
    await nextTick();
    expect(useConfigStore().config.stencilThickness).toBe(0.3);
    expect(form.button('stencil.presetFdm').props['aria-pressed']).toBe(true);
    expect(form.button('stencil.presetCustom').props['aria-pressed']).toBe(false);
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
    expect(all(form.advancedButton()).some(element => String(element.props.class).includes('is-open'))).toBe(true);
    click(form.advancedButton());
    await nextTick();
    expect(form.advancedOpen.value).toEqual({ jig: false, stencil: true });
    form.mode.value = 'stencil';
    await nextTick();
    expect(all(form.advancedButton()).some(element => String(element.props.class).includes('is-open'))).toBe(true);
  });
});
