import { describe, expect, it, vi } from 'vitest';
import { exportModels, ModelExportError, type ModelExportPart } from '../model-export';

const parts: ModelExportPart[] = [
  { name: 'base', rust: 'base', filename: 'jig_base.stl', bytes: new ArrayBuffer(12) },
  { name: 'insert', rust: 'pcb_insert', filename: 'jig_pcb_insert.stl' },
  { name: 'cover', rust: 'top_cover', filename: 'jig_top_cover.stl' },
];

function setup(behavior?: (command: string, args?: Record<string, unknown>) => unknown) {
  const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
    const result = behavior?.(command, args);
    if (result !== undefined) return await result;
    if (command === 'begin_model_export') return { token: 'ours', directory: 'C:\\export\\.mason-export-ours.tmp' };
    if (command === 'commit_model_export') return 'C:\\export\\board';
  });
  const options = { invoke: invoke as <T>(command: string, args?: Record<string, unknown>) => Promise<T>,
    parentDir: 'C:\\export', name: 'board', params: { pcb_size_x: 20 }, parts };
  return { invoke, options };
}

describe('model export transactions', () => {
  it('writes cached and generated parts only inside staging and commits once every part succeeds', async () => {
    const { invoke, options } = setup();
    expect(await exportModels(options)).toBe('C:\\export\\board');
    expect(invoke.mock.calls.map(call => call[0])).toEqual([
      'begin_model_export', 'write_file_bytes', 'export_stl', 'export_stl', 'commit_model_export',
    ]);
    expect(invoke.mock.calls[1][1]).toMatchObject({ path: 'C:\\export\\.mason-export-ours.tmp\\jig_base.stl', bytes: parts[0].bytes });
    expect(invoke.mock.calls[2][1]).toMatchObject({ outputPath: 'C:\\export\\.mason-export-ours.tmp\\jig_pcb_insert.stl' });
  });

  it('aborts a partially written export and reports the failed part and completed count', async () => {
    const { invoke, options } = setup((command) => {
      if (command === 'export_stl') throw new Error('geometry failed');
    });
    const error = await exportModels(options).catch(error => error);
    expect(error).toBeInstanceOf(ModelExportError);
    expect(error).toMatchObject({ message: 'geometry failed', failedPart: 'insert', completed: 1, total: 3, phase: 'write', cancelled: false });
    expect(invoke.mock.calls.map(call => call[0])).toEqual(['begin_model_export', 'write_file_bytes', 'export_stl', 'abort_model_export']);
    expect(invoke).toHaveBeenLastCalledWith('abort_model_export', { token: 'ours' });
  });

  it('preserves the original failure when cleanup itself fails', async () => {
    const { options } = setup((command) => {
      if (command === 'write_file_bytes') throw new Error('disk full');
      if (command === 'abort_model_export') throw new Error('file is locked');
    });
    const error = await exportModels(options).catch(error => error);
    expect(error).toMatchObject({ message: 'disk full', completed: 0, failedPart: 'base' });
    expect(error.cleanupError.message).toBe('file is locked');
  });

  it('aborts if final validation or publication fails', async () => {
    const { invoke, options } = setup((command) => {
      if (command === 'commit_model_export') throw new Error('empty model file');
    });
    const error = await exportModels(options).catch(error => error);
    expect(error).toMatchObject({ completed: 3, phase: 'commit', failedPart: undefined });
    expect(invoke).toHaveBeenLastCalledWith('abort_model_export', { token: 'ours' });
  });

  it('waits for an in-flight write before aborting, and never starts another part after cancellation', async () => {
    const controller = new AbortController();
    const { invoke, options } = setup((command) => {
      if (command === 'write_file_bytes') controller.abort();
    });
    const error = await exportModels({ ...options, signal: controller.signal }).catch(error => error);
    expect(error).toMatchObject({ completed: 1, cancelled: true });
    expect(invoke.mock.calls.map(call => call[0])).toEqual(['begin_model_export', 'write_file_bytes', 'abort_model_export']);
  });

  it('does not create any directory when already cancelled and does not abort an unrelated export on begin failure', async () => {
    const controller = new AbortController(); controller.abort();
    const { invoke, options } = setup();
    await expect(exportModels({ ...options, signal: controller.signal })).rejects.toMatchObject({ cancelled: true });
    expect(invoke).not.toHaveBeenCalled();
    invoke.mockImplementation(async () => { throw new Error('access denied'); });
    await expect(exportModels(options)).rejects.toMatchObject({ message: 'access denied', phase: 'begin' });
    expect(invoke).toHaveBeenCalledOnce();
  });

  it('keeps a successful published export when the view is disposed while commit is pending', async () => {
    let active = true;
    const { invoke, options } = setup(command => {
      if (command === 'commit_model_export') active = false;
    });
    expect(await exportModels({ ...options, active: () => active })).toBe('C:\\export\\board');
    expect(invoke.mock.calls.some(call => call[0] === 'abort_model_export')).toBe(false);
  });
});
