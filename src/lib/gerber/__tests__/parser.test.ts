/**
 * Gerber 解析单元测试
 * 用 vitest 跑: npm test
 */
import { describe, it, expect } from "vitest";
import { parseGerber, extractOutline } from "../parser";
import { computeBbox } from "../bbox";
import { detectOutlineFiles } from "../outline-detect";

// 一段典型的板框 Gerber(嘉立创EDA 风格,mm 单位,places=[2,4])
// 注意:50000 = 5.0000 mm,40000 = 4.0000 mm
const SAMPLE_GKO_MM = `G04 PCB_Project_2024-01-15*
%FSLAX24Y24*%
%MOMM*%
%ADD10C,0.1*%
%LPD*%
G01*
X0Y0D02*
X50000Y0D01*
X50000Y40000D01*
X0Y40000D01*
X0Y0D01*
M02*
`;

describe("parseGerber", () => {
  it("检测 mm 单位", () => {
    const r = parseGerber(SAMPLE_GKO_MM);
    expect(r.units).toBe("mm");
  });

  it("检测 inch 单位", () => {
    const gerber = `G04 test*\n%FSLAX24Y24*%\n%MOIN*%\nG01*\nX0Y0D02*\nX1000Y0D01*\nM02*\n`;
    const r = parseGerber(gerber);
    expect(r.units).toBe("in");
  });

  it("检测格式 places", () => {
    const r = parseGerber(SAMPLE_GKO_MM);
    expect(r.format.places).toEqual([2, 4]);
    expect(r.format.zero).toBe("L");
  });

  it("提取所有坐标命令", () => {
    const r = parseGerber(SAMPLE_GKO_MM);
    // 4 个 D01 + 1 个 D02 = 5 个 op
    expect(r.commands.filter((c) => c.type === "op").length).toBe(5);
  });
});

describe("computeBbox", () => {
  it("50mm × 40mm 矩形包围盒", () => {
    const r = parseGerber(SAMPLE_GKO_MM);
    const bbox = computeBbox(r);
    // places=[2,4]: 50000 → 5.0000 mm; 40000 → 4.0000 mm
    expect(bbox.minX).toBeCloseTo(0, 5);
    expect(bbox.minY).toBeCloseTo(0, 5);
    expect(bbox.maxX).toBeCloseTo(5, 5);
    expect(bbox.maxY).toBeCloseTo(4, 5);
    expect(bbox.commandCount).toBeGreaterThan(0);
  });

  it("包含弧线极值 (i, j 偏移)", () => {
    // places=[2,4]: X100000 = 10.0 mm, I50000 = 5.0 mm
    const gerber = `G04 arc test*
%FSLAX24Y24*%
%MOMM*%
G01*
X100000Y100000D02*
G03*
X100000Y100000I50000J0D01*
M02*
`;
    // 圆弧 (center 15,10 mm, radius 5mm),起点 (10,10)
    const r = parseGerber(gerber);
    const bbox = computeBbox(r);
    // 起点 (10,10) + 弧线极值 (15±5, 10±5) = (10,5)-(20,15)
    expect(bbox.minX).toBeCloseTo(10, 3);
    expect(bbox.maxX).toBeCloseTo(20, 3);
    expect(bbox.minY).toBeCloseTo(5, 3);
    expect(bbox.maxY).toBeCloseTo(15, 3);
  });

  it("空命令返回零包围盒", () => {
    const r = parseGerber("G04 注释\nM02*\n");
    const bbox = computeBbox(r);
    expect(bbox.commandCount).toBe(0);
    expect(bbox.maxX).toBe(0);
  });
});

describe("detectOutlineFiles", () => {
  it('does not promote copper, paste, or text files because their ZIP folder contains outline', () => {
    const result = detectOutlineFiles([
      'board-outline/board.GTL', 'board-outline/board.GTP', 'board-outline/readme.txt',
      'board-outline/board.GKO',
    ]);
    expect(result.map(candidate => candidate.filename)).toEqual(['board-outline/board.GKO']);
  });

  it("优先选 .GKO", () => {
    const files = [
      "Gerber_TopLayer.GTL",
      "Gerber_BoardOutlineLayer.GKO",
      "Gerber_BottomLayer.GBL",
    ];
    const result = detectOutlineFiles(files);
    expect(result[0].filename).toBe("Gerber_BoardOutlineLayer.GKO");
  });

  it("Edge.Cuts 文件优先于 .GM1", () => {
    const files = ["PCB_Edge_Cuts.gm1", "PCB-something.GM1"];
    const result = detectOutlineFiles(files);
    expect(result[0].reason).toContain("Edge");
  });

  it("多个候选按优先级排序", () => {
    const files = [
      "rand.gme", // V-Cut 机械层,优先级最低
      "top.gtl", // 不匹配
      "board-outline.gko", // GKO
    ];
    const result = detectOutlineFiles(files);
    expect(result[0].filename).toBe("board-outline.gko");
    expect(result.length).toBeGreaterThanOrEqual(2);
  });
});

describe("多轮廓(外框 + 内孔)", () => {
  // 外框 (0,0)-(50,40) mm + 内孔 (10,10)-(20,30) mm,places=[2,4]
  const MULTI = `G04 inner hole board*
%FSLAX24Y24*%
%MOMM*%
G01*
X0Y0D02*
X500000Y0D01*
X500000Y400000D01*
X0Y400000D01*
X0Y0D01*
X100000Y100000D02*
X200000Y100000D01*
X200000Y300000D01*
X100000Y300000D01*
X100000Y100000D01*
M02*
`;

  it("外框 = 最大面积轮廓,bbox 不受内孔影响", () => {
    const outline = extractOutline(MULTI);
    expect(outline.bbox.minX).toBeCloseTo(0, 3);
    expect(outline.bbox.maxX).toBeCloseTo(50, 3);
    expect(outline.bbox.minY).toBeCloseTo(0, 3);
    expect(outline.bbox.maxY).toBeCloseTo(40, 3);
  });

  it("内孔被单独提取(1 条,坐标正确)", () => {
    const outline = extractOutline(MULTI);
    expect(outline.holes).toHaveLength(1);
    const hole = outline.holes[0];
    // 内孔 bbox:(10,10)-(20,30)
    const xs = hole.map((p) => p[0]);
    const ys = hole.map((p) => p[1]);
    expect(Math.min(...xs)).toBeCloseTo(10, 3);
    expect(Math.max(...xs)).toBeCloseTo(20, 3);
    expect(Math.min(...ys)).toBeCloseTo(10, 3);
    expect(Math.max(...ys)).toBeCloseTo(30, 3);
    // 已闭合(首尾相同)
    expect(hole[0]).toEqual(hole[hole.length - 1]);
  });

  it("内孔写在外框之前也能正确分类(与顺序无关)", () => {
    const reordered = `G04 hole first*
%FSLAX24Y24*%
%MOMM*%
G01*
X100000Y100000D02*
X200000Y100000D01*
X200000Y300000D01*
X100000Y300000D01*
X100000Y100000D01*
X0Y0D02*
X500000Y0D01*
X500000Y400000D01*
X0Y400000D01*
X0Y0D01*
M02*
`;
    const outline = extractOutline(reordered);
    expect(outline.points.length).toBeGreaterThanOrEqual(5);
    expect(outline.holes).toHaveLength(1);
    expect(outline.bbox.maxX).toBeCloseTo(50, 3);
  });

  it("不同尺寸独立轮廓识别为混合拼版,单板口径仍取最大板", () => {
    const disjoint = `G04 two boards*
%FSLAX24Y24*%
%MOMM*%
G01*
X0Y0D02*
X500000Y0D01*
X500000Y400000D01*
X0Y400000D01*
X0Y0D01*
X600000Y0D02*
X700000Y0D01*
X700000Y100000D01*
X600000Y100000D01*
X600000Y0D01*
M02*
`;
    const outline = extractOutline(disjoint);
    expect(outline.holes).toHaveLength(0);
    expect(outline.isPanel).toBe(true);
    expect(outline.boards).toHaveLength(2);
    expect(outline.bbox.maxX).toBeCloseTo(70, 3);
    expect(extractOutline(disjoint, { panel: false }).bbox.maxX).toBeCloseTo(50, 3);
  });

  it("单轮廓文件 holes 为空(向后兼容)", () => {
    const outline = extractOutline(SAMPLE_GKO_MM);
    expect(outline.holes).toHaveLength(0);
    expect(outline.points.length).toBe(5);
  });
});
