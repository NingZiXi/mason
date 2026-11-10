import { describe, expect, it } from 'vitest';
import { useGerberOutline, type GerberOutlineResult } from '../useGerberOutline';
import { useGerberStencil, type GerberStencilResult } from '../useGerberStencil';

const outline = `%FSLAX24Y24*%
%MOMM*%
%ADD10C,0.1*%
D10*
X0Y0D02*
X100000Y0D01*
X100000Y100000D01*
X0Y100000D01*
X0Y0D01*
M02*`;
const paste = `%FSLAX24Y24*%
%MOMM*%
%ADD10R,2X2*%
D10*
X0Y0D03*
M02*`;

function deferredFile(name: string) {
  let resolve!: (value: string) => void;
  let reject!: (reason: Error) => void;
  const text = new Promise<string>((done, fail) => { resolve = done; reject = fail; });
  return { file: { name, text: () => text } as File, resolve, reject };
}
function resultName(result: GerberOutlineResult | GerberStencilResult | null) {
  return result && ('filename' in result ? result.filename : result.topPasteFile);
}

const imports = [
  { label: 'board outline', create: useGerberOutline, extension: 'gko', content: outline },
  { label: 'paste layer', create: useGerberStencil, extension: 'gtp', content: paste },
];

describe.each(imports)('$label import transactions', ({ create, extension, content }) => {
  it('only publishes and returns the latest import when an older read completes later', async () => {
    const state = create();
    const older = deferredFile(`old.${extension}`);
    const oldTask = state.processFile(older.file);
    const current = await state.processFile({ name: `new.${extension}`, text: async () => content } as File);
    expect(resultName(current)).toBe(`new.${extension}`);
    older.resolve(content);
    expect(await oldTask).toBeNull();
    expect(resultName(state.result.value)).toBe(`new.${extension}`);
    if ('candidates' in state) expect(state.candidates.value.map(c => c.filename)).toEqual([`new.${extension}`]);
    expect(state.error.value).toBeNull();
    expect(state.loading.value).toBe(false);
  });

  it.each(['resolve', 'reject'] as const)('does not restore data or errors after reset during a read (%s)', async finish => {
    const state = create();
    const pending = deferredFile(`cleared.${extension}`);
    const task = state.processFile(pending.file);
    expect(state.loading.value).toBe(true);
    state.reset();
    if (finish === 'resolve') pending.resolve(content);
    else pending.reject(new Error('old read failed'));
    expect(await task).toBeNull();
    expect(state.result.value).toBeNull();
    expect(state.error.value).toBeNull();
    expect(state.loading.value).toBe(false);
    if ('candidates' in state) expect(state.candidates.value).toEqual([]);
  });

  it.each(['resolve', 'reject'] as const)('keeps the current loading state when an older read completes (%s)', async finish => {
    const state = create();
    const older = deferredFile(`old.${extension}`);
    const latest = deferredFile(`latest.${extension}`);
    const oldTask = state.processFile(older.file);
    const latestTask = state.processFile(latest.file);
    if (finish === 'resolve') older.resolve(content);
    else older.reject(new Error('old read failed'));
    expect(await oldTask).toBeNull();
    expect(state.loading.value).toBe(true);
    expect(state.result.value).toBeNull();
    expect(state.error.value).toBeNull();
    latest.resolve(content);
    expect(resultName(await latestTask)).toBe(`latest.${extension}`);
    expect(state.loading.value).toBe(false);
  });

  it('ignores an old failure after the current import succeeds', async () => {
    const state = create();
    const older = deferredFile(`old.${extension}`);
    const oldTask = state.processFile(older.file);
    await state.processFile({ name: `new.${extension}`, text: async () => content } as File);
    older.reject(new Error('stale error'));
    expect(await oldTask).toBeNull();
    expect(resultName(state.result.value)).toBe(`new.${extension}`);
    expect(state.error.value).toBeNull();
    expect(state.loading.value).toBe(false);
  });

  it('preserves the current failure when an old import later succeeds', async () => {
    const state = create();
    const older = deferredFile(`old.${extension}`);
    const oldTask = state.processFile(older.file);
    const latest = deferredFile(`new.${extension}`);
    const latestTask = state.processFile(latest.file);
    latest.reject(new Error('current read failed'));
    expect(await latestTask).toBeNull();
    expect(state.error.value).toBe('current read failed');
    older.resolve(content);
    expect(await oldTask).toBeNull();
    expect(state.result.value).toBeNull();
    expect(state.error.value).toBe('current read failed');
    expect(state.loading.value).toBe(false);
  });
});
