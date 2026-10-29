import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { useGerberStencil } from "../useGerberStencil";

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
  await state.processFile(file as unknown as File);
  expect(state.error.value).toBeNull();
  expect(state.result.value).not.toBeNull();
  return state.result.value!;
}

describe("stencil fallback board bounds", () => {
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
  });

  it.each(["top.GTP", "bottom.GBP"])("keeps single-face fallback imports working: %s", async name => {
    const result = await importZip({ [name]: paste(20, 10) });
    expect(result.padCount).toBe(1);
    expect(result.width).toBeCloseTo(2.2);
    expect(result.height).toBeCloseTo(2.2);
    const pads = [...result.topPads, ...result.bottomPads];
    expect([pads[0].cx, pads[0].cy]).toEqual([0, 0]);
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
  });
});
