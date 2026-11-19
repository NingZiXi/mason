import { computed, ref, shallowRef } from 'vue';
import type { useGerberOutline } from './useGerberOutline';
import type { useGerberStencil } from './useGerberStencil';
import type { PanelVariant } from '../lib/gerber/panel';
import { openGerberArchive } from '../lib/gerber/import-archive';
import { formatImportError } from '../lib/gerber/import-error';

/** Source metadata belongs to the import, not the current mode or selected panel. */
export interface GerberFileDetails {
  outline: string | null;
  topPaste: string | null;
  bottomPaste: string | null;
  skipped?: number;
  units?: string | null;
  arcs?: number;
  otherOutlines?: string[];
}

export interface GerberImportPayload {
  details?: GerberFileDetails;
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
      const archive = file.name.toLowerCase().endsWith('.zip') ? openGerberArchive(file) : undefined;
      if (mode === 'stencil') {
        const result = await options.stencil.processFile(file, archive);
        if (!active() || !result) return;
        options.submit({
          filename: [result.topPasteFile, result.bottomPasteFile].filter(Boolean).join(' + '),
          sourceFilename: file.name, outlineSource: result.outlineSource,
          details: { outline: result.outlineSource === 'gerber' ? result.outlineFile : null,
            topPaste: result.topPasteFile, bottomPaste: result.bottomPasteFile, skipped: result.skipped },
          outlineFallbackReason: result.outlineFallbackReason,
          isPanel: result.isPanel, panelGrid: result.panelGrid, hasPads: true, variants: result.variants,
        });
        return;
      }
      const outline = await options.outline.processFile(file, archive);
      if (!active() || !outline) return;
      const supplemental = archive ? await options.stencil.processFile(file, archive) : null;
      if (!active()) return;
      // A standalone outline has no independent paste layer.
      const stencil = supplemental?.outlineSource === 'gerber' ? supplemental : null;
      if (!stencil) options.stencil.reset();
      options.submit({
        filename: outline.filename, sourceFilename: file.name, outlineSource: 'gerber',
        details: { outline: outline.filename, topPaste: stencil?.topPasteFile ?? null, bottomPaste: stencil?.bottomPasteFile ?? null,
          skipped: stencil?.skipped, units: outline.bbox.units, arcs: outline.parse.arcsLinearized,
          otherOutlines: options.outline.candidates.value.slice(1, 4).map(candidate => candidate.filename) },
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
