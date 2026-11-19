/**
 * 轻量 Gerber 文件解析器 - 浏览器原生实现
 *
 * 目的:从板框 Gerber 文件提取所有坐标点,用于计算包围盒 + 多边形轮廓。
 * 不需要完整 Gerber 语义解析,只关心:
 * - 单位 (mm/in)
 * - 坐标格式 (places + zero suppression)
 * - X/Y 坐标和 I/J 弧心偏移
 * - **弧线模式跟踪**(G02/G03 跨行也能正确识别)
 *
 * 不依赖 Node stream / readable-stream,纯字符串解析。
 */

import { arcSweep, computeBbox, type BoundingBox } from "./bbox";
export type { BoundingBox } from "./bbox";
import { pointInPolygon } from "./geometry";
import { stitchOutline, type OutlineStroke } from "./outline-stitching";
import { splitBridgedOutline } from "./bridges";
import { decodeGerberCoordinate } from './coordinate';

export interface GerberFormat {
  /** [整数位数, 小数位数] */
  places: [number, number];
  /** 'L' = leading zero suppression (默认), 'T' = trailing */
  zero: "L" | "T";
}

/** 光圈变换(Gerber §4.9 %LM/%LR/%LS,不改变文件坐标或板框路径) */
export interface LayerTransform {
  /** %LMX:光圈局部 x → -x */
  mx: boolean;
  /** %LMY:光圈局部 y → -y */
  my: boolean;
  /** %LR:旋转角度(度,逆时针) */
  rot: number;
  /** %LS:缩放 */
  scale: number;
}

/** %SR 步进重复块:块内图形按 nx × ny 阵列复制,偏移量已换算为原始坐标单位 */
export interface StepRepeat {
  nx: number;
  ny: number;
  dxRaw: number;
  dyRaw: number;
}

/** 解析出的单个 Gerber 命令 */
export interface ParsedCommand {
  type: string;
  op?: string;
  /** 是否为弧线(由当前模式决定,与 D01 同行的 G02/G03 也算) */
  isArc: boolean;
  /** 弧线方向:undefined=直线, true=CCW(G03), false=CW(G02) */
  ccw?: boolean;
  x?: number;
  y?: number;
  i?: number;
  j?: number;
  /** 本命令生效时的光圈变换(恒等时省略),不作用于轮廓坐标 */
  tf?: LayerTransform;
  /** 所属 %SR 块(块外命令省略);展开后每个单元独立共享同一对象引用 */
  sr?: StepRepeat;
  raw?: string;
  [key: string]: unknown;
}

export interface ParseResult {
  format: GerberFormat;
  units: "mm" | "in" | null;
  commands: ParsedCommand[];
  /** 文件级拼版阵列(多个 %SR 块时取首个 >1 的块) */
  srGrid?: { nx: number; ny: number };
}

const ARC_PRECISION_MM = 0.1;
const ARC_MIN_SEGMENTS = 8;
const ARC_MAX_SEGMENTS = 200;

/**
 * 读取 %SR 的列/行间距(文件 MO 单位;调用方再统一换算 mm)。
 * Gerber 规范要求按 FS 编码写整数(如 places=[4,5] 时 5999492 = 59.99492mm),
 * 但嘉立创/立创EDA 直接写十进制 mm(I59.99492)。无小数点时先按 FS 解释,
 * 结果不落在合理间距区间则退回 mm 解释。
 */
export function srSpacingMm(raw: string, places: [number, number]): number {
  const v = parseFloat(raw);
  if (raw.includes(".")) return v;
  const byFs = v / Math.pow(10, places[1]);
  return byFs >= 0.5 && byFs <= 3000 ? byFs : v;
}

/** 有向面积(shoelace,顺时针为负) */
function signedArea(pts: Array<[number, number]>): number {
  let a = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    a += pts[i][0] * pts[i + 1][1] - pts[i + 1][0] * pts[i][1];
  }
  return a / 2;
}

/** 射线法判断点是否在多边形内(多边形首尾闭合) */
function pointInPoly(x: number, y: number, poly: Array<[number, number]>): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 2; i < poly.length - 1; j = i, i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * 从 Gerber 文本解析出单位、格式和命令列表。
 * 弧线模式(G02/G03)可以与 D01 在不同行,parser 会跨行跟踪模式。
 */
export function parseGerber(text: string): ParseResult {
  const commands: ParsedCommand[] = [];
  const format: GerberFormat = { places: [3, 6], zero: "L" };
  let units: "mm" | "in" | null = null;
  // 当前弧线模式:undefined=直线, true=CCW, false=CW
  let arcModeCCW: boolean | undefined = undefined;

  const lines = text.split(/\r?\n/);

  // 跟踪当前 X/Y(用于缺省保留)
  let prevX = 0;
  let prevY = 0;

  // 光圈变换状态(%LM/%LR/%LS 可中途切换,快照到每条命令上)
  let tfMx = false;
  let tfMy = false;
  let tfRot = 0;
  let tfScale = 1;
  const tfSnapshot = (): LayerTransform | undefined =>
    tfMx || tfMy || tfRot !== 0 || tfScale !== 1
      ? { mx: tfMx, my: tfMy, rot: tfRot, scale: tfScale }
      : undefined;

  // %SR 步进重复状态;srInfo 对象在块内共享,块结束置空
  let srInfo: StepRepeat | null = null;
  let srGrid: { nx: number; ny: number } | undefined;
  let abDepth = 0;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("G04")) continue;

    // AB 定义中的图形属于光圈字典,不是板框;其局部状态也不应泄漏。
    // 与锡膏解析器保持一致,暂不展开 block aperture 的 flash。
    const abMatch = line.match(/^%AB\s*([A-Za-z0-9_]*)/i);
    if (abMatch) {
      if (abMatch[1]) abDepth++;
      else abDepth = Math.max(0, abDepth - 1);
      continue;
    }
    if (abDepth > 0) continue;

    // 单位 + 格式(必须在 trim 之前的原始行上匹配,因为指令以 % 开头)
    const fsMatch = rawLine.match(/%FS([LT])?AX(\d)(\d)Y(\d)(\d)\*%/);
    if (fsMatch) {
      format.zero = (fsMatch[1] as "L" | "T") || "L";
      format.places = [parseInt(fsMatch[2], 10), parseInt(fsMatch[3], 10)];
    }
    const moMatch = rawLine.match(/%MO(IN|MM)\*%/i);
    if (moMatch) {
      units = moMatch[1].toUpperCase() === "MM" ? "mm" : "in";
    }

    // 光圈变换(标准 LMN = 无镜像;保留对旧式无参数重置的兼容)
    const lmMatch = rawLine.match(/%LM(XY|X|Y|N)?\*%/i);
    if (lmMatch) {
      const m = (lmMatch[1] || "").toUpperCase();
      tfMx = m.includes("X");
      tfMy = m.includes("Y");
    }
    const lrMatch = rawLine.match(/%LR(-?[\d.]+)?\*%/i);
    if (lrMatch) {
      tfRot = lrMatch[1] ? parseFloat(lrMatch[1]) : 0;
    }
    const lsMatch = rawLine.match(/%LS(-?[\d.]+)?\*%/i);
    if (lsMatch) {
      tfScale = lsMatch[1] ? parseFloat(lsMatch[1]) : 1;
    }

    // %SR 步进重复:块内图形阵列复制;参数行本身不含坐标,处理完直接跳过
    if (line.startsWith("%")) {
      const srMatch = rawLine.match(/%SR([^%*]*)\*%/i);
      if (srMatch) {
        const body = srMatch[1].trim();
        // 嘉立创/常见写法用 I/J 表示列/行间距,部分工具用 X/Y
        const ij = body.match(/^X(\d+)Y(\d+)I(-?[\d.]+)J(-?[\d.]+)$/i);
        const xy = body.match(/^X(\d+)Y(\d+)X(-?[\d.]+)Y(-?[\d.]+)$/i);
        const m = ij ?? xy;
        if (m) {
          const nx = parseInt(m[1], 10);
          const ny = parseInt(m[2], 10);
          if (nx > 0 && ny > 0 && (nx > 1 || ny > 1)) {
            const scale = Math.pow(10, format.places[1]);
            srInfo = {
              nx,
              ny,
              dxRaw: srSpacingMm(m[3], format.places) * scale,
              dyRaw: srSpacingMm(m[4], format.places) * scale,
            };
            srGrid ??= { nx, ny };
          } else {
            srInfo = null;
          }
        } else {
          // %SR*% 结束块(无参数);只给计数不给间距时无法阵列,按单份处理
          srInfo = null;
        }
      }
      continue;
    }

    // 更新弧线模式(G02=CW, G03=CCW, G01=直线)
    // 同一行可能既有 G03 又有 D01,不能 continue!
    // 注意:不能用 \b 边界(G 后跟数字不是边界),改为数字前后断言
    if (/(?<!\d)G02(?!\d)/i.test(line)) arcModeCCW = false;
    if (/(?<!\d)G03(?!\d)/i.test(line)) arcModeCCW = true;
    if (/(?<!\d)G01(?!\d)/i.test(line)) arcModeCCW = undefined;

    // 解析 D01/D02/D03
    const xMatch = line.match(/X([+-]?(?:\d+(?:\.\d*)?|\.\d+))/);
    const yMatch = line.match(/Y([+-]?(?:\d+(?:\.\d*)?|\.\d+))/);
    const iMatch = line.match(/I([+-]?(?:\d+(?:\.\d*)?|\.\d+))/);
    const jMatch = line.match(/J([+-]?(?:\d+(?:\.\d*)?|\.\d+))/);
    // A full-circle D01 may omit both unchanged endpoint coordinates.
    if (!xMatch && !yMatch && !((iMatch || jMatch) && arcModeCCW !== undefined && /D01\*/.test(line))) continue;

    // 缺省行为:Gerber spec 规定 X/Y 省略时保留上一次的值
    const x = xMatch ? decodeGerberCoordinate(xMatch[1], format.places, format.zero) : prevX;
    const y = yMatch ? decodeGerberCoordinate(yMatch[1], format.places, format.zero) : prevY;
    const i = iMatch ? decodeGerberCoordinate(iMatch[1], format.places, format.zero) : 0;
    const j = jMatch ? decodeGerberCoordinate(jMatch[1], format.places, format.zero) : 0;

    if (/D02\*/.test(line)) {
      commands.push({
        type: "op",
        op: "move",
        isArc: false,
        x,
        y,
        tf: tfSnapshot(),
        sr: srInfo ?? undefined,
        raw: line,
      });
    } else if (/D03\*/.test(line)) {
      // flash - 不属于轮廓,跳过
      continue;
    } else if (/D01\*/.test(line)) {
      // interpolate: 检测是否带 I/J(弧线)
      const hasArcOffset = i !== 0 || j !== 0;
      const isArc = hasArcOffset && arcModeCCW !== undefined;

      commands.push({
        type: "op",
        op: "interpolate",
        isArc,
        ccw: isArc ? arcModeCCW : undefined,
        x,
        y,
        i: hasArcOffset ? i : undefined,
        j: hasArcOffset ? j : undefined,
        tf: tfSnapshot(),
        sr: srInfo ?? undefined,
        raw: line,
      });
    }

    // 更新本次的 prevX/prevY(给下一行用)
    if (xMatch) prevX = x;
    if (yMatch) prevY = y;
  }

  return { format, units, commands: expandStepRepeat(commands), srGrid };
}

/** 把 %SR 块内的命令按 nx × ny 阵列展开(块外命令原样保留) */
function expandStepRepeat(commands: ParsedCommand[]): ParsedCommand[] {
  const out: ParsedCommand[] = [];
  const instances = new Map<string, StepRepeat>();
  let i = 0;
  while (i < commands.length) {
    const sr = commands[i].sr;
    if (!sr) {
      out.push(commands[i]);
      i++;
      continue;
    }
    let j = i;
    while (j < commands.length && commands[j].sr === sr) j++;
    const block = commands.slice(i, j);
    for (let iy = 0; iy < sr.ny; iy++) {
      for (let ix = 0; ix < sr.nx; ix++) {
        const dx = ix * sr.dxRaw;
        const dy = iy * sr.dyRaw;
        // Complementary strokes can be distributed across multiple SR blocks.
        // Share identity on the same grid and cell, never across neighbouring copies.
        const key = [sr.nx, sr.ny, sr.nx > 1 ? sr.dxRaw : 0, sr.ny > 1 ? sr.dyRaw : 0, ix, iy].join(',');
        let instance = instances.get(key);
        if (!instance) {
          instance = { ...sr };
          instances.set(key, instance);
        }
        for (const cmd of block) {
          out.push({ ...cmd, sr: instance, x: (cmd.x as number) + dx, y: (cmd.y as number) + dy });
        }
      }
    }
    i = j;
  }
  return out;
}

/**
 * 从 Gerber 文本提取板框多边形轮廓(已闭合,弧线已线性化)
 *
 * @param opts.panel 拼版文件的外框口径:
 *   - true(默认)取整版外接矩形(含工艺边 / V-CUT 框)
 *   - false 只取其中一块单板(面积最大的闭合轮廓)
 *   非拼版文件两种口径结果相同。
 */
export function extractOutline(text: string, opts?: { panel?: boolean }): GerberOutline {
  return analyzeOutline(text)(opts?.panel !== false);
}

export function extractOutlineScopes(text: string) {
  const select = analyzeOutline(text);
  const panel = select(true);
  return { panel, single: panel.isPanel ? select(false) : panel };
}

/** Decode, stitch and classify contours once; only the final boundary depends on scope. */
function analyzeOutline(text: string) {
  const parsed = parseGerber(text);
  const { format, units, commands } = parsed;
  const inToMm = 25.4;
  let totalCommands = commands.length;
  let arcs = 0;

  const toMm = (raw: number): number => {
    const v = raw / Math.pow(10, format.places[1]);
    return units === "in" ? v * inToMm : v;
  };

  // 轮廓集合:D02(move)= 提笔,开启新轮廓;板内开槽的板框会有多条轮廓
  const contours: OutlineStroke[] = [];
  let cur: OutlineStroke | null = null;
  const startStroke = (group: StepRepeat | undefined, points: OutlineStroke['points']) => {
    const stroke = { group, points };
    contours.push(stroke);
    return stroke;
  };
  // X/Y 在命令列表里已经是缺省保留后的最终值,直接用
  let prevX = 0;
  let prevY = 0;

  // Gerber §4.9:LM/LR/LS 只变换光圈,不改变直线/圆弧/region
  // 的路径坐标。板框使用路径中心线,因此始终保留原文件坐标。

  for (const cmd of commands) {
    if (cmd.type !== "op") continue;

    const currX = cmd.x as number;
    const currY = cmd.y as number;

    if (cmd.op === "move") {
      // D02 = 提笔:结束当前轮廓,下一点开启新轮廓
      cur = startStroke(cmd.sr, [[toMm(currX), toMm(currY)]]);
      prevX = currX;
      prevY = currY;
    } else if (cmd.op === "interpolate") {
      const x = toMm(currX);
      const y = toMm(currY);
      const i = cmd.i !== undefined ? toMm(cmd.i as number) : 0;
      const j = cmd.j !== undefined ? toMm(cmd.j as number) : 0;

      // 文件以 D01 起始(无 D02):自动开一条轮廓
      if (!cur) cur = startStroke(cmd.sr, []);

      if (cmd.isArc && (Math.abs(i) > 1e-9 || Math.abs(j) > 1e-9)) {
        const prevXmm = toMm(prevX);
        const prevYmm = toMm(prevY);
        const cx = prevXmm + i;
        const cy = prevYmm + j;
        const radius = Math.sqrt(i * i + j * j);
        const ccw = cmd.ccw === true;

        const startAngle = Math.atan2(prevYmm - cy, prevXmm - cx);
        const endAngle = Math.atan2(y - cy, x - cx);
        const sign = ccw ? 1 : -1;
        // Use the true tangent: chords from arc tessellation bias the join direction.
        if (cur.points.every(([px, py]) => px === prevXmm && py === prevYmm)) {
          cur.startTangent = [Math.sin(startAngle) * sign, -Math.cos(startAngle) * sign];
        }
        cur.endTangent = [-Math.sin(endAngle) * sign, Math.cos(endAngle) * sign];

        const delta = arcSweep(startAngle, endAngle, ccw);
        const arcLen = Math.abs(delta) * radius;
        const segs = Math.max(
          ARC_MIN_SEGMENTS,
          Math.min(ARC_MAX_SEGMENTS, Math.ceil(arcLen / ARC_PRECISION_MM))
        );
        const stepAngle = delta / segs;

        for (let s = 1; s < segs; s++) {
          const a = startAngle + stepAngle * s;
          cur.points.push([cx + radius * Math.cos(a), cy + radius * Math.sin(a)]);
        }
        // X/Y is the declared endpoint; rounded I/J may project it off the next stroke.
        cur.points.push([x, y]);
        arcs++;
      } else {
        if (currX !== prevX || currY !== prevY) cur.endTangent = undefined;
        cur.points.push([x, y]);
      }
      // 无论直线还是弧线,interpolate 后 prevX/prevY 更新到当前点(给下一条命令用)
      prevX = currX;
      prevY = currY;
    }
  }

  const { closed, open, groups } = stitchOutline(contours);

  const areaOf = (c: Array<[number, number]>): number => Math.abs(signedArea(c));
  const contourBbox = (c: Array<[number, number]>) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of c) {
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
    return { x0, y0, x1, y1 };
  };
  const describeContour = (c: OutlineStroke['points']) => ({ c, area: areaOf(c), bbox: contourBbox(c) });
  type ContourEntry = ReturnType<typeof describeContour>;
  const contourEntries = closed.map(describeContour).filter((entry) => entry.area > 1e-6);
  const contourContains = (outer: ContourEntry, inner: ContourEntry) => {
    const a = outer.bbox, b = inner.bbox;
    if (outer.area <= inner.area || b.x0 < a.x0 - 1e-6 || b.x1 > a.x1 + 1e-6 ||
        b.y0 < a.y0 - 1e-6 || b.y1 > a.y1 + 1e-6) return false;
    return inner.c.every(([x, y], i) => {
      const next = inner.c[(i + 1) % inner.c.length];
      return pointInPolygon(x, y, outer.c) &&
        pointInPolygon((x + next[0]) / 2, (y + next[1]) / 2, outer.c);
    });
  };
  const topLevel = (entries: ContourEntry[]) => entries.filter((entry) =>
    !entries.some((parent) => parent !== entry && contourContains(parent, entry))
  );
  // Do not promote closed cutouts to boards when their perimeter could not be
  // repaired. Use the open chain only as containment evidence, never as a board
  // or hole. Compare inside each repeated cell so tooling frames outside SR do
  // not disqualify valid repeated boards.
  const unfinished = new Map<object | undefined, ContourEntry[]>();
  for (const path of open) {
    if (path.length < 3) continue;
    const entry = describeContour([...path, path[0]]);
    if (entry.area <= 1e-6) continue;
    const group = groups.get(path);
    const perimeters = unfinished.get(group);
    if (perimeters) perimeters.push(entry);
    else unfinished.set(group, [entry]);
  }
  const cutoutCandidates = new Set<OutlineStroke['points']>();
  const incompleteBoards = new Set<ContourEntry>();
  for (const entry of contourEntries) {
    for (const perimeter of unfinished.get(groups.get(entry.c)) ?? []) {
      if (!contourContains(perimeter, entry)) continue;
      cutoutCandidates.add(entry.c);
      incompleteBoards.add(perimeter);
    }
  }
  const boardCandidates = contourEntries.filter(entry => !cutoutCandidates.has(entry.c));
  // With SR, an explicit repeated board is better evidence than a surrounding frame.
  const repeatedEntries = boardCandidates.filter((entry) => groups.has(entry.c));
  const boardEntries = topLevel(repeatedEntries.length ? repeatedEntries : boardCandidates)
    .sort((a, b) => b.bbox.y1 - a.bbox.y1 || a.bbox.x0 - b.bbox.x0);
  let boardContours: GerberBoardOutline[] = boardEntries.map((entry) => {
    const { x0, y0, x1, y1 } = entry.bbox;
    const holes = contourEntries.filter((hole) => contourContains(entry, hole)).map((hole) => hole.c);
    return {
      points: entry.c,
      holes,
      bbox: { minX: x0, minY: y0, maxX: x1, maxY: y1 },
    };
  });
  // A disjoint incomplete perimeter with a cutout is evidence of another
  // board. Keep the whole panel and its pads, but only offer verified children.
  const hasIncompleteNeighbor = boardEntries.length === 1 && [...incompleteBoards].some(({ bbox: b }) => {
    const { bbox: a } = boardEntries[0];
    return b.x1 < a.x0 || a.x1 < b.x0 || b.y1 < a.y0 || a.y1 < b.y0;
  });
  let connectedPanel = false;
  if (boardContours.length === 1 && !parsed.srGrid && !hasIncompleteNeighbor) {
    const board = boardContours[0];
    const separated = splitBridgedOutline(board.points, board.holes);
    if (separated.length > 1) {
      connectedPanel = true;
      boardContours = separated.sort((a, b) => b.bbox.maxY - a.bbox.maxY || a.bbox.minX - b.bbox.minX);
    }
  }

  const srCols = parsed.srGrid?.nx ?? 1;
  const srRows = parsed.srGrid?.ny ?? 1;
  const repeatedPanel = srCols * srRows > 1 && repeatedEntries.length > 0;
  const isPanel = repeatedPanel || hasIncompleteNeighbor || boardContours.length >= 2;

  return (wholePanel: boolean): GerberOutline => {
    // 拼版:外框取全部图形(含工艺边 / V-CUT 框)的整体包围盒,内孔不适用
    let outer: Array<[number, number]> | null = null;
    let totalPoints = 0;
    const holes: Array<Array<[number, number]>> = [];

    if (isPanel && wholePanel && !connectedPanel) {
      const { minX: x0, minY: y0, maxX: x1, maxY: y1, commandCount } = computeBbox(parsed);
      for (const c of closed) totalPoints += c.length;
      if (commandCount > 0) {
        outer = [
          [x0, y0],
          [x1, y0],
          [x1, y1],
          [x0, y1],
          [x0, y0],
        ];
      }
    } else {
      // In single-board scope, use known children of a panel. In particular a
      // cutout, an open perimeter, and a surrounding frame are not substitutes.
      const useChildBoards = !wholePanel && isPanel;
      const candidates = useChildBoards ? boardContours.map(board => board.points)
        : closed.filter(path => !cutoutCandidates.has(path));
      let outerArea = -1;
      for (const c of candidates) {
        totalPoints += c.length;
        const a = areaOf(c);
        if (a > outerArea) {
          outerArea = a;
          outer = c;
        }
      }
      if (outer) {
        if (useChildBoards) {
          holes.push(...boardContours.find((board) => board.points === outer)!.holes);
        } else {
          for (const c of closed) {
            if (c === outer) continue;
            const [px, py] = c[0];
            if (pointInPoly(px, py, outer)) holes.push(c);
          }
        }
      }
    }

    const rawPoints = outer ?? [];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of rawPoints) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }

    return {
      points: rawPoints,
      holes,
      bbox: {
        minX: isFinite(minX) ? minX : 0,
        minY: isFinite(minY) ? minY : 0,
        maxX: isFinite(maxX) ? maxX : 0,
        maxY: isFinite(maxY) ? maxY : 0,
        units,
        commandCount: totalPoints,
      },
      units,
      arcsLinearized: arcs,
      totalCommands,
      isPanel,
      panelGrid: repeatedPanel ? { nx: srCols, ny: srRows } : undefined,
      boards: boardContours.length > 1 ? boardContours : undefined,
    };
  };
}

export interface GerberOutline {
  /** 外框多边形顶点(已闭合,首尾相同) — 单位:mm,原点在 Gerber 原点 */
  points: Array<[number, number]>;
  /** 内孔轮廓列表(每条已闭合)。板内开槽的 PCB(异形挖孔)会有 1 条以上 */
  holes: Array<Array<[number, number]>>;
  /** 包围盒(基于外框顶点;内孔在外框内部,不影响) */
  bbox: BoundingBox;
  /** 单位 */
  units: "mm" | "in" | null;
  /** 线性化弧线数 */
  arcsLinearized: number;
  /** Gerber 命令总数(便于诊断) */
  totalCommands: number;
  /** 是否为拼版(多块 PCB 阵列) */
  isPanel: boolean;
  /** 拼版阵列(仅 isPanel 且由 %SR 给出时存在) */
  panelGrid?: { nx: number; ny: number };
  /** 可独立选择的子板轮廓(未居中,单位:mm)。混合拼版时每个条目对应一块板。 */
  boards?: GerberBoardOutline[];
}

/** 从板框文件中提取出的独立板框,与 GerberOutline 共用几何字段。 */
export interface GerberBoardOutline {
  /** Boundary inferred by removing routing bridges; user should verify it. */
  inferred?: boolean;
  points: Array<[number, number]>;
  holes: Array<Array<[number, number]>>;
  bbox: Pick<BoundingBox, "minX" | "minY" | "maxX" | "maxY">;
}
