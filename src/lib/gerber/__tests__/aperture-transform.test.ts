import { describe, expect, it } from "vitest";
import { extractPads } from "../pads";
import { extractOutline, parseGerber } from "../parser";

const HEADER = "%FSLAX34Y34*%\n%MOMM*%\n";
type Ring = Array<[number, number]>;
const bounds = (points: Ring) => [
  Math.min(...points.map(p => p[0])), Math.min(...points.map(p => p[1])),
  Math.max(...points.map(p => p[0])), Math.max(...points.map(p => p[1])),
];
const expectBounds = (points: Ring, expected: number[]) => {
  bounds(points).forEach((value, i) => expect(value).toBeCloseTo(expected[i], 6));
};
const rectangle = [
  "G01*", "X100000Y200000D02*", "X150000Y200000D01*",
  "X150000Y240000D01*", "X100000Y240000D01*", "X100000Y200000D01*",
];
const offsetMacro = "%AMOFFSET*21,1,2,1,3,1,0*1,0,0.4,3,1,0*%\n%ADD10OFFSET*%\nD10*\n";

// Ucamco Gerber format 2024.05 §4.9 (pp.85,87–88): LM/LR/LS act on
// aperture-local coordinates, around its origin, never on the flash/path point.
// Replaces old parser assertions which incorrectly transformed the board itself.
describe("Gerber aperture-local LM/LR/LS transformations", () => {
  it.each([
    ["%LMX*%", [6, 20.5, 8, 21.5], [7, 21]],
    ["%LMY*%", [12, 18.5, 14, 19.5], [13, 19]],
    ["%LMXY*%", [6, 18.5, 8, 19.5], [7, 19]],
    ["%LR90*%", [8.5, 22, 9.5, 24], [9, 23]],
    ["%LS2*%", [14, 21, 18, 23], [16, 22]],
    ["%LMX*%\n%LR90*%\n%LS2*%", [7, 12, 9, 16], [8, 14]],
  ] as const)("transforms asymmetric macro geometry at a fixed flash point: %s", (tf, expected, clearCenter) => {
    const result = extractPads(HEADER + offsetMacro + tf + "\nX100000Y200000D03*\nM02*");
    expect(result.pads).toHaveLength(1);
    const pad = result.pads[0];
    expect([pad.cx, pad.cy]).toEqual([10, 20]);
    expectBounds(pad.parts.find(p => p.polarity === "D")!.points, [...expected]);
    const clearBounds = bounds(pad.parts.find(p => p.polarity === "C")!.points);
    expect((clearBounds[0] + clearBounds[2]) / 2).toBeCloseTo(clearCenter[0]);
    expect((clearBounds[1] + clearBounds[3]) / 2).toBeCloseTo(clearCenter[1]);
  });

  it("transforms aperture holes around the unchanged flash position", () => {
    const result = extractPads(HEADER + [
      "%ADD10C,2X0.5*%", "D10*", "%LMX*%", "%LR90*%", "%LS2*%",
      "X100000Y200000D03*", "M02*",
    ].join("\n"));
    expectBounds(result.pads[0].parts[0].points, [8, 18, 12, 22]);
    expectBounds(result.pads[0].parts[0].holes![0], [9.5, 19.5, 10.5, 20.5]);
  });

  it("replaces modal values instead of accumulating and resets mirroring with LMN", () => {
    const result = extractPads(HEADER + offsetMacro + [
      "%LMX*%", "X100000Y200000D03*", "%LMY*%", "D03*",
      "%LMN*%", "%LR90*%", "D03*", "%LR180*%", "D03*",
      "%LR0*%", "%LS2*%", "D03*", "%LS3*%", "D03*", "%LS1*%", "D03*", "M02*",
    ].join("\n"));
    const expected = [
      [6, 20.5, 8, 21.5], [12, 18.5, 14, 19.5], [8.5, 22, 9.5, 24],
      [6, 18.5, 8, 19.5], [14, 21, 18, 23], [16, 21.5, 22, 24.5], [12, 20.5, 14, 21.5],
    ];
    expect(result.pads).toHaveLength(expected.length);
    result.pads.forEach((pad, i) => {
      expect([pad.cx, pad.cy]).toEqual([10, 20]);
      expectBounds(pad.parts[0].points, expected[i]);
    });
  });

  it("scales a circular drawing aperture but preserves its line path", () => {
    const result = extractPads(HEADER + [
      "%ADD10C,0.5*%", "D10*", "%LMX*%", "%LR90*%", "%LS2*%",
      "X100000Y200000D02*", "X150000Y200000D01*", "M02*",
    ].join("\n"));
    expect([result.pads[0].cx, result.pads[0].cy]).toEqual([12.5, 20]);
    expectBounds(result.pads[0].parts[0].points, [9.5, 19.5, 15.5, 20.5]);
  });

  it("keeps arc centerline and direction when mirroring and rotating the aperture", () => {
    const arc = ["X100000Y200000D02*", "G03X150000Y250000I0J50000D01*", "M02*"];
    const ordinary = extractPads(HEADER + "%ADD10C,0.5*%\nD10*\n" + arc.join("\n"));
    const transformed = extractPads(HEADER + "%ADD10C,0.25*%\nD10*\n%LMXY*%\n%LR90*%\n%LS2*%\n" + arc.join("\n"));
    expect(transformed.pads).toEqual(ordinary.pads);
  });

  it("keeps SR translations separate from aperture transforms for flashes and holes", () => {
    const result = extractPads(HEADER + [
      "%ADD10C,2X0.5*%", "D10*", "%LMX*%", "%LR90*%", "%LS2*%",
      "%SRX2Y2I5J8*%", "X100000Y200000D03*", "%SR*%", "M02*",
    ].join("\n"));
    expect(result.pads.map(p => [p.cx, p.cy])).toEqual([[10, 20], [15, 20], [10, 28], [15, 28]]);
    result.pads.forEach(p => {
      expectBounds(p.parts[0].points, [p.cx - 2, p.cy - 2, p.cx + 2, p.cy + 2]);
      expectBounds(p.parts[0].holes![0], [p.cx - 0.5, p.cy - 0.5, p.cx + 0.5, p.cy + 0.5]);
    });
  });

  it("does not apply aperture transforms to region contours or their SR copies", () => {
    const result = extractPads(HEADER + [
      "%LMXY*%", "%LR90*%", "%LS2*%", "%SRX2Y1I20J0*%",
      "G36*", ...rectangle, "G37*", "%SR*%", "M02*",
    ].join("\n"));
    expect(result.pads).toHaveLength(2);
    expectBounds(result.pads[0].parts[0].points, [10, 20, 15, 24]);
    expectBounds(result.pads[1].parts[0].points, [30, 20, 35, 24]);
  });

  it("ignores graphics and local transformations inside unsupported block aperture definitions", () => {
    const result = extractPads(HEADER + offsetMacro + [
      "%ABD20*%", "%LMX*%", "%LR90*%", "%LS2*%", "X-1000000Y-1000000D03*", "%AB*%",
      "X100000Y200000D03*", "M02*",
    ].join("\n"));
    expect(result.pads).toHaveLength(1);
    expect(result.skippedBlockGraphics).toBe(1);
    expectBounds(result.pads[0].parts[0].points, [12, 20.5, 14, 21.5]);
  });
});

describe("outline paths retain source coordinates under aperture transforms", () => {
  it.each(["%LMX*%", "%LMY*%", "%LMXY*%", "%LR90*%", "%LS2*%", "%LMY*%\n%LR90*%\n%LS2*%"])(
    "keeps the board and its dimensions unchanged under %s", tf => {
      const result = extractOutline(HEADER + tf + "\n" + rectangle.join("\n"));
      expectBounds(result.points, [10, 20, 15, 24]);
    },
  );

  it("retains modal transform metadata and recognizes the standard LMN reset", () => {
    const result = parseGerber(HEADER + [
      "%LMX*%", "X100000Y200000D02*", "%LMY*%", "X150000Y200000D01*",
      "%LMN*%", "X150000Y240000D01*", "M02*",
    ].join("\n"));
    expect(result.commands.map(c => c.tf)).toEqual([
      { mx: true, my: false, rot: 0, scale: 1 },
      { mx: false, my: true, rot: 0, scale: 1 }, undefined,
    ]);
  });

  it("does not disconnect a board path when aperture transforms change mid-contour", () => {
    const result = extractOutline(HEADER + [
      rectangle[0], rectangle[1], rectangle[2], "%LMY*%", rectangle[3],
      "%LMN*%", "%LR90*%", "%LS2*%", rectangle[4], "%LR0*%", "%LS1*%", rectangle[5],
    ].join("\n"));
    expect(result.points).toEqual(extractOutline(HEADER + rectangle.join("\n")).points);
  });

  it("preserves a circular outline's direction and radius", () => {
    const path = ["X100000Y200000D02*", "G03X100000Y200000I50000J0D01*"];
    const expected = extractOutline(HEADER + path.join("\n"));
    const transformed = extractOutline(HEADER + "%LMX*%\n%LR90*%\n%LS2*%\n" + path.join("\n"));
    expect(transformed.points).toEqual(expected.points);
    expectBounds(transformed.points, [10, 15, 20, 25]);
  });

  it("preserves repeated board positions, panel bounds and selection under transforms", () => {
    const input = HEADER + [
      "%LMXY*%", "%LR90*%", "%LS2*%", "%SRX2Y1I20J0*%", ...rectangle, "%SR*%", "M02*",
    ].join("\n");
    const result = extractOutline(input);
    expect(result.isPanel).toBe(true);
    expect(result.boards).toHaveLength(2);
    expectBounds(result.points, [10, 20, 35, 24]);
    expectBounds(result.boards![0].points, [10, 20, 15, 24]);
    expectBounds(result.boards![1].points, [30, 20, 35, 24]);
    expectBounds(extractOutline(input, { panel: false }).points, [10, 20, 15, 24]);
  });

  it("excludes block aperture definitions and their local coordinates from the board", () => {
    const result = extractOutline(HEADER + [
      "%ABD20*%", "%LMXY*%", "%LR90*%", "%LS2*%",
      "X-1000000Y-1000000D02*", "X1000000Y-1000000D01*", "X1000000Y1000000D01*",
      "X-1000000Y1000000D01*", "X-1000000Y-1000000D01*", "%AB*%", ...rectangle,
    ].join("\n"));
    expectBounds(result.points, [10, 20, 15, 24]);
    expect(result.isPanel).toBe(false);
  });
});

describe("Gerber region contour union", () => {
  it("preserves disconnected contours as separate openings with shared region polarity and attributes", () => {
    const result = extractPads(HEADER + [
      "%TO.C,U1*%", "%LPC*%", "G36*", ...rectangle,
      "X300000Y200000D02*", "X350000Y200000D01*", "X350000Y240000D01*",
      "X300000Y240000D01*", "X300000Y200000D01*", "G37*", "M02*",
    ].join("\n"));
    expect(result.regionCount).toBe(1);
    expect(result.pads).toHaveLength(2);
    expect(result.pads.map(p => [p.type, p.polarity, p.componentRef])).toEqual([
      ["region", "C", "U1"], ["region", "C", "U1"],
    ]);
    expectBounds(result.pads[0].parts[0].points, [10, 20, 15, 24]);
    expectBounds(result.pads[1].parts[0].points, [30, 20, 35, 24]);
    expect(result.pads.every(p => p.parts[0].holes === undefined)).toBe(true);
  });
});

// Ucamco Gerber 2024.05 §4.4.3–4.4.4 (pp.53–54): R/O take
// width X height [X hole diameter]; unlike P, there is no AD rotation field.
describe("standard R/O aperture holes and file units", () => {
  it.each(["R", "O"])("preserves an unrotated %s aperture without a hole", kind => {
    const result = extractPads(HEADER + `%ADD10${kind},2X1*%\nD10*\nX100000Y200000D03*`);
    expect(result.pads).toHaveLength(1);
    expectBounds(result.pads[0].parts[0].points, [9, 19.5, 11, 20.5]);
    expect(result.pads[0].parts[0].holes).toBeUndefined();
    if (kind === "R") {
      expect(result.pads[0].parts[0].points).toEqual([
        [9, 19.5], [11, 19.5], [11, 20.5], [9, 20.5], [9, 19.5],
      ]);
    }
  });

  it.each(["R", "O"])("interprets the third %s parameter as the central hole diameter", kind => {
    const result = extractPads(HEADER + `%ADD10${kind},2X1X0.5*%\nD10*\nX100000Y200000D03*`);
    const part = result.pads[0].parts[0];
    expectBounds(part.points, [9, 19.5, 11, 20.5]);
    expect(part.holes).toHaveLength(1);
    expectBounds(part.holes![0], [9.75, 19.75, 10.25, 20.25]);
  });

  it.each(["R", "O"])("transforms %s outer shape and hole together using LM/LR/LS", kind => {
    const result = extractPads(HEADER + [
      `%ADD10${kind},2X1X0.5*%`, "D10*", "%LMX*%", "%LR90*%", "%LS2*%",
      "X100000Y200000D03*", "M02*",
    ].join("\n"));
    const part = result.pads[0].parts[0];
    expectBounds(part.points, [9, 18, 11, 22]);
    expectBounds(part.holes![0], [9.5, 19.5, 10.5, 20.5]);
    expect(part.holes![0][0][0]).toBeCloseTo(10);
    expect(part.holes![0][0][1]).toBeCloseTo(19.5);
  });

  it.each(["R", "O"])("converts inch %s aperture dimensions and hole diameter exactly once", kind => {
    const result = extractPads([
      "%FSLAX24Y24*%", "%MOIN*%", `%ADD10${kind},0.1X0.05X0.02*%`, "D10*",
      "%LMX*%", "%LR90*%", "%LS2*%", "X10000Y20000D03*", "M02*",
    ].join("\n"));
    const pad = result.pads[0];
    expect(pad.cx).toBeCloseTo(25.4);
    expect(pad.cy).toBeCloseTo(50.8);
    expectBounds(pad.parts[0].points, [24.13, 48.26, 26.67, 53.34]);
    expectBounds(pad.parts[0].holes![0], [24.892, 50.292, 25.908, 51.308]);
  });

  it("converts inch circular drawing widths without scaling the path twice", () => {
    const result = extractPads([
      "%FSLAX24Y24*%", "%MOIN*%", "%ADD10C,0.02*%", "D10*", "%LS2*%",
      "X10000Y20000D02*", "X20000Y20000D01*", "M02*",
    ].join("\n"));
    expectBounds(result.pads[0].parts[0].points, [24.892, 50.292, 51.308, 51.308]);
  });

  it("converts inch macro lengths while preserving dimensionless rotation and vertex count", () => {
    const result = extractPads([
      "%FSLAX24Y24*%", "%MOIN*%", "%AMRECT*21,1,0.1,0.05,0.1,0,90*%",
      "%ADD10RECT*%", "%ADD11P,0.1X4X45*%", "D10*", "X10000Y20000D03*",
      "D11*", "X20000Y20000D03*", "M02*",
    ].join("\n"));
    expectBounds(result.pads[0].parts[0].points, [24.765, 52.07, 26.035, 54.61]);
    const polygon = result.pads[1].parts[0].points;
    expect(polygon).toHaveLength(5);
    expect(polygon[0][0]).toBeCloseTo(50.8 + 1.27 / Math.sqrt(2));
    expect(polygon[0][1]).toBeCloseTo(50.8 + 1.27 / Math.sqrt(2));
  });

  it("keeps inch SR openings aligned with their board outlines", () => {
    const source = [
      "%FSLAX24Y24*%", "%MOIN*%", "%ADD10R,0.1X0.05X0.02*%", "D10*",
      "%LMX*%", "%LR90*%", "%LS2*%", "%SRX2Y2I0.5J0.75*%",
    ];
    const pads = extractPads([...source, "X10000Y20000D03*", "%SR*%", "M02*"].join("\n")).pads;
    const outline = extractOutline([...source,
      "G01*", "X9000Y19000D02*", "X11000Y19000D01*", "X11000Y21000D01*",
      "X9000Y21000D01*", "X9000Y19000D01*", "%SR*%", "M02*",
    ].join("\n"));
    const centers = pads.map(p => [p.cx, p.cy]);
    const expected = [[25.4, 50.8], [38.1, 50.8], [25.4, 69.85], [38.1, 69.85]];
    centers.forEach((center, i) => center.forEach((v, j) => expect(v).toBeCloseTo(expected[i][j])));
    expect(outline.boards).toHaveLength(4);
    const boardCenters = outline.boards!.map(board => {
      const b = bounds(board.points);
      return [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
    });
    for (const [cx, cy] of centers) {
      expect(boardCenters.some(([x, y]) => Math.abs(x - cx) < 1e-6 && Math.abs(y - cy) < 1e-6)).toBe(true);
    }
    pads.forEach(pad => {
      expectBounds(pad.parts[0].points, [pad.cx - 1.27, pad.cy - 2.54, pad.cx + 1.27, pad.cy + 2.54]);
      expectBounds(pad.parts[0].holes![0], [pad.cx - 0.508, pad.cy - 0.508, pad.cx + 0.508, pad.cy + 0.508]);
    });
  });
});
