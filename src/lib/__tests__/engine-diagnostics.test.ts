import { describe, expect, it, vi } from 'vitest';
import { createSSRApp } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { renderToString } from '@vue/server-renderer';
import { invoke } from '@tauri-apps/api/core';
import { i18n } from '../../i18n';
import { useConfigStore } from '../../stores/config';
import PythonSetup from '../../components/PythonSetup.vue';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

async function renderStatus(bundled: boolean, missing: string[], probe_error: string | null) {
  const pinia = createPinia(); setActivePinia(pinia);
  vi.mocked(invoke).mockResolvedValueOnce({ python_path: '/test/bin/python3', bundled, missing, probe_error, deps_ok: false });
  await useConfigStore(pinia).detectPython();
  const app = createSSRApp(PythonSetup); app.use(pinia); app.use(i18n);
  return renderToString(app);
}

describe('engine diagnostics', () => {
  it('reports a launch failure and its path without offering pip', async () => {
    const html = await renderStatus(true, [], 'No module named encodings');
    expect(html).toContain('No module named encodings');
    expect(html).toContain('/test/bin/python3');
    expect(html).not.toContain(i18n.global.t('python.installDeps'));
    expect(html).not.toContain(i18n.global.t('python.readyHintBundled'));
  });
  it('only offers to install actually missing packages into external interpreters', async () => {
    for (const bundled of [false, true]) {
      const html = await renderStatus(bundled, ['shapely'], null);
      expect(html).toContain('>shapely</code>');
      expect(html.includes(i18n.global.t('python.installDeps'))).toBe(!bundled);
    }
  });
});
