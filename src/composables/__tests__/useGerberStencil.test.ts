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
