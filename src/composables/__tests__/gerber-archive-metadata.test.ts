import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { detectOutlineFiles } from '../../lib/gerber/outline-detect';
import { detectPasteFiles } from '../../lib/gerber/paste-detect';
import { useGerberOutline } from '../useGerberOutline';
import { useGerberStencil } from '../useGerberStencil';

const outline = '%FSLAX24Y24*%\n%MOMM*%\nG01*\nX0Y0D02*\nX100000Y0D01*\nX100000Y200000D01*\nX0Y200000D01*\nX0Y0D01*\nM02*';
const paste = '%FSLAX24Y24*%\n%MOMM*%\n%ADD10C,1.8*%\nD10*\nX50000Y50000D03*\nM02*';
const probe = JSON.stringify({ lengthUnit: 'mm',
  components: { fields: ['COMPONENT_NAME', 'LAYER', 'X_COORDINATE', 'Y_COORDINATE'], rows: [['TP1', 'T', 5, 5]] },
  pins: { fields: ['PIN_NAME', 'PIN_X', 'PIN_Y', 'LAYER', 'PIN_TYPE', 'NET_NAME', 'PAD_SHAPE', 'PAD_SIZEX', 'PAD_SIZEY', 'HOLE_SIZE', 'HOLE_LEN'],
    rows: [['TP1_1', 5, 5, 'T', 'SMD', 'SIGNAL', 'C', 1.8, 1.8, 0, 0]] },
});
async function zipFile(files: Array<[string, string]>) {
  const zip = new JSZip();
  for (const [name, content] of files) zip.file(name, content);
  return Object.assign(await zip.generateAsync({ type: 'nodebuffer' }), { name: 'board.zip' }) as unknown as File;
}

describe('Gerber archive metadata sidecars', () => {
  it('never promotes AppleDouble files or __MACOSX folders to layer candidates', () => {
    const names = ['__MACOSX/._board.GKO', 'fabrication/._board.GKO', '__macosx/board.GKO',
      '__MACOSX/._board.GTP', 'fabrication/._board.GTP', 'fabrication\\._board.GBP',
      'fabrication/board.GKO', 'fabrication/board.GTP', 'fabrication/board.GBP'];
    expect(detectOutlineFiles(names).map(candidate => candidate.filename)).toEqual(['fabrication/board.GKO']);
    expect(detectPasteFiles(names).map(candidate => candidate.filename)).toEqual(['fabrication/board.GTP', 'fabrication/board.GBP']);
  });

  it('imports real outlines and paste when metadata entries precede the real files', async () => {
    const file = await zipFile([
      ['__MACOSX/._board.GKO', 'AppleDouble metadata'], ['__MACOSX/._board.GTP', 'AppleDouble metadata'],
      ['fabrication/board.GKO', outline], ['fabrication/board.GTP', paste],
    ]);
    const o = useGerberOutline(), s = useGerberStencil();
    const board = await o.processFile(file), stencil = await s.processFile(file);
    expect(o.error.value).toBeNull(); expect(s.error.value).toBeNull();
    expect(board).toMatchObject({ width: 10, height: 20, filename: 'fabrication/board.GKO' });
    expect(stencil).toMatchObject({ width: 10, height: 20, outlineSource: 'gerber',
      topPasteFile: 'fabrication/board.GTP', padCount: 1 });
  });

  it('uses the real optional manufacturing report instead of a __MACOSX copy', async () => {
    const file = await zipFile([
      ['__MACOSX/FlyingProbeTesting.json', '{}'], ['fabrication/board.GKO', outline],
      ['fabrication/board.GTP', paste], ['fabrication/FlyingProbeTesting.json', probe],
    ]);
    const state = useGerberStencil();
    const result = await state.processFile(file);
    expect(state.error.value).toBeNull();
    expect(result?.topPads[0].padRole).toBe('testpoint');
    expect(result?.topPads[0].padRoleSource).toBe('flying-probe');
  });
});
