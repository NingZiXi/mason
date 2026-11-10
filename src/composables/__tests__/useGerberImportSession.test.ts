import { describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { useGerberOutline } from '../useGerberOutline';
import { useGerberStencil, type GerberStencilResult } from '../useGerberStencil';
import { useGerberImportSession } from '../useGerberImportSession';

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const outlineText = '%FSLAX24Y24*%\n%MOMM*%\nG01*\nX0Y0D02*\nX100000Y0D01*\nX100000Y80000D01*\nX0Y80000D01*\nX0Y0D01*\nM02*';
const pasteText = '%FSLAX24Y24*%\n%MOMM*%\n%ADD10R,2X2*%\nD10*\nX0Y0D03*\nM02*';
const file = (name: string, text: string) => ({ name, text: async () => text }) as File;
function setup(initialMode: 'jig' | 'stencil' = 'jig') {
  const mode = ref(initialMode), outline = useGerberOutline(), stencil = useGerberStencil(), submit = vi.fn();
  const session = useGerberImportSession({ mode: () => mode.value, outline, stencil, submit });
  return { mode, outline, stencil, submit, session };
}

describe('the entire Gerber import transaction', () => {
  it('orders native file reads before parsing, so an earlier slow read cannot start a new import', async () => {
    const { session, submit, stencil } = setup('stencil');
    const oldRead = deferred<File>();
    const old = session.processSource(() => oldRead.promise);
    await session.processFile(file('latest.gtp', pasteText));
    oldRead.resolve(file('old.gtp', pasteText));
    await old;
    expect(submit).toHaveBeenCalledOnce();
    expect(submit.mock.calls[0][0].sourceFilename).toBe('latest.gtp');
    expect(stencil.result.value?.topPasteFile).toBe('latest.gtp');
  });

  it('keeps loading active throughout supplemental paste parsing and never submits after clear', async () => {
    const { session, stencil, submit } = setup();
    const paste = deferred<GerberStencilResult | null>();
    const parse = vi.spyOn(stencil, 'processFile').mockReturnValue(paste.promise);
    const pending = session.processFile(file('board.gko', outlineText));
    await vi.waitFor(() => expect(parse).toHaveBeenCalledOnce());
    expect(session.loading.value).toBe(true);
    session.cancel();
    paste.resolve(null);
    await pending;
    expect(session.loading.value).toBe(false);
    expect(submit).not.toHaveBeenCalled();
  });

  it('does not let an obsolete second parser submit a board or stop the next read spinner', async () => {
    const { session, stencil, submit } = setup();
    const paste = deferred<GerberStencilResult | null>(), nextRead = deferred<File>();
    const parse = vi.spyOn(stencil, 'processFile').mockReturnValueOnce(paste.promise);
    const old = session.processFile(file('old.gko', outlineText));
    await vi.waitFor(() => expect(parse).toHaveBeenCalledOnce());
    const next = session.processSource(() => nextRead.promise);
    paste.resolve(null); await old;
    expect(submit).not.toHaveBeenCalled();
    expect(session.loading.value).toBe(true);
    nextRead.resolve(file('latest.gko', outlineText)); await next;
    expect(submit).toHaveBeenCalledOnce();
    expect(submit.mock.calls[0][0].sourceFilename).toBe('latest.gko');
  });

  it('discards native read errors after cancellation or another import', async () => {
    const { session, submit } = setup('stencil');
    const read = deferred<File>();
    const pending = session.processSource(() => read.promise);
    await session.processFile(file('latest.gtp', pasteText));
    read.reject(new Error('stale permission error')); await pending;
    expect(session.error.value).toBeNull();
    expect(submit).toHaveBeenCalledOnce();
    await session.processSource(async () => { throw new Error('current permission error'); });
    expect(session.error.value).toBe('current permission error');
  });

  it('does not submit an import started in a different manufacturing mode', async () => {
    const { session, mode, submit } = setup('stencil');
    const read = deferred<File>();
    const pending = session.processSource(() => read.promise);
    mode.value = 'jig'; session.cancel();
    read.resolve(file('old.gtp', pasteText)); await pending;
    expect(submit).not.toHaveBeenCalled();
    expect(session.loading.value).toBe(false);
  });

  it('propagates estimated outline provenance and preserves valid outline-only jig imports', async () => {
    const { session, mode, submit } = setup('stencil');
    await session.processFile(file('pads.gtp', pasteText));
    expect(submit.mock.calls[0][0]).toMatchObject({ outlineSource: 'pads-bounds', outlineFallbackReason: 'missing' });
    mode.value = 'jig'; session.cancel();
    await session.processFile(file('outline.gko', outlineText));
    expect(submit.mock.calls[1][0]).toMatchObject({ outlineSource: 'gerber', hasPads: false });
    expect(session.error.value).toBeNull();
  });

  it('keeps a real standalone GBR outline instead of treating its strokes as paste geometry', async () => {
    const { session, stencil, submit } = setup();
    const source = file('board-outline.gbr', outlineText.replace('G01*', '%ADD10C,1.0*%\nD10*\nG01*'));
    // GBR is accepted by both parsers. Without a separate outline layer, the
    // paste parser estimates a larger boundary around the outline's strokes.
    const supplemental = await stencil.processFile(source);
    expect(supplemental?.outlineSource).toBe('pads-bounds');
    expect(supplemental?.width).toBeGreaterThan(10);

    await session.processFile(source);
    expect(submit).toHaveBeenCalledOnce();
    const payload = submit.mock.calls[0][0];
    expect(payload).toMatchObject({ outlineSource: 'gerber', hasPads: false });
    expect(payload.variants.panel.width).toBeCloseTo(10);
    expect(payload.variants.panel.height).toBeCloseTo(8);
    expect(payload.variants.panel.topPads).toBeUndefined();
    expect(stencil.result.value).toBeNull();
    expect(session.error.value).toBeNull();
  });
});
