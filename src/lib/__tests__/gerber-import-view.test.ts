import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { createSSRApp, defineComponent, h } from 'vue';
import { renderToString } from '@vue/server-renderer';
import GerberImport from '../../components/GerberImport.vue';
import { useConfigStore } from '../../stores/config';
import { i18n } from '../../i18n';

beforeEach(() => setActivePinia(createPinia()));

async function renderImport() {
  const app = createSSRApp(GerberImport);
  app.use(i18n);
  // Closed dialogs do not render their contents in the import card.
  app.component('ElDialog', defineComponent({ render: () => null }));
  app.component('ElAlert', defineComponent({ setup: (_props, { slots }) => () => h('div', slots.default?.()) }));
  return renderToString(app);
}

describe('Gerber import reference preview', () => {
  it('draws the outside and each inner cutout as separate closed contours', async () => {
    const store = useConfigStore();
    store.config.pcbOutlinePoints = [[-20, -15], [20, -15], [20, 15], [-20, 15]];
    store.config.pcbOutlineHoles = [
      [[-10, -5], [-4, -5], [-4, 5], [-10, 5]],
      [[4, -5], [10, -5], [10, 5], [4, 5]],
    ];
    const html = await renderImport();
    const preview = html.match(/<svg[^>]*class="outline-preview"[\s\S]*?<\/svg>/)?.[0] ?? '';
    expect(preview).toContain('fill-rule="evenodd"');
    expect(preview).toContain('d="M-20,-15L20,-15L20,15L-20,15Z M-10,-5L-4,-5L-4,5L-10,5Z M4,-5L10,-5L10,5L4,5Z"');
    expect(preview).not.toContain('<polygon');
    expect(preview).toContain('vector-effect="non-scaling-stroke"');
  });

  it('fits offset, asymmetric outlines even after nominal dimensions are edited', async () => {
    const store = useConfigStore();
    store.config.pcbOutlinePoints = [[100, 20], [180, 20], [180, 35], [130, 70], [100, 70]];
    store.config.pcbSizeX = 5;
    store.config.pcbSizeY = 5;
    const html = await renderImport();
    const values = html.match(/class="outline-preview"[^>]*viewBox="([^"]+)"/)?.[1].split(' ').map(Number);
    expect(values).toHaveLength(4);
    const [x, y, width, height] = values!;
    for (const [px, py] of store.config.pcbOutlinePoints) {
      expect(px).toBeGreaterThan(x);
      expect(px).toBeLessThan(x + width);
      expect(-py).toBeGreaterThan(y);
      expect(-py).toBeLessThan(y + height);
    }
    expect(html).not.toMatch(/<text[^>]*>[\s\S]*?5\.00×5\.00/);
  });
});
