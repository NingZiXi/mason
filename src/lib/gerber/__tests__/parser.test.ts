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

describe("图层变换 LM/LR/LS", () => {
  // 矩形 (0,0)-(5,4) mm,places=[2,4]
  const rect = (header: string) =>
    `G04 tf test*\n%FSLAX24Y24*%\n%MOMM*%\n${header}G01*\nX0Y0D02*\nX50000Y0D01*\nX50000Y40000D01*\nX0Y40000D01*\nX0Y0D01*\nM02*\n`;

  it("%LMY 关于 Y 轴镜像(x → -x)", () => {
    const outline = extractOutline(rect("%LMY*%\n"));
    expect(outline.bbox.minX).toBeCloseTo(-5, 3);
    expect(outline.bbox.maxX).toBeCloseTo(0, 3);
    expect(outline.bbox.minY).toBeCloseTo(0, 3);
    expect(outline.bbox.maxY).toBeCloseTo(4, 3);
  });

  it("%LMX 关于 X 轴镜像(y → -y)", () => {
    const outline = extractOutline(rect("%LMX*%\n"));
    expect(outline.bbox.minX).toBeCloseTo(0, 3);
    expect(outline.bbox.maxX).toBeCloseTo(5, 3);
    expect(outline.bbox.minY).toBeCloseTo(-4, 3);
    expect(outline.bbox.maxY).toBeCloseTo(0, 3);
  });

  it("%LMXY 双轴镜像(等价 180° 旋转)", () => {
    const outline = extractOutline(rect("%LMXY*%\n"));
    expect(outline.bbox.minX).toBeCloseTo(-5, 3);
    expect(outline.bbox.maxX).toBeCloseTo(0, 3);
    expect(outline.bbox.minY).toBeCloseTo(-4, 3);
    expect(outline.bbox.maxY).toBeCloseTo(0, 3);
  });

  it("%LR90 旋转 90°(5×4 矩形 → 4×5)", () => {
    const outline = extractOutline(rect("%LR90*%\n"));
    expect(outline.bbox.minX).toBeCloseTo(-4, 3);
    expect(outline.bbox.maxX).toBeCloseTo(0, 3);
    expect(outline.bbox.minY).toBeCloseTo(0, 3);
    expect(outline.bbox.maxY).toBeCloseTo(5, 3);
  });

  it("%LS2 缩放 2 倍", () => {
    const outline = extractOutline(rect("%LS2.0*%\n"));
    expect(outline.bbox.maxX).toBeCloseTo(10, 3);
    expect(outline.bbox.maxY).toBeCloseTo(8, 3);
  });

  it("组合变换:镜像 + 旋转 + 缩放", () => {
    // %LMY 后 %LR90:先 x→-x,再旋转 90°(逆时针)
    // (5,4) → (-5,4) → (-4,-5)
    const outline = extractOutline(rect("%LMY*%\n%LR90*%\n"));
    expect(outline.bbox.minX).toBeCloseTo(-4, 3);
    expect(outline.bbox.maxX).toBeCloseTo(0, 3);
    expect(outline.bbox.minY).toBeCloseTo(-5, 3);
    expect(outline.bbox.maxY).toBeCloseTo(0, 3);
  });

  it("无参数 %LM 重置为恒等", () => {
    const outline = extractOutline(rect("%LMY*%\n%LM*%\n"));
    expect(outline.bbox.minX).toBeCloseTo(0, 3);
    expect(outline.bbox.maxX).toBeCloseTo(5, 3);
  });

  it("变换中途切换只影响之后的命令", () => {
    // 前半段无变换画 (0,0)→(5,0);%LMY 后画 (5,0)→(5,4) 变为 (-5,0)→(-5,4)
    const gerber =
      "G04 mid switch*\n%FSLAX24Y24*%\n%MOMM*%\nG01*\nX0Y0D02*\nX50000Y0D01*\n%LMY*%\nX50000Y40000D01*\nX0Y40000D01*\nM02*\n";
    const outline = extractOutline(gerber);
    expect(outline.bbox.minX).toBeCloseTo(-5, 3);
    expect(outline.bbox.maxX).toBeCloseTo(5, 3);
    expect(outline.bbox.maxY).toBeCloseTo(4, 3);
  });

  it("镜像下的弧线方向自动正确(路径保持圆弧)", () => {
    // 圆弧:原生空间从 (10,10) G03(CCW)到 (15,15),圆心 (15,10) r=5;
    // CCW 扫过 270°(经 (15,5)→(20,10)→(15,15)),原生 bbox x∈[10,20] y∈[5,15]
    // %LMX 镜像(y→-y)后:圆心 (15,-10),bbox x∈[10,20] y∈[-15,-5]
    const gerber =
      "G04 mirrored arc*\n%FSLAX24Y24*%\n%MOMM*%\n%LMX*%\nG01*\nX100000Y100000D02*\nG03*\nX150000Y150000I50000J0D01*\nM02*\n";
    const outline = extractOutline(gerber);
    expect(outline.bbox.minY).toBeCloseTo(-15, 2);
    expect(outline.bbox.maxY).toBeCloseTo(-5, 2);
    expect(outline.bbox.minX).toBeCloseTo(10, 2);
    expect(outline.bbox.maxX).toBeCloseTo(20, 2);
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
