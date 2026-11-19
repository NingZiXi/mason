import { describe, expect, it, vi } from 'vitest';
import { createSSRApp, defineComponent } from 'vue';
import { createPinia } from 'pinia';
import { renderToString } from '@vue/server-renderer';
import ModelPreview from '../../components/ModelPreview.vue';
import { i18n } from '../../i18n';
import { useConfigStore } from '../../stores/config';

vi.mock('../../stores/ui', () => ({ useUiStore: () => ({ skin: 'classic', resolvedTheme: 'light', defaultExportFormat: 'stl' }) }));

async function preview(options: { board?: boolean; detected?: boolean; checking?: boolean; importing?: boolean; panel?: boolean }) {
  const pinia = createPinia();
  const store = useConfigStore(pinia);
  store.config.appMode = 'stencil';
  if (options.board) store.config.stencilPadsTop = [{ type: 'rect', polarity: 'D', cx: 0, cy: 0,
    parts: [{ polarity: 'D', points: [[0, 0], [1, 0], [1, 1], [0, 1]] }] }];
  store.engineLoading = !!options.checking;
  store.pythonDetected = !!options.detected;
  store.gerberImporting = !!options.importing;
  const app = createSSRApp(ModelPreview, { choosingPanel: !!options.panel });
  app.use(pinia).use(i18n);
  app.component('ElDropdown', defineComponent({ inheritAttrs: false, setup: (_, { slots }) => () => slots.default?.() }));
  app.component('ElSlider', {}); app.component('ElDropdownMenu', {}); app.component('ElDropdownItem', {});
  const html = await renderToString(app);
  const buttons = html.match(/<button\b[^>]*>/g) ?? [];
  const controls = [/assembly-mode-btn/, /export-default/, /export-format-toggle/].map(re => buttons.find(tag => re.test(tag)));
  controls.push(buttons.find(tag => tag.includes(`aria-label="${i18n.global.t('preview.refresh')}"`)));
  expect(controls.every(Boolean)).toBe(true);
  return { hasPicker: buttons.some(tag => tag.includes('empty-card')), html,
    enabled: controls.map(tag => !/\sdisabled\b/.test(tag!)) };
}

describe('first import and preview toolbar', () => {
  it('keeps file selection available before the engine is ready, but never offers a second import while parsing or choosing a panel', async () => {
    for (const checking of [true, false]) expect((await preview({ checking })).hasPicker).toBe(true);
    for (const [flags, key] of [[{ importing: true }, 'gerber.parsing'], [{ panel: true }, 'gerber.panelDialogTitle']] as const) {
      const view = await preview(flags);
      expect(view.hasPicker).toBe(false);
      expect(view.html).toContain(i18n.global.t(key));
    }
  });
  it('gates all four actions together and shows the next step while waiting for the first mesh', async () => {
    for (const [flags, available, key] of [
      [{}, false, 'preview.noPythonPreview'], [{ checking: true }, false, 'preview.checkingEngine'],
      [{ detected: true, importing: true }, false, 'gerber.parsing'], [{ detected: true }, true, 'preview.rendering'],
    ] as const) {
      const view = await preview({ board: true, ...flags });
      expect(view.hasPicker).toBe(false);
      expect(view.html).toContain(i18n.global.t(key));
      expect(view.enabled).toEqual(Array(4).fill(available));
      // Imports can enable export before there is a mesh to measure.
      expect(view.html).not.toContain('class="viewport-tools"');
      expect(view.html).not.toContain('class="viewport-hint"');
    }
  });
});
