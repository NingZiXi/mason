import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Vue from 'vue';
import { createRenderer, defineComponent, h, nextTick, type Component } from 'vue';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import { ElSwitch, ID_INJECTION_KEY } from 'element-plus';
import { readFileSync } from 'node:fs';
import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import * as config from '../../stores/config';
import * as relief from '../component-relief';
import * as helpers from '../component-relief-editor';
import * as automatic from '../component-relief-auto';
import * as padGuide from '../relief-pad-guide';
import * as shortcuts from '../history-shortcuts';
import * as params from '../model-params';

// Compile both actual templates and mount the actual Element Plus switch. This
// covers the parent binding and component event contract omitted by an editor
// test that supplies its props manually or substitutes a simplified switch.
const passSlots = defineComponent({ setup: (_props, { slots }) => () => h('div', slots.default?.()) });
const empty = defineComponent({ setup: () => () => null });
const preview = defineComponent({ emits: ['edit'], setup: (_props, { emit }) => () => h('button', {
  'data-open-editor': true, onClick: () => emit('edit'),
}) });
let Editor: Component;
function loadComponent(name: 'ComponentReliefEditor' | 'ComponentReliefForm'): Component {
  const source = readFileSync(new URL(`../../components/${name}.vue`, import.meta.url), 'utf8');
  const descriptor = parse(source).descriptor;
  const script = compileScript(descriptor, { id: `integration-${name}` });
  const javascript = transpileModule(script.content, { compilerOptions: { module: ModuleKind.CommonJS,
    target: ScriptTarget.ES2022 } }).outputText;
  const compiled = { exports: {} as { default: Component } };
  const resolveImport = (dependency: string): unknown => {
    if (dependency === 'vue') return Vue;
    if (dependency === 'element-plus') return { ElSwitch };
    if (dependency === 'vue-i18n') return { useI18n: () => ({ t: (key: string) => key }) };
    if (dependency === '@tauri-apps/api/core') return { invoke: vi.fn() };
    if (dependency.endsWith('/stores/config')) return config;
    if (dependency.endsWith('/component-relief')) return relief;
    if (dependency.endsWith('/component-relief-editor')) return helpers;
    if (dependency.endsWith('/component-relief-auto')) return automatic;
    if (dependency.endsWith('/relief-pad-guide')) return padGuide;
    if (dependency.endsWith('/history-shortcuts')) return shortcuts;
    if (dependency.endsWith('/model-params')) return params;
    if (dependency.endsWith('/ComponentReliefEditor.vue')) return { __esModule: true, default: Editor };
    if (dependency.endsWith('/ComponentReliefPreview.vue')) return { default: preview };
    if (dependency.endsWith('/SlidingIndicator.vue')) return { default: empty };
    if (dependency.endsWith('/MotionCollapse.vue') || dependency.endsWith('/InlineHelp.vue')) return { default: passSlots };
    throw new Error(`Unexpected dependency: ${dependency}`);
  };
  new Function('require', 'exports', 'module', javascript)(resolveImport, compiled.exports, compiled);
  const template = compileTemplate({ source: descriptor.template!.content, filename: name + '.vue', id: name, compilerOptions: { bindingMetadata: script.bindings } });
  const templateCode = transpileModule(template.code, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText;
  const renderModule = { exports: {} as { render: (args: unknown) => unknown } };
  new Function('require', 'exports', 'module', templateCode)(resolveImport, renderModule.exports, renderModule);
  Object.assign(compiled.exports.default, { render: renderModule.exports.render });
  return compiled.exports.default;
}
Editor = loadComponent('ComponentReliefEditor');
const Form = loadComponent('ComponentReliefForm');

interface Node { tag: string; props: Record<string, unknown>; children: Node[]; parent: Node | null; text: string }
const node = (tag: string, text = ''): Node => Vue.markRaw({ tag, props: {}, children: [], parent: null, text });
const renderer = createRenderer<Node, Node>({
  createElement: tag => Object.assign(node(tag), { clientWidth: 600, clientHeight: 400, focus: () => {} }),
  createText: text => node('#text', text), createComment: text => node('#comment', text),
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
const click = (element: Node) => (element.props.onClick as (event: unknown) => void)({ preventDefault: () => {} });
let pinia: ReturnType<typeof createPinia>;
const mounted: Array<() => void> = [];
beforeEach(() => {
  pinia = createPinia(); setActivePinia(pinia);
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal('document', { hidden: false, addEventListener: vi.fn(), removeEventListener: vi.fn() });
});
afterEach(() => { mounted.splice(0).forEach(unmount => unmount()); disposePinia(pinia); vi.unstubAllGlobals(); });
async function settle() { for (let index = 0; index < 8; ++index) { await Promise.resolve(); await nextTick(); } }
async function mountForm(width = config.DEFAULT.ejectSlotWidth) {
  const store = config.useConfigStore();
  Object.assign(store.config, { appMode: 'jig', componentReliefEnabled: true, ejectSlotWidth: width,
    ejectHoleDiameter: 12.5, pcbOutlinePoints: [[-20, -15], [20, -15], [20, 15], [-20, 15]] });
  await nextTick(); store.clearParameterHistory();
  const root = node('root');
  const app = renderer.createApp(Form); app.use(pinia); app.provide(ID_INJECTION_KEY, { prefix: 1, current: 0 });
  app.component('ElDialog', passSlots);
  app.component('ElInputNumber', defineComponent({ setup: () => () => null }));
  app.mount(root); mounted.push(() => app.unmount());
  await settle();
  click(all(root).find(element => element.props['data-open-editor'])!);
  await settle();
  const input = () => all(root).find(element => element.props.role === 'switch'
    && element.props['aria-label'] === 'config.ejectSlot')!;
  const toggle = async () => { expect(input()).toBeDefined(); click(input().parent!); await settle(); };
  return { store, root, input, toggle };
}

describe('relief form and editor eject-hole integration', () => {
  it.each([config.DEFAULT.ejectSlotWidth, 0])('shows the actual saved switch state for width %s', async width => {
    const { store, input, toggle } = await mountForm(width);
    expect(input().props['aria-checked']).toBe(width > 0);
    await toggle();
    expect(store.config.ejectSlotWidth > 0).toBe(!(width > 0));
    expect(input().props['aria-checked']).toBe(!(width > 0));
    expect(store.config.ejectHoleDiameter).toBe(12.5);
    await toggle();
    expect(store.config.ejectSlotWidth > 0).toBe(width > 0);
    expect(input().props['aria-checked']).toBe(width > 0);
    expect(store.config.ejectHoleDiameter).toBe(12.5);
  });
  it('reflects main-settings changes and undo/redo without resetting the diameter', async () => {
    const { store, input, toggle } = await mountForm();
    await toggle();
    await store.undo(); await settle();
    expect(input().props['aria-checked']).toBe(true);
    await store.redo(); await settle();
    expect(input().props['aria-checked']).toBe(false);
    store.config.ejectSlotWidth = config.DEFAULT.ejectSlotWidth; await settle();
    expect(input().props['aria-checked']).toBe(true);
    expect(store.config.ejectHoleDiameter).toBe(12.5);
  });
});
