/**
 * 拼版(%SR 步进重复)支持回归测试
 *
 * 覆盖嘉立创 EasyEDA Pro 的拼版导出:板框/锡膏层在 %SR 块内只画一块,
 * 由 %SRXnYnI<列距>J<行距>*% 声明阵列,需展开成整版。
 */
import { describe, it, expect } from "vitest";
import { extractOutline, parseGerber } from "../parser";
import { extractPads } from "../pads";
import { makePanelVariant } from "../panel";

const HEADER = "%FSLAX24Y24*%\n%MOMM*%\nG01*\n";
const PAD_HEADER = "%FSLAX24Y24*%\n%MOMM*%\n%ADD10C,0.5*%\n";
const draw = (points: Array<[number, number]>) => [...points, points[0]]
  .map(([x, y], i) => `X${Math.round(x * 10000)}Y${Math.round(y * 10000)}D0${i ? 1 : 2}*`).join("\n") + "\n";

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

  it("混合拼版保留不同尺寸的独立子板轮廓", () => {
    const small = [
      "X0Y0D02*", "X60000Y0D01*", "X60000Y40000D01*", "X0Y40000D01*", "X0Y0D01*",
    ].join("\n");
    const large = [
      "X100000Y0D02*", "X260000Y0D01*", "X260000Y100000D01*", "X100000Y100000D01*", "X100000Y0D01*",
    ].join("\n");
    const o = extractOutline(HEADER + small + "\n" + large + "\nM02*\n", { panel: true });
    expect(o.isPanel).toBe(true);
    expect(o.bbox.maxX).toBeCloseTo(26, 3);
    expect(o.bbox.maxY).toBeCloseTo(10, 3);
    expect(o.boards).toHaveLength(2);
    expect(o.boards?.map((b) => [b.bbox.maxX - b.bbox.minX, b.bbox.maxY - b.bbox.minY]))
      .toEqual(expect.arrayContaining([[6, 4], [16, 10]]));
  });

  it("单板的多个大内槽不会误判为子板", () => {
    const text = HEADER + draw([[0, 0], [50, 0], [50, 40], [0, 40]]) +
      draw([[2, 2], [22, 2], [22, 12], [2, 12]]) + draw([[26, 2], [46, 2], [46, 12], [26, 12]]);
    const result = extractOutline(text, { panel: true });
    expect(result.isPanel).toBe(false);
    expect(result.boards).toBeUndefined();
    expect(result.holes).toHaveLength(2);
  });

  it("SR 工艺边框内的子板保留内孔,不会选中整版边框", () => {
    const text = HEADER + draw([[-1, -1], [25, -1], [25, 12], [-1, 12]]) +
      "%SRX2Y1I120000J0*%\n" + BOARD + "\n" +
      draw([[2, 2], [4, 2], [4, 4], [2, 4]]) + "%SR*%\n";
    const result = extractOutline(text, { panel: true });
    expect(result.boards).toHaveLength(2);
    for (const board of result.boards!) {
      expect(board.bbox.maxX - board.bbox.minX).toBe(10);
      expect(board.bbox.maxY - board.bbox.minY).toBe(8);
      expect(board.holes).toHaveLength(1);
    }
  });

  it("逐边提笔的不同子板可以拼接识别,未闭合折线不会增加子板", () => {
    const strokes = (points: Array<[number, number]>) => points.map((p, i) => {
      const q = points[(i + 1) % points.length];
      return `X${p[0] * 10000}Y${p[1] * 10000}D02*\nX${q[0] * 10000}Y${q[1] * 10000}D01*\n`;
    }).join("");
    const result = extractOutline(HEADER + strokes([[0, 0], [10, 0], [10, 8], [0, 8]]) +
      strokes([[20, 0], [24, 0], [24, 3], [20, 3]]) + "X400000Y0D02*\nX500000Y0D01*\nX500000Y100000D01*\n");
    expect(result.boards).toHaveLength(2);
  });

  it("异形板包围盒重叠时按板形隔离焊盘并排除内孔,坐标随子板居中", () => {
    const lBoard: Array<[number, number]> = [[0, 0], [20, 0], [20, 5], [5, 5], [5, 20], [0, 20]];
    const text = HEADER + draw(lBoard) + draw([[8, 8], [16, 8], [16, 16], [8, 16]]) +
      draw([[1, 7], [4, 7], [4, 11], [1, 11]]);
    const result = extractOutline(text, { panel: true });
    expect(result.boards).toHaveLength(2);
    const paste = PAD_HEADER + "D10*\nX20000Y20000D03*\nX120000Y120000D03*\nX20000Y80000D03*\n";
    const pads = extractPads(paste).pads;
    const variants = result.boards!.map((board) => makePanelVariant(board, pads, pads));
    const l = variants.find((b) => b.width === 20)!;
    const square = variants.find((b) => b.width === 8)!;
    expect(l.outlineHoles).toHaveLength(1);
    expect(l.topPads?.map((p) => [p.cx, p.cy])).toEqual([[-8, -8]]);
    expect(l.bottomPads).toEqual(l.topPads);
    expect(l.topPads?.[0].parts[0].points[0][0]).toBeCloseTo(-7.75);
    expect(square.topPads?.map((p) => [p.cx, p.cy])).toEqual([[0, 0]]);
    // The source data is shared by all variants and must not be shifted in place.
    expect(pads.map((p) => p.cx)).toEqual([2, 12, 2]);
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
