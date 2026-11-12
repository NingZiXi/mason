import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { useGerberStencil } from "../useGerberStencil";
import { i18n } from '../../i18n';

const paste = (x: number, y: number) => `%FSLAX24Y24*%
%MOMM*%
%ADD10R,2X2*%
D10*
X${x * 10000}Y${y * 10000}D03*
M02*`;

async function importZip(files: Record<string, string>) {
  const zip = new JSZip();
  for (const [name, text] of Object.entries(files)) zip.file(name, text);
  // JSZip accepts a Buffer; processFile only needs the ZIP filename.
  const file = Object.assign(await zip.generateAsync({ type: "nodebuffer" }), { name: "board.zip" });
  const state = useGerberStencil();
  const parsed = await state.processFile(file as unknown as File);
  expect(state.error.value).toBeNull();
  expect(state.result.value).not.toBeNull();
  expect(parsed).toEqual(state.result.value);
  return state.result.value!;
}

describe("stencil fallback board bounds", () => {
  const macroPaste = (body: string) => [
    '%FSLAX34Y34*%', '%MOMM*%', `%AMX*${body}*%`, '%ADD10X*%', 'D10*', 'X0Y0D03*', 'M02*',
  ].join('\n');

  it('ignores remote clear macro primitives when estimating a standalone board boundary', async () => {
    const state = useGerberStencil();
    const content = macroPaste('21,1,2,2,0,0,0*21,0,2,2,1000,0,0');
    const result = await state.processFile({ name: 'board.gtp', text: async () => content } as File);
    expect(state.error.value).toBeNull();
    expect(result?.width).toBeCloseTo(2.2);
    expect(result?.height).toBeCloseTo(2.2);
    expect(result?.bboxCenter).toEqual({ x: 0, y: 0 });
    // Clear geometry stays attached to the aperture for the manufacturing engine.
    expect(result?.topPads[0].parts.map(part => part.polarity)).toEqual(['D', 'C']);
    expect(result?.topPads[0].cx).toBe(0);
  });

  it('ignores image clear objects when estimating a standalone board boundary', async () => {
    const state = useGerberStencil();
    const content = paste(0, 0).replace('M02*', '%LPC*%\nX10000000Y0D03*\nM02*');
    const result = await state.processFile({ name: 'board.gtp', text: async () => content } as File);
    expect(state.error.value).toBeNull();
    expect(result?.width).toBeCloseTo(2.2);
    expect(result?.height).toBeCloseTo(2.2);
    expect(result?.bboxCenter).toEqual({ x: 0, y: 0 });
  });

  it.each([
    ['only image clear objects', () => paste(0, 0).replace('D10*', '%LPC*%\nD10*')],
    ['only clear macro primitives', () => macroPaste('21,0,2,2,0,0,0')],
    ['empty dark macro primitives', () => macroPaste('21,1,0,2,0,0,0')],
  ] as const)('rejects a fallback import containing %s', async (_name, content) => {
    const state = useGerberStencil();
    const result = await state.processFile({ name: 'board.gtp', text: async () => content() } as File);
    expect(result).toBeNull();
    expect(state.result.value).toBeNull();
    expect(state.error.value).toBe(i18n.global.t('gerber.noPads'));
    expect(state.loading.value).toBe(false);
  });

  it('keeps an explicit board outline authoritative when macro clear geometry is remote', async () => {
    const result = await importZip({
      'board.gtp': macroPaste('21,1,2,2,0,0,0*21,0,2,2,1000,0,0'),
      'board.gko': '%FSLAX34Y34*%\n%MOMM*%\nG01*\nX-20000Y-20000D02*\nX20000Y-20000D01*\nX20000Y20000D01*\nX-20000Y20000D01*\nX-20000Y-20000D01*\nM02*',
    });
    expect(result.outlineSource).toBe('gerber');
    expect(result.width).toBeCloseTo(4);
    expect(result.height).toBeCloseTo(4);
    expect(result.topPads).toHaveLength(1);
  });

  it.each([
    ['board.GPT', 'top'], ['board.GPB', 'bottom'],
    ['board-B_Paste.gbr', 'bottom'], ['B_Paste.gbr', 'bottom'],
    ['board-bottom-paste.gbr', 'bottom'], ['board-F_Paste.gbr', 'top'],
    ['F_Paste.gbr', 'top'], ['paste.gbr', 'top'],
  ] as const)('uses the same physical face for a standalone file and ZIP: %s', async (name, side) => {
    const content = paste(20, 10);
    const state = useGerberStencil();
    const standalone = await state.processFile({ name, text: async () => content } as File);
    expect(state.error.value).toBeNull();
    expect(standalone).not.toBeNull();
    const archived = await importZip({ [name]: content });
    expect(standalone!.topPads).toEqual(archived.topPads);
    expect(standalone!.bottomPads).toEqual(archived.bottomPads);
    expect(side === 'top' ? standalone!.topPads : standalone!.bottomPads).toHaveLength(1);
    expect(side === 'top' ? standalone!.bottomPads : standalone!.topPads).toHaveLength(0);
  });

  it('keeps a bottom paste file on the bottom when exported under a top-named directory', async () => {
    const result = await importZip({ 'top-export/board-bottom-paste.gbr': paste(3, 2) });
    expect(result.topPads).toHaveLength(0);
    expect(result.bottomPads).toHaveLength(1);
  });

  it('does not interpret an outline as paste when its ZIP folder is named paste', async () => {
    const result = await importZip({
      'paste-export/board.GKO': '%FSLAX24Y24*%\n%MOMM*%\n%ADD10C,0.1*%\nD10*\nX0Y0D02*\nX100000Y0D01*\nX100000Y100000D01*\nX0Y100000D01*\nX0Y0D01*\nM02*',
      'paste-export/board.GPT': paste(3, 2),
    });
    expect(result.topPasteFile).toBe('paste-export/board.GPT');
    expect(result.topPads).toHaveLength(1);
    expect(result.outlineSource).toBe('gerber');
    expect(result.width).toBeCloseTo(10);
  });

  it("keeps supplementary test-pad evidence through ZIP import and centering", async () => {
    const metadata = JSON.stringify({ lengthUnit: "mm",
      components: { fields: ["COMPONENT_NAME", "LAYER", "X_COORDINATE", "Y_COORDINATE"], rows: [["5V", "T", 3, 2]] },
      pins: { fields: ["PIN_NAME", "PIN_X", "PIN_Y", "LAYER", "PIN_TYPE", "NET_NAME", "PAD_SHAPE", "PAD_SIZEX", "PAD_SIZEY", "HOLE_SIZE", "HOLE_LEN"],
        rows: [["5V_1", 3, 2, "T", "SMD", "5V_SYS", "C", 1.8, 1.8, 0, 0]] },
    });
    const result = await importZip({ "top.GTP": paste(3, 2).replace("%ADD10R,2X2*%", "%ADD10C,1.8*%"),
      "fabrication/FlyingProbeTesting.json": metadata });
    expect(result.topPads[0].padRole).toBe("testpoint");
    expect(result.topPads[0].padRoleSource).toBe("flying-probe");
    expect(result.variants.panel.topPads?.[0].padRoleSource).toBe("flying-probe");
    expect(result.topPads[0].cx).toBeCloseTo(0);
  });

  it("ignores a malformed optional netlist without breaking Gerber import", async () => {
    const result = await importZip({ "top.GTP": paste(0, 0), "FlyingProbeTesting.json": "{" });
    expect(result.topPads).toHaveLength(1);
    expect(result.topPads[0].padRole).toBeUndefined();
  });
  it("imports different boards with separate top and bottom pad variants", async () => {
    const result = await importZip({
      "top.GTP": paste(3, 2), "bottom.GBP": paste(24, 4),
      "board.GKO": `%FSLAX24Y24*%\n%MOMM*%\nG01*\n
X0Y0D02*\nX100000Y0D01*\nX100000Y80000D01*\nX0Y80000D01*\nX0Y0D01*\n
X200000Y0D02*\nX260000Y0D01*\nX260000Y50000D01*\nX200000Y50000D01*\nX200000Y0D01*\nM02*`,
    });
    expect(result.isPanel).toBe(true);
    expect(result.variants.boards).toHaveLength(2);
    const first = result.variants.boards!.find((b) => b.width === 10)!;
    const second = result.variants.boards!.find((b) => b.width === 6)!;
    expect(first.topPads?.map((p) => [p.cx, p.cy])).toEqual([[-2, -2]]);
    expect(first.bottomPads).toHaveLength(0);
    expect(second.topPads).toHaveLength(0);
    expect(second.bottomPads?.map((p) => [p.cx, p.cy])).toEqual([[1, 1.5]]);
    expect(result.width).toBe(26);
    expect(result.padCount).toBe(2);
  });

  it.each([false, true])("preserves both faces when the board outline is absent or invalid (%s)", async invalid => {
    const files: Record<string, string> = { "top.GTP": paste(0, 0), "bottom.GBP": paste(20, 10) };
    if (invalid) files["board.GKO"] = "M02*";
    const result = await importZip(files);
    expect(result.padCount).toBe(2);
    expect(result.topPads).toHaveLength(1);
    expect(result.bottomPads).toHaveLength(1);
    expect(result.width).toBeCloseTo(22.2);
    expect(result.height).toBeCloseTo(12.2);
    expect(result.bboxCenter).toEqual({ x: 10, y: 5 });
    expect([result.topPads[0].cx, result.topPads[0].cy]).toEqual([-10, -5]);
    expect([result.bottomPads[0].cx, result.bottomPads[0].cy]).toEqual([10, 5]);
    expect(result.variants.single).toEqual(result.variants.panel);
    expect(result.outlineSource).toBe('pads-bounds');
    expect(result.outlineFallbackReason).toBe(invalid ? 'invalid' : 'missing');
  });

  it.each(["top.GTP", "bottom.GBP"])("keeps single-face fallback imports working: %s", async name => {
    const result = await importZip({ [name]: paste(20, 10) });
    expect(result.padCount).toBe(1);
    expect(result.width).toBeCloseTo(2.2);
    expect(result.height).toBeCloseTo(2.2);
    const pads = [...result.topPads, ...result.bottomPads];
    expect([pads[0].cx, pads[0].cy]).toEqual([0, 0]);
    expect(result.outlineSource).toBe('pads-bounds');
    expect(result.outlineFallbackReason).toBe('missing');
  });

  it("uses a valid board outline as the authoritative boundary", async () => {
    const result = await importZip({
      "top.GTP": paste(0, 0), "bottom.GBP": paste(20, 10),
      "board.GKO": `%FSLAX24Y24*%
%MOMM*%
%ADD10C,0.1*%
D10*
X-20000Y-20000D02*
X20000Y-20000D01*
X20000Y20000D01*
X-20000Y20000D01*
X-20000Y-20000D01*
M02*`,
    });
    expect(result.width).toBeCloseTo(4);
    expect(result.height).toBeCloseTo(4);
    expect(result.topPads).toHaveLength(1);
    expect(result.bottomPads).toHaveLength(0);
    expect(result.outlineSource).toBe('gerber');
    expect(result.outlineFallbackReason).toBeUndefined();
  });

  it('labels an empty supplied board outline as invalid rather than missing', async () => {
    const result = await importZip({ 'top.GTP': paste(0, 0), 'board.GKO': '' });
    expect(result.outlineSource).toBe('pads-bounds');
    expect(result.outlineFallbackReason).toBe('invalid');
  });
});
