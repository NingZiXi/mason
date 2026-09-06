import { describe, it, expect } from "vitest";
import { extractPads } from "../pads";

const HEADER = "%FSLAX34Y34*%\n%MOMM*%\n";

/** 取 pad 第一个 dark 部件的外轮廓 */
const ring = (pad: { parts: { polarity: string; points: Array<[number, number]> }[] }) =>
  pad.parts.find((p) => p.polarity === "D")!.points;

describe("extractPads 标准光圈", () => {
  it("C/R/O flash 全部解析", () => {
    const g = HEADER + [
      "%ADD10C,0.5*%",
      "%ADD11R,1.0X0.6*%",
      "%ADD12O,2.0X0.8*%",
      "D10*", "X100000Y100000D03*",
      "D11*", "X200000Y100000D03*",
      "D12*", "X300000Y100000D03*",
      "M02*",
    ].join("\n");
    const r = extractPads(g);
    expect(r.pads).toHaveLength(3);
    expect(r.flashCount).toBe(3);
    expect(r.pads.map((p) => p.type)).toEqual(["circle", "rect", "obround"]);
    expect(r.pads[1].cx).toBeCloseTo(20, 6);
    expect(r.skippedFlashes).toBe(0);
  });

  it("R 第3参数 = 旋转角", () => {
    const g = HEADER + [
      "%ADD10R,2.0X1.0X45*%",
      "D10*",
      "X0Y0D03*",
      "M02*",
    ].join("\n");
    const r = extractPads(g);
    expect(r.pads).toHaveLength(1);
    // 未旋转角点 (1, 0.5) 旋转 45° → (0.3536, 1.0607)
    const corner = ring(r.pads[0]).find(
      ([x, y]) => Math.abs(x - 0.35355) < 1e-3 && Math.abs(y - 1.06066) < 1e-3
    );
    expect(corner).toBeDefined();
  });

  it("P 正多边形光圈", () => {
    const g = HEADER + [
      "%ADD10P,1.0X6X30*%",
      "D10*",
      "X0Y0D03*",
      "M02*",
    ].join("\n");
    const r = extractPads(g);
    expect(r.pads).toHaveLength(1);
    expect(r.pads[0].type).toBe("polygon");
    const [x0, y0] = ring(r.pads[0])[0];
    expect(x0).toBeCloseTo(0.4330127, 4);
    expect(y0).toBeCloseTo(0.25, 4);
  });

  it("C 光圈带中心孔 → 部件带 holes", () => {
    const g = HEADER + [
      "%ADD10C,1.0X0.5*%",
      "D10*",
      "X0Y0D03*",
      "M02*",
    ].join("\n");
    const r = extractPads(g);
    expect(r.pads).toHaveLength(1);
    const part = r.pads[0].parts[0];
    expect(part.holes).toBeDefined();
    expect(part.holes!.length).toBe(1);
  });

  it("独立 D03 行不再被误判为光圈选择(修复针脚丢失)", () => {
    const g = HEADER + [
      "%ADD10C,0.5*%",
      "D10*",
      "X100000Y100000D02*",
      "D03*",
      "X200000Y100000D03*",
      "M02*",
    ].join("\n");
    const r = extractPads(g);
    expect(r.flashCount).toBe(2);
    expect(r.skippedFlashes).toBe(0);
  });

  it("行内光圈选择 D10X..Y..D03", () => {
    const g = HEADER + [
      "%ADD10C,0.5*%",
      "D10X100000Y100000D03*",
      "M02*",
    ].join("\n");
    const r = extractPads(g);
    expect(r.pads).toHaveLength(1);
    expect(r.pads[0].cx).toBeCloseTo(10, 6);
  });

  it("G54 旧式光圈选择", () => {
    const g = HEADER + [
      "%ADD10C,0.5*%",
      "G54D10*",
      "X100000Y100000D03*",
      "M02*",
    ].join("\n");
    const r = extractPads(g);
    expect(r.pads).toHaveLength(1);
    expect(r.skippedFlashes).toBe(0);
  });

  it("光圈缺失的 flash 计入 skippedFlashes", () => {
    const g = HEADER + [
      "D99*",
      "X100000Y100000D03*",
      "M02*",
    ].join("\n");
    const r = extractPads(g);
    expect(r.pads).toHaveLength(0);
    expect(r.skippedFlashes).toBe(1);
  });
});

describe("extractPads D01 描线", () => {
  it("直线 → 胶囊焊盘", () => {
    const g = HEADER + [
      "%ADD10C,0.3*%",
      "D10*",
      "X0Y0D02*",
      "X100000Y0D01*",
      "M02*",
    ].join("\n");
    const r = extractPads(g);
    expect(r.pads).toHaveLength(1);
    expect(r.pads[0].type).toBe("line");
    const xs = ring(r.pads[0]).map((p) => p[0]);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(10.3, 3);
  });

  it("G75 圆弧描线 → 离散为多段胶囊", () => {
    // 四分之一圆弧:圆心 (0,0),半径 10,从 (10,0) 逆时针到 (0,10)
    const g = HEADER + [
      "%ADD10C,0.3*%",
      "D10*",
      "G75*",
      "X100000Y0D02*",
      "G03X0Y100000I-100000J0D01*",
      "M02*",
    ].join("\n");
    const r = extractPads(g);
    expect(r.lineCount).toBe(1);
    expect(r.pads.length).toBeGreaterThanOrEqual(2);
    expect(r.pads.every((p) => p.type === "arc")).toBe(true);
    // 弧上点 (7.07, 7.07) 附近应有胶囊中心
    const near = r.pads.some((p) =>
      Math.hypot(p.cx - 7.071, p.cy - 7.071) < 1.5
    );
    expect(near).toBe(true);
  });
});

describe("extractPads 宏光圈(photoplotter 语义)", () => {
  it("KiCad 风格 ROUNDRECT 宏:$n 表达式展开", () => {
    // 宏体用 $1/2 等表达式定义圆角矩形(KiCad 实际输出形态)
    const g = HEADER + [
      "%AMRoundRect*",
      "4,1,4,-$1/2,-$2/2,$1/2,-$2/2,$1/2,$2/2,-$1/2,$2/2,0*",
      "%",
      "%ADD10RoundRect,0.800000X0.500000X0*%",
      "D10*",
      "X100000Y100000D03*",
      "M02*",
    ].join("\n");
    const r = extractPads(g);
    expect(r.pads).toHaveLength(1);
    expect(r.pads[0].type).toBe("macro");
    const pts = ring(r.pads[0]);
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    // w=0.8, h=0.5 → x ∈ [9.6, 10.4], y ∈ [9.75, 10.25]
    expect(Math.min(...xs)).toBeCloseTo(9.6, 3);
    expect(Math.max(...xs)).toBeCloseTo(10.4, 3);
    expect(Math.min(...ys)).toBeCloseTo(9.75, 3);
    expect(Math.max(...ys)).toBeCloseTo(10.25, 3);
  });

  it("宏原语 21 中心矩形 + 表达式 ( $1 + $2 ) / 2", () => {
    const g = HEADER + [
      "%AMTEST*",
      "21,1,($1+$2)/2,($1+$2)/2,0,0,0*",
      "%",
      "%ADD10TEST,1.0X2.0*%",
      "D10*",
      "X0Y0D03*",
      "M02*",
    ].join("\n");
    const r = extractPads(g);
    expect(r.pads).toHaveLength(1);
    const pts = ring(r.pads[0]);
    const xs = pts.map((p) => p[0]);
    // ($1+$2)/2 = 1.5 → x ∈ [-0.75, 0.75]
    expect(Math.min(...xs)).toBeCloseTo(-0.75, 3);
    expect(Math.max(...xs)).toBeCloseTo(0.75, 3);
  });

  it("thermal 热焊盘:暗环 + 擦除开口(极性 C)", () => {
    const g = HEADER + [
      "%AMTHERM*",
      "7,0,0,2.0,1.0,0.3,0*",
      "%",
      "%ADD10THERM,2.0X1.0X0.3X0*%",
      "D10*",
      "X0Y0D03*",
      "M02*",
    ].join("\n");
    const r = extractPads(g);
    expect(r.pads).toHaveLength(1);
    const parts = r.pads[0].parts;
    // 1 个暗环(带内孔) + 2 个擦除开口
    const dark = parts.filter((p) => p.polarity === "D");
    const clear = parts.filter((p) => p.polarity === "C");
    expect(dark).toHaveLength(1);
    expect(dark[0].holes).toBeDefined();
    expect(clear.length).toBeGreaterThanOrEqual(2);
  });

  it("单行宏定义 %AMNAME*...*%", () => {
    const g = HEADER + [
      "%AMCIRC*1,1,$1,0,0,0*%",
      "%ADD10CIRC,0.6*%",
      "D10*",
      "X100000Y100000D03*",
      "M02*",
    ].join("\n");
    const r = extractPads(g);
    expect(r.pads).toHaveLength(1);
    const pts = ring(r.pads[0]);
    const xs = pts.map((p) => p[0]);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(0.6, 3);
  });

  it("宏定义块跨行时 %ADD 不被吞", () => {
    const g = HEADER + [
      "%AMTHERMAL80*",
      "1,1,0.1,0,0,0.05*",
      "1,1,0.1,0,0,0.05*",
      "%",
      "%ADD10C,0.5*%",
      "D10*",
      "X100000Y100000D03*",
      "M02*",
    ].join("\n");
    const r = extractPads(g);
    expect(r.pads).toHaveLength(1);
    expect(r.pads[0].cx).toBeCloseTo(10, 6);
  });

  it("宏原语曝光关闭(exposure=0)→ 极性 C", () => {
    const g = HEADER + [
      "%AMHOLE*",
      "21,1,2.0,2.0,0,0,0*",
      "1,0,1.0,0,0,0*",
      "%",
      "%ADD10HOLE*%",
      "D10*",
      "X0Y0D03*",
      "M02*",
    ].join("\n");
    const r = extractPads(g);
    expect(r.pads).toHaveLength(1);
    const polarities = r.pads[0].parts.map((p) => p.polarity).sort();
    expect(polarities).toEqual(["C", "D"]);
  });
});

describe("extractPads G36/G37 区域", () => {
  it("区域多边形 → 焊盘", () => {
    const g = HEADER + [
      "G36*",
      "X100000Y100000D02*",
      "X200000Y100000D01*",
      "X200000Y150000D01*",
      "X100000Y150000D01*",
      "G37*",
      "G36*",
      "X-100000Y-100000D02*",
      "X-50000Y-100000D01*",
      "X-50000Y-50000D01*",
      "X-100000Y-50000D01*",
      "G37*",
      "M02*",
    ].join("\n");
    const r = extractPads(g);
    expect(r.pads).toHaveLength(2);
    expect(r.regionCount).toBe(2);
    const xs = ring(r.pads[0]).map((p) => p[0]);
    expect(Math.min(...xs)).toBeCloseTo(10, 3);
    expect(Math.max(...xs)).toBeCloseTo(20, 3);
  });

  it("区域多轮廓:首轮廓为外轮廓,其余为内孔", () => {
    const g = HEADER + [
      "G36*",
      "X0Y0D02*",
      "X100000Y0D01*",
      "X100000Y100000D01*",
      "X0Y100000D01*",
      "X25000Y25000D02*",
      "X75000Y25000D01*",
      "X75000Y75000D01*",
      "X25000Y75000D01*",
      "G37*",
      "M02*",
    ].join("\n");
    const r = extractPads(g);
    expect(r.pads).toHaveLength(1);
    const part = r.pads[0].parts[0];
    expect(part.holes).toBeDefined();
    expect(part.holes!.length).toBe(1);
  });

  it("区域内 G75 圆弧离散", () => {
    // 四分之一圆弧区域:圆心(10,10),半径 5
    const g = HEADER + [
      "G75*",
      "G36*",
      "X150000Y100000D02*",
      "G03X100000Y150000I-50000J0D01*",
      "G01X150000Y150000D01*",
      "G37*",
      "M02*",
    ].join("\n");
    const r = extractPads(g);
    expect(r.pads).toHaveLength(1);
    const pts = ring(r.pads[0]);
    // 弧离散后点数远超 3(直线三角只有 3-4 点)
    expect(pts.length).toBeGreaterThan(6);
  });

  it("区域裸坐标(无 D code)延续 D01 画线", () => {
    const g = HEADER + [
      "G36*",
      "X100000Y100000D02*",
      "X200000Y100000D01*",
      "X200000Y150000",
      "G37*",
      "M02*",
    ].join("\n");
    const r = extractPads(g);
    expect(r.pads).toHaveLength(1);
    const ys = ring(r.pads[0]).map((p) => p[1]);
    expect(Math.max(...ys)).toBeCloseTo(15, 3);
  });
});

describe("extractPads 图像控制", () => {
  it("%SR 步进重复:焊盘按步距复制", () => {
    const g = HEADER + [
      "%ADD10C,0.5*%",
      "%SRX3Y1X5.0Y0*%",
      "D10*",
      "X0Y0D03*",
      "%SR*%",
      "M02*",
    ].join("\n");
    const r = extractPads(g);
    expect(r.pads).toHaveLength(3);
    const cxs = r.pads.map((p) => p.cx).sort((a, b) => a - b);
    expect(cxs[0]).toBeCloseTo(0, 6);
    expect(cxs[1]).toBeCloseTo(5, 6);
    expect(cxs[2]).toBeCloseTo(10, 6);
  });

  it("%LPC 清极性:焊盘 polarity=C", () => {
    const g = HEADER + [
      "%ADD10C,0.5*%",
      "%LPC*%",
      "D10*",
      "X0Y0D03*",
      "M02*",
    ].join("\n");
    const r = extractPads(g);
    expect(r.pads).toHaveLength(1);
    expect(r.pads[0].polarity).toBe("C");
  });

  it("%LM 镜像:焊盘顶点 Y 翻转", () => {
    const g = HEADER + [
      "%ADD10R,1.0X1.0*%",
      "%LMX*%",
      "D10*",
      "X100000Y100000D03*",
      "M02*",
    ].join("\n");
    const r = extractPads(g);
    expect(r.pads).toHaveLength(1);
    // flash 位置 y=10 镜像后 y=-10
    expect(r.pads[0].cy).toBeCloseTo(-10, 6);
  });

  it("%AB 光圈块内容被跳过并计数", () => {
    const g = HEADER + [
      "%ADD10C,0.5*%",
      "D10*",
      "%ABBLOCK1*",
      "X100000Y100000D03*",
      "%AB*%",
      "X0Y0D03*",
      "M02*",
    ].join("\n");
    const r = extractPads(g);
    expect(r.pads).toHaveLength(1);
    expect(r.pads[0].cx).toBeCloseTo(0, 6);
    expect(r.skippedBlockGraphics).toBe(1);
  });
});
