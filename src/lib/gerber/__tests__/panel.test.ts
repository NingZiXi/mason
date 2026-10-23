/**
 * 拼版(%SR 步进重复)支持回归测试
 *
 * 覆盖嘉立创 EasyEDA Pro 的拼版导出:板框/锡膏层在 %SR 块内只画一块,
 * 由 %SRXnYnI<列距>J<行距>*% 声明阵列,需展开成整版。
 */
import { describe, it, expect } from "vitest";
import { extractOutline, parseGerber } from "../parser";
import { extractPads } from "../pads";

const HEADER = "%FSLAX24Y24*%\n%MOMM*%\nG01*\n";
const PAD_HEADER = "%FSLAX24Y24*%\n%MOMM*%\n%ADD10C,0.5*%\n";

/** 10 × 8 mm 单板轮廓(places=[2,4]) */
const BOARD = [
  "X0Y0D02*",
  "X100000Y0D01*",
  "X100000Y80000D01*",
  "X0Y80000D01*",
  "X0Y0D01*",
].join("\n");

describe("%SR 步进重复", () => {
  it("I/J 写法展开 2×2 阵列,整体板框 = 阵列外接范围", () => {
    const g =
      HEADER +
      "%SRX2Y2I120000J100000*%\n" +
      BOARD +
      "\n%SR*%\nM02*\n";
    const o = extractOutline(g);
    expect(o.isPanel).toBe(true);
    expect(o.panelGrid).toEqual({ nx: 2, ny: 2 });
    // 列距 12mm、行距 10mm → 0..22 × 0..18
    expect(o.bbox.minX).toBeCloseTo(0, 3);
    expect(o.bbox.maxX).toBeCloseTo(22, 3);
    expect(o.bbox.minY).toBeCloseTo(0, 3);
    expect(o.bbox.maxY).toBeCloseTo(18, 3);
    expect(o.points).toHaveLength(5); // 矩形外框
    expect(o.holes).toHaveLength(0);
  });

  it("X/Y 间距写法同样支持", () => {
    const g =
      HEADER +
      "%SRX2Y1X120000Y0*%\n" +
      BOARD +
      "\n%SR*%\nM02*\n";
    const o = extractOutline(g);
    expect(o.panelGrid).toEqual({ nx: 2, ny: 1 });
    expect(o.bbox.maxX).toBeCloseTo(22, 3);
    expect(o.bbox.maxY).toBeCloseTo(8, 3);
  });

  it("%SR 参数行不会被当成坐标命令", () => {
    const g =
      HEADER +
      "%SRX2Y2I120000J100000*%\n" +
      BOARD +
      "\n%SR*%\nM02*\n";
    const r = parseGerber(g);
    // 5 条轮廓命令 × 4 份
    expect(r.commands).toHaveLength(20);
    expect(r.srGrid).toEqual({ nx: 2, ny: 2 });
  });

  it("拼版外框包含 %SR 块外的工艺边 / V-CUT 框", () => {
    // 工艺边框:整体 0..26 × 0..22,块内单板 0..10 × 0..8
    const g =
      HEADER +
      "X0Y0D02*\nX260000Y0D01*\nX260000Y220000D01*\nX0Y220000D01*\nX0Y0D01*\n" +
      "%SRX2Y2I120000J100000*%\n" +
      BOARD +
      "\n%SR*%\nM02*\n";
    const o = extractOutline(g);
    expect(o.isPanel).toBe(true);
    expect(o.bbox.maxX).toBeCloseTo(26, 3);
    expect(o.bbox.maxY).toBeCloseTo(22, 3);
  });

  it("未使用 %SR 的等大独立轮廓也识别为拼版", () => {
    // 两块 10×8,横向排列(间距 2mm)
    const g =
      HEADER +
      BOARD +
      "\nX120000Y0D02*\nX220000Y0D01*\nX220000Y80000D01*\nX120000Y80000D01*\nX120000Y0D01*\nM02*\n";
    const o = extractOutline(g);
    expect(o.isPanel).toBe(true);
    expect(o.bbox.maxX).toBeCloseTo(22, 3);
    expect(o.bbox.maxY).toBeCloseTo(8, 3);
  });

  it("单板文件不受影响(isPanel = false,保持原外框)", () => {
    const o = extractOutline(HEADER + BOARD + "\nM02*\n");
    expect(o.isPanel).toBe(false);
    expect(o.bbox.maxX).toBeCloseTo(10, 3);
    expect(o.bbox.maxY).toBeCloseTo(8, 3);
  });
});

describe("锡膏层 %SR 展开", () => {
  it("I/J 写法:单个 flash 复制成 2×2 共 4 个焊盘", () => {
    const g =
      PAD_HEADER +
      "%SRX2Y2I120000J100000*%\n" +
      "D10*\nX50000Y50000D03*\n" +
      "%SR*%\nM02*\n";
    const r = extractPads(g);
    expect(r.pads).toHaveLength(4);
    const centers = r.pads
      .map((p) => [Number(p.cx.toFixed(3)), Number(p.cy.toFixed(3))])
      .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    expect(centers).toEqual([
      [5, 5],
      [5, 15],
      [17, 5],
      [17, 15],
    ]);
  });

  it("X/Y 间距写法同样展开", () => {
    const g =
      PAD_HEADER +
      "%SRX2Y1X120000Y0*%\n" +
      "D10*\nX50000Y50000D03*\n" +
      "%SR*%\nM02*\n";
    const r = extractPads(g);
    expect(r.pads).toHaveLength(2);
    expect(r.pads.map((p) => p.cx)).toEqual([5, 17]);
  });

  it("%SR 块外的图形不复制(拼版工艺标记)", () => {
    const g =
      PAD_HEADER +
      "D10*\nX10000Y10000D03*\n" +
      "%SRX2Y1I120000J0*%\n" +
      "D10*\nX50000Y50000D03*\n" +
      "%SR*%\nM02*\n";
    const r = extractPads(g);
    expect(r.pads).toHaveLength(3);
  });
});
