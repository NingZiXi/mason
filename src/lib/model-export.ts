type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

export interface ModelExportPart {
  /** UI part identifier, used to translate errors and progress labels. */
  name: 'base' | 'insert' | 'cover' | 'stencil_top' | 'stencil_bottom';
  rust: string;
  filename: string;
  bytes?: ArrayBuffer;
}

/** The confirmation and the writer use the same ordered list, independent of the visible tab. */
export function modelExportPlan(mode: 'jig' | 'stencil', fmt: 'stl' | 'step', hasTop: boolean, hasBottom: boolean): ModelExportPart[] {
  if (mode === 'jig') return [
    { name: 'base', rust: 'base', filename: `jig_base.${fmt}` },
    { name: 'insert', rust: 'pcb_insert', filename: `jig_pcb_insert.${fmt}` },
    { name: 'cover', rust: 'top_cover', filename: `jig_top_cover.${fmt}` },
  ];
  const parts: ModelExportPart[] = [];
  if (hasTop || !hasBottom) parts.push({ name: 'stencil_top', rust: 'stencil_top', filename: `stencil_top.${fmt}` });
  if (hasBottom) parts.push({ name: 'stencil_bottom', rust: 'stencil_bottom', filename: `stencil_bottom.${fmt}` });
  return parts;
}

interface Transaction { token: string; directory: string }
export type ExportPhase = 'begin' | 'write' | 'commit';

export type ModelExportProgress =
  | { phase: 'write'; part: ModelExportPart['name']; current: number; total: number }
  | { phase: 'commit' };

export class ModelExportError extends Error {
  readonly name = 'ModelExportError';
  constructor(
    readonly originalError: unknown,
    readonly phase: ExportPhase,
    readonly failedPart: string | undefined,
    readonly completed: number,
    readonly total: number,
    readonly cancelled: boolean,
    readonly cleanupError?: unknown,
  ) {
    super(originalError instanceof Error ? originalError.message : String(originalError));
  }
}

/** A failed or cancelled export never returns a final directory. Parameters
 * and cached bytes must describe the same snapshot, selected by the caller. */
export async function exportModels(options: {
  invoke: Invoke;
  parentDir: string;
  name: string;
  params: Record<string, unknown>;
  parts: readonly ModelExportPart[];
  signal?: AbortSignal;
  active?: () => boolean;
  onProgress?: (progress: ModelExportProgress) => void;
}): Promise<string> {
  let transaction: Transaction | undefined;
  let phase: ExportPhase = 'begin';
  let failedPart: string | undefined;
  let completed = 0;
  let cancelled = false;
  const checkActive = () => {
    if (options.signal?.aborted || options.active?.() === false) {
      cancelled = true;
      throw new Error('Model export cancelled');
    }
  };
  try {
    checkActive();
    if (!options.parts.length) throw new Error('No model parts to export');
    transaction = await options.invoke<Transaction>('begin_model_export', {
      parentDir: options.parentDir, name: options.name,
      filenames: options.parts.map(part => part.filename),
    });
    checkActive();
    phase = 'write';
    const separator = transaction.directory.includes('\\') ? '\\' : '/';
    for (const part of options.parts) {
      failedPart = part.name;
      checkActive();
      options.onProgress?.({ phase: 'write', part: part.name, current: completed + 1, total: options.parts.length });
      const path = `${transaction.directory}${separator}${part.filename}`;
      if (part.bytes) {
        await options.invoke('write_file_bytes', { path, bytes: part.bytes });
      } else {
        await options.invoke('export_stl', { params: options.params, part: part.rust, outputPath: path });
      }
      completed += 1;
      checkActive();
    }
    phase = 'commit';
    failedPart = undefined;
    checkActive();
    options.onProgress?.({ phase: 'commit' });
    const directory = await options.invoke<string>('commit_model_export', { token: transaction.token });
    // A completed commit owns a valid final export, even if the component was
    // disposed while the final IPC was pending. Do not roll back that export.
    transaction = undefined;
    return directory;
  } catch (originalError) {
    let cleanupError: unknown;
    if (transaction) {
      try { await options.invoke('abort_model_export', { token: transaction.token }); }
      catch (error) { cleanupError = error; }
    }
    throw new ModelExportError(originalError, phase, failedPart, completed, options.parts.length, cancelled, cleanupError);
  }
}
