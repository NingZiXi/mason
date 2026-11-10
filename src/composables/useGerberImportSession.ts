import { computed, ref, shallowRef } from 'vue';
import type { useGerberOutline } from './useGerberOutline';
import type { useGerberStencil } from './useGerberStencil';
import type { PanelVariant } from '../lib/gerber/panel';
import { formatImportError } from '../lib/gerber/import-error';

export interface GerberImportPayload {
  filename: string;
  sourceFilename?: string;
  outlineSource?: 'gerber' | 'pads-bounds';
  outlineFallbackReason?: 'missing' | 'invalid';
  isPanel: boolean;
  panelGrid?: { nx: number; ny: number };
  hasPads: boolean;
  boardIndex?: number;
  variants: { panel: PanelVariant; single: PanelVariant; boards?: PanelVariant[] };
}

/** The transaction begins before native disk reads, and spans both parsers.
 * Intermediate parser results must never submit a different file's geometry. */
export function useGerberImportSession(options: {
  mode: () => 'jig' | 'stencil';
  outline: ReturnType<typeof useGerberOutline>;
  stencil: ReturnType<typeof useGerberStencil>;
  submit: (payload: GerberImportPayload) => void;
  onStart?: () => void;
}) {
  let revision = 0;
  const loading = ref(false);
  const failure = shallowRef<unknown>(null);
  const error = computed(() => formatImportError(failure.value)
    ?? (options.mode() === 'stencil' ? options.stencil.error.value : options.outline.error.value));

  function cancel() {
    revision++;
    loading.value = false;
    failure.value = null;
    options.outline.reset();
    options.stencil.reset();
  }

  async function processSource(read: () => Promise<File>) {
    cancel();
    const current = revision;
    const mode = options.mode();
    const active = () => current === revision && mode === options.mode();
    loading.value = true;
    options.onStart?.();
    try {
      const file = await read();
      if (!active()) return;
      if (mode === 'stencil') {
        const result = await options.stencil.processFile(file);
        if (!active() || !result) return;
        options.submit({
          filename: [result.topPasteFile, result.bottomPasteFile].filter(Boolean).join(' + '),
          sourceFilename: file.name, outlineSource: result.outlineSource,
          outlineFallbackReason: result.outlineFallbackReason,
          isPanel: result.isPanel, panelGrid: result.panelGrid, hasPads: true, variants: result.variants,
        });
        return;
      }
      const outline = await options.outline.processFile(file);
      if (!active() || !outline) return;
      const supplemental = await options.stencil.processFile(file);
      if (!active()) return;
      // Standalone GBR outlines also parse as paste strokes. Their estimated
      // pad bounds must not replace the authoritative PCB boundary.
      const stencil = supplemental?.outlineSource === 'gerber' ? supplemental : null;
      if (!stencil) options.stencil.reset();
      options.submit({
        filename: outline.filename, sourceFilename: file.name, outlineSource: 'gerber',
        isPanel: outline.parse.isPanel, panelGrid: outline.parse.panelGrid,
        hasPads: !!stencil, variants: stencil?.variants ?? outline.variants,
      });
    } catch (e) {
      if (active()) failure.value = e;
    } finally {
      if (active()) loading.value = false;
    }
  }

  return { loading, error, cancel, processSource, processFile: (file: File) => processSource(async () => file) };
}
