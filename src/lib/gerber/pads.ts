/**
 * Gerber 锡膏层光绘机(photoplotter)语义解析器
 *
 * 制板厂做钢网 = 把锡膏 Gerber 当光绘文件完整显影:
 * 光圈如何定义、图形如何曝光,钢网上就如何开孔。
 * 本模块按 RS-274X 光绘机语义实现,而非启发式猜形状:
 *
 * - 标准光圈: C(圆)/R(矩)/O(长圆)/P(正多边形),均支持旋转与中心孔
 * - 宏光圈 %AM 完整展开: 原语 1(圆)/2,20(矢量线)/21(中心矩)/22(左下矩)/
 *   4(轮廓)/5(正多边形)/6(moire 同心环)/7(thermal 热焊盘),
 *   参数支持 $n 代换与 + - * / ( ) 算术表达式,支持曝光极性(暗/擦除)
 * - 图形: D03 flash / D01 描线(含 G74/G75 圆弧,I/J 偏移)/ G36-G37 区域填充
 * - 图像控制: %LP 图像极性 / %SR 步进重复 / %LM/%LR/%LS 图层变换
 * - %AB 光圈块跳过(计数);G54 旧式光圈选择;D nn ≥ 10 才是光圈选择
 *
 * 输出: 每个焊盘 = 多部件(parts)列表;部件带极性(D=曝光开孔 / C=擦除)
 * 与可选内孔。Python 端用 shapely 做并/差布尔后生成开孔。
 * 坐标单位 mm;原点与板框一致(由调用方做居中平移)。
 */

export interface PadPart {
  /** 极性:D=dark 曝光(开孔) / C=clear 擦除(在该焊盘内恢复材料) */
  polarity: "D" | "C";
  /** 部件外轮廓(闭合点列,mm) */
  points: Array<[number, number]>;
  /** 部件内孔列表 */
  holes?: Array<Array<[number, number]>>;
}

export interface PadPolygon {
  /** 类型标识(诊断用) */
  type: "circle" | "rect" | "obround" | "line" | "polygon" | "region" | "roundrect" | "macro" | "arc";
  /** 焊盘包围盒中心(诊断显示用) */
  cx: number;
  cy: number;
  /** 图像极性(D=开孔 / C=擦除,%LPC 产生) */
  polarity: "D" | "C";
  /** 部件列表(宏光圈可产生多个,含极性与内孔) */
  parts: PadPart[];
}

export interface ExtractPadsResult {
  pads: PadPolygon[];
  units: "mm" | "in" | null;
  /** 解析到的光圈数量(诊断) */
  apertureCount: number;
  /** flash 数量 */
  flashCount: number;
  /** 线条/圆弧描线数量 */
  lineCount: number;
  /** 区域填充数量 */
  regionCount: number;
  /** 因光圈缺失等原因被跳过的 flash 数(应为 0,否则文件有兼容问题) */
  skippedFlashes: number;
  /** 跳过的描线数 */
  skippedLines: number;
  /** 跳过的 %AB 块内图形数 */
  skippedBlockGraphics: number;
}

// ---------------------------------------------------------------------------
// 基础形状(局部坐标,中心在原点)
// ---------------------------------------------------------------------------

const CIRCLE_SEGMENTS = 32;
const ARC_SEG_PER_90 = 6; // 圆弧离散:每 90° 6 段
const TWO_PI = Math.PI * 2;

function circleRing(cx: number, cy: number, d: number): Array<[number, number]> {
  const r = d / 2;
  const pts: Array<[number, number]> = [];
  for (let i = 0; i <= CIRCLE_SEGMENTS; i++) {
    const a = (i / CIRCLE_SEGMENTS) * TWO_PI;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return pts;
}

function rectRing(cx: number, cy: number, w: number, h: number): Array<[number, number]> {
  const hw = w / 2;
  const hh = h / 2;
  return [
    [cx - hw, cy - hh],
    [cx + hw, cy - hh],
    [cx + hw, cy + hh],
    [cx - hw, cy + hh],
    [cx - hw, cy - hh],
  ];
}

function obroundRing(cx: number, cy: number, w: number, h: number): Array<[number, number]> {
  const r = Math.min(w, h) / 2;
  const pts: Array<[number, number]> = [];
  const half = CIRCLE_SEGMENTS / 2;
  if (w >= h) {
    const hl = (w - h) / 2;
    for (let i = 0; i <= half; i++) {
      const a = Math.PI / 2 - (i / half) * Math.PI;
      pts.push([cx + hl + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
    pts.push([cx - hl, cy - r]);
    for (let i = 0; i <= half; i++) {
      const a = -Math.PI / 2 + (i / half) * Math.PI;
      pts.push([cx - hl - r * Math.cos(a), cy + r * Math.sin(a)]);
    }
    pts.push([cx + hl, cy + r]);
  } else {
    const hl = (h - w) / 2;
    for (let i = 0; i <= half; i++) {
      const a = (i / half) * Math.PI;
      pts.push([cx + r * Math.cos(a), cy + hl + r * Math.sin(a)]);
    }
    pts.push([cx - r, cy - hl]);
    for (let i = 0; i <= half; i++) {
      const a = Math.PI + (i / half) * Math.PI;
      pts.push([cx + r * Math.cos(a), cy - hl + r * Math.sin(a)]);
    }
    pts.push([cx + r, cy + hl]);
  }
  pts.push(pts[0]);
  return pts;
}

function regularPolygonRing(
  cx: number, cy: number, d: number, n: number, rotDeg: number
): Array<[number, number]> {
  const r = d / 2;
  const pts: Array<[number, number]> = [];
  for (let i = 0; i <= n; i++) {
    const a = ((rotDeg + (i * 360) / n) * Math.PI) / 180;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return pts;
}

function roundRectRing(
  cx: number, cy: number, w: number, h: number, r: number
): Array<[number, number]> {
  r = Math.min(r, w / 2, h / 2);
  if (r <= 1e-9) return rectRing(cx, cy, w, h);
  const hw = w / 2 - r;
  const hh = h / 2 - r;
  const seg = Math.max(2, Math.floor(CIRCLE_SEGMENTS / 4));
  const arcs: Array<{ ax: number; ay: number; a0: number }> = [
    { ax: hw, ay: -hh, a0: -Math.PI / 2 },
    { ax: hw, ay: hh, a0: 0 },
    { ax: -hw, ay: hh, a0: Math.PI / 2 },
    { ax: -hw, ay: -hh, a0: Math.PI },
  ];
  const pts: Array<[number, number]> = [];
  for (const a of arcs) {
    for (let i = 0; i <= seg; i++) {
      const t = a.a0 + (i / seg) * (Math.PI / 2);
      pts.push([cx + a.ax + r * Math.cos(t), cy + a.ay + r * Math.sin(t)]);
    }
  }
  pts.push(pts[0]);
  return pts;
}

/** 线段胶囊:两端半圆 + 矩形 */
function capsuleRing(
  x1: number, y1: number, x2: number, y2: number, width: number
): Array<[number, number]> {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return circleRing((x1 + x2) / 2, (y1 + y2) / 2, width);
  const r = width / 2;
  const nx = -dy / len;
  const ny = dx / len;
  const pts: Array<[number, number]> = [];
  const half = CIRCLE_SEGMENTS / 2;
  const startAng = Math.atan2(ny, nx);
  for (let i = 0; i <= half; i++) {
    const a = startAng + (i / half) * Math.PI;
    pts.push([x1 + r * Math.cos(a), y1 + r * Math.sin(a)]);
  }
  const endAng = Math.atan2(-ny, -nx);
  for (let i = 0; i <= half; i++) {
    const a = endAng + (i / half) * Math.PI;
    pts.push([x2 + r * Math.cos(a), y2 + r * Math.sin(a)]);
  }
  pts.push(pts[0]);
  return pts;
}

/** 绕原点旋转 deg(逆时针) */
function rotateRing(pts: Array<[number, number]>, deg: number): Array<[number, number]> {
  if (!deg) return pts;
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return pts.map(([x, y]): [number, number] => [x * c - y * s, x * s + y * c]);
}

// ---------------------------------------------------------------------------
// 宏表达式求值:$n 代换 + 四则运算
// ---------------------------------------------------------------------------

/** 求值宏参数表达式,如 "$1/2"、"0.5*$2"、"( $1 + $2 ) / 2" */
function evalMacroExpr(expr: string, args: number[]): number {
  const s = expr.replace(/\$(\d+)/g, (_m, d) => String(args[parseInt(d, 10) - 1] ?? 0));
  let pos = 0;
  const skipWs = () => {
    while (pos < s.length && /\s/.test(s[pos])) pos++;
  };
  const parseFactor = (): number => {
    skipWs();
    if (s[pos] === "-") {
      pos++;
      return -parseFactor();
    }
    if (s[pos] === "+") {
      pos++;
      return parseFactor();
    }
    if (s[pos] === "(") {
      pos++;
      const v = parseExpr();
      skipWs();
      if (s[pos] === ")") pos++;
      return v;
    }
    const m = /^[0-9]*\.?[0-9]+(?:[eE][-+]?\d+)?/.exec(s.slice(pos));
    if (!m) {
      pos++;
      return NaN;
    }
    pos += m[0].length;
    return parseFloat(m[0]);
  };
  const parseTerm = (): number => {
    let v = parseFactor();
    for (;;) {
      skipWs();
      const op = s[pos];
      if (op === "*" || op === "/") {
        pos++;
        const rhs = parseFactor();
        v = op === "*" ? v * rhs : v / rhs;
      } else break;
    }
    return v;
  };
  function parseExpr(): number {
    let v = parseTerm();
    for (;;) {
      skipWs();
      const op = s[pos];
      if (op === "+" || op === "-") {
        pos++;
        const rhs = parseTerm();
        v = op === "+" ? v + rhs : v - rhs;
      } else break;
    }
    return v;
  }
  const v = parseExpr();
  return isFinite(v) ? v : 0;
}

// ---------------------------------------------------------------------------
// 光圈(aperture): 标准图形 + 宏展开
// ---------------------------------------------------------------------------

interface Aperture {
  code: string;
  kind: PadPolygon["type"];
  /** flash 生成部件列表(局部坐标,中心在原点) */
  make: () => PadPart[];
  /** 描线等效宽度(短边/直径) */
  lineWidth: number;
}

interface MacroPrimitive {
  code: number;
  params: string[];
}

/** 解析 %AM 宏体:按 * 分原语,原语内按 , 分参数(保留表达式原文) */
function parseMacroBody(body: string): MacroPrimitive[] {
  const prims: MacroPrimitive[] = [];
  for (const chunk of body.split("*")) {
    const t = chunk.trim();
    if (!t) continue;
    const parts = t.split(",").map((s) => s.trim());
    const code = parseInt(parts[0], 10);
    if (!isFinite(code)) continue;
    if (code === 0) continue; // 注释原语
    prims.push({ code, params: parts.slice(1) });
  }
  return prims;
}

/** 展开宏原语 → 部件列表(局部坐标;曝光极性来自原语第1参数) */
function expandMacroPrimitives(
  prims: MacroPrimitive[], args: number[]
): PadPart[] {
  const parts: PadPart[] = [];
  const ev = (e: string): number => evalMacroExpr(e, args);

  for (const p of prims) {
    const v = p.params.map(ev);
    const exp = v[0] >= 0.5 ? "D" : "C"; // 1=曝光 0=擦除
    try {
      if (p.code === 1) {
        // 圆: 曝光,直径,cx,cy[,旋转]
        const [, d, cx, cy] = v;
        if (d <= 0) continue;
        parts.push({ polarity: exp, points: circleRing(cx, cy, d) });
      } else if (p.code === 2 || p.code === 20) {
        // 矢量线: 曝光,宽度,x1,y1,x2,y2,旋转
        const [, w, x1, y1, x2, y2, rot] = v;
        if (w <= 0) continue;
        parts.push({
          polarity: exp,
          points: rotateRing(capsuleRing(x1, y1, x2, y2, w), rot || 0),
        });
      } else if (p.code === 21) {
        // 中心矩形: 曝光,宽,高,cx,cy,旋转
        const [, w, h, cx, cy, rot] = v;
        if (w <= 0 || h <= 0) continue;
        parts.push({ polarity: exp, points: rotateRing(rectRing(cx, cy, w, h), rot || 0) });
      } else if (p.code === 22) {
        // 左下矩形: 曝光,宽,高,左下角x,y,旋转
        const [, w, h, llx, lly, rot] = v;
        if (w <= 0 || h <= 0) continue;
        parts.push({
          polarity: exp,
          points: rotateRing(rectRing(llx + w / 2, lly + h / 2, w, h), rot || 0),
        });
      } else if (p.code === 4) {
        // 轮廓: 曝光,顶点数n,起点x,y,n×(x,y),旋转
        const [, n, ...rest] = v;
        const nv = Math.max(3, Math.round(n || 3));
        const pts: Array<[number, number]> = [];
        for (let i = 0; i <= nv; i++) {
          const px = rest[i * 2];
          const py = rest[i * 2 + 1];
          if (px === undefined || py === undefined) break;
          pts.push([px, py]);
        }
        if (pts.length >= 4) {
          if (pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) {
            pts.pop();
          }
          const rot = rest[nv * 2 + 2] ?? 0;
          const closed: Array<[number, number]> = [...pts, pts[0]];
          parts.push({ polarity: exp, points: rotateRing(closed, rot || 0) });
        }
      } else if (p.code === 5) {
        // 正多边形: 曝光,顶点数,cx,cy,外接圆直径,旋转
        const [, n, cx, cy, d, rot] = v;
        const nv = Math.max(3, Math.round(n || 3));
        if (d <= 0) continue;
        parts.push({
          polarity: exp,
          points: regularPolygonRing(cx, cy, d, nv, rot || 0),
        });
      } else if (p.code === 6) {
        // moire 同心环+十字线: cx,cy,外径,环厚,间隙,环数,十字长,十字宽,旋转(无曝光参数,恒为暗)
        const [cx, cy, od, ringThk, gap, maxRings, chLen, chW, rot] = v;
        if (od > 0 && ringThk > 0) {
          for (let i = 0; i < Math.max(1, Math.round(maxRings || 1)); i++) {
            const outer = od - i * (ringThk + gap);
            const inner = outer - ringThk;
            if (outer <= 0 || inner <= 0) break;
            parts.push({
              polarity: "D",
              points: circleRing(cx, cy, outer),
              holes: [circleRing(cx, cy, inner)],
            });
          }
        }
        if (chLen > 0 && chW > 0) {
          // 十字线:水平+垂直两个矩形
          parts.push({
            polarity: "D",
            points: rotateRing(rectRing(cx, cy, chLen, chW), rot || 0),
          });
          parts.push({
            polarity: "D",
            points: rotateRing(rectRing(cx, cy, chW, chLen), rot || 0),
          });
        }
      } else if (p.code === 7) {
        // thermal 热焊盘: cx,cy,外径,内径,开口宽,旋转(无曝光参数;环=暗,开口=擦除)
        const [cx, cy, od, id, gapW, rot] = v;
        if (od > 0 && id > 0 && od > id) {
          parts.push({
            polarity: "D",
            points: circleRing(cx, cy, od),
            holes: [circleRing(cx, cy, id)],
          });
          if (gapW > 0) {
            // 4 个开口:沿两轴的擦除矩形(比外径略长,确保切断)
            const L = od + 1;
            for (const [w, h] of [
              [L, gapW],
              [gapW, L],
            ]) {
              parts.push({
                polarity: "C",
                points: rotateRing(rectRing(cx, cy, w, h), rot || 0),
              });
            }
          }
        }
      }
      // 未知原语码:跳过(计数由上层诊断)
    } catch {
      // 单个原语失败不影响其余
    }
  }
  return parts;
}

interface MacroDef {
  name: string;
  prims: MacroPrimitive[];
}

/** 解析 %ADD 光圈定义行 */
function parseAperture(
  line: string, macros: Map<string, MacroDef>
): Aperture | null {
  const m = line.match(/%ADD(\d+)([A-Za-z][A-Za-z0-9_]*)\s*(?:,([^*%]*))?\*%/i);
  if (!m) return null;
  const code = m[1];
  const name = m[2];
  const upper = name.toUpperCase();
  const params = (m[3] ?? "")
    .split(/[Xx]/)
    .filter((s) => s.trim().length > 0)
    .map((s) => parseFloat(s));
  const hasParams = params.length > 0 && isFinite(params[0]);
  const p = (i: number, dflt: number): number =>
    i < params.length && isFinite(params[i]) ? params[i] : dflt;
  const num = (i: number): number | null =>
    i < params.length && isFinite(params[i]) ? params[i] : null;

  const holeOf = (d: number | null): Array<Array<[number, number]>> | undefined =>
    d && d > 0 && d < params[0] ? [circleRing(0, 0, d)] : undefined;

  // 标准单字母光圈
  if (upper.length === 1 && "CROP".includes(upper)) {
    if (!hasParams) return null;
    if (upper === "C") {
      const d = params[0];
      return {
        code, kind: "circle", lineWidth: d,
        make: () => [{ polarity: "D", points: circleRing(0, 0, d), holes: holeOf(num(1)) }],
      };
    }
    if (upper === "R") {
      const w = params[0];
      const h = p(1, params[0]);
      const rot = p(2, 0);
      return {
        code, kind: "rect", lineWidth: Math.min(w, h),
        make: () => [{
          polarity: "D",
          points: rotateRing(rectRing(0, 0, w, h), rot),
          holes: holeOf(num(3)),
        }],
      };
    }
    if (upper === "O") {
      const w = params[0];
      const h = p(1, params[0]);
      const rot = p(2, 0);
      return {
        code, kind: "obround", lineWidth: Math.min(w, h),
        make: () => [{
          polarity: "D",
          points: rotateRing(obroundRing(0, 0, w, h), rot),
          holes: holeOf(num(3)),
        }],
      };
    }
    // P: 外接圆直径,顶点数,旋转[,孔]
    const d = params[0];
    const n = Math.max(3, Math.round(p(1, 6)));
    const rot = p(2, 0);
    return {
      code, kind: "polygon", lineWidth: d,
      make: () => [{
        polarity: "D",
        points: regularPolygonRing(0, 0, d, n, rot),
        holes: holeOf(num(3)),
      }],
    };
  }

  // 宏光圈:参数 = 宏的 $1..$n
  const macro = macros.get(upper);
  if (macro) {
    return {
      code, kind: "macro",
      lineWidth: params.length > 1 ? Math.min(params[0], params[1]) : (params[0] ?? 1),
      make: () => expandMacroPrimitives(macro.prims, params),
    };
  }

  // 未定义宏(如 %AM 块解析失败/未出现):按名称启发式兜底(需尺寸参数)
  if (!hasParams) return null;
  if (/ROUNDRECT/.test(upper)) {
    const w = params[0];
    const h = p(1, params[0]);
    const r = p(2, 0);
    const rot = p(3, 0);
    return {
      code, kind: "roundrect", lineWidth: Math.min(w, h),
      make: () => [{ polarity: "D", points: rotateRing(roundRectRing(0, 0, w, h, r), rot) }],
    };
  }
  if (/OVAL|OBROUND/.test(upper)) {
    const w = params[0];
    const h = p(1, params[0]);
    return {
      code, kind: "obround", lineWidth: Math.min(w, h),
      make: () => [{ polarity: "D", points: obroundRing(0, 0, w, h) }],
    };
  }
  if (/RECT|SQUARE/.test(upper)) {
    const w = params[0];
    const h = p(1, params[0]);
    return {
      code, kind: "rect", lineWidth: Math.min(w, h),
      make: () => [{ polarity: "D", points: rectRing(0, 0, w, h) }],
    };
  }
  if (/CIRC|THERMAL|DONUT/.test(upper)) {
    const d = params[0];
    return {
      code, kind: "circle", lineWidth: d,
      make: () => [{ polarity: "D", points: circleRing(0, 0, d) }],
    };
  }
  // 完全未知:矩形/圆兜底(至少保住开孔)
  if (params.length > 1) {
    const w = params[0];
    const h = params[1];
    return {
      code, kind: "rect", lineWidth: Math.min(w, h),
      make: () => [{ polarity: "D", points: rectRing(0, 0, w, h) }],
    };
  }
  return {
    code, kind: "circle", lineWidth: params[0],
    make: () => [{ polarity: "D", points: circleRing(0, 0, params[0]) }],
  };
}

// ---------------------------------------------------------------------------
// 圆弧离散(G74 单象限 / G75 多象限)
// ---------------------------------------------------------------------------

interface ArcParams {
  cx: number;
  cy: number;
  ccw: boolean;
  r: number;
}

/**
 * 计算圆弧圆心。
 * G75: I/J 为带符号相对偏移,直接得圆心。
 * G74: I/J 无符号,圆心在 4 个象限候选中选使弧 ≤90° 且方向正确的那个。
 * 返回 null 表示退化(按直线处理)。
 */
function arcCenter(
  x1: number, y1: number, x2: number, y2: number,
  i: number, j: number, ccw: boolean, multiQuadrant: boolean
): ArcParams | null {
  if (multiQuadrant) {
    const cx = x1 + i;
    const cy = y1 + j;
    const r = Math.hypot(x1 - cx, y1 - cy);
    if (r < 1e-9) return null;
    return { cx, cy, ccw, r };
  }
  // G74: 候选圆心
  const ai = Math.abs(i);
  const aj = Math.abs(j);
  if (ai < 1e-9 && aj < 1e-9) return null;
  const candidates: Array<[number, number]> = [
    [x1 + ai, y1 + aj],
    [x1 + ai, y1 - aj],
    [x1 - ai, y1 + aj],
    [x1 - ai, y1 - aj],
  ];
  for (const [cx, cy] of candidates) {
    const r1 = Math.hypot(x1 - cx, y1 - cy);
    const r2 = Math.hypot(x2 - cx, y2 - cy);
    if (r1 < 1e-9 || Math.abs(r1 - r2) > Math.max(0.05, r1 * 0.05)) continue;
    // 计算扫过角度(有向)
    const a1 = Math.atan2(y1 - cy, x1 - cx);
    const a2 = Math.atan2(y2 - cy, x2 - cx);
    let sweep = a2 - a1;
    if (ccw && sweep < 0) sweep += TWO_PI;
    if (!ccw && sweep > 0) sweep -= TWO_PI;
    const absSweep = Math.abs(sweep);
    // 单象限:扫角 ≤ 90°(+容差)
    if (absSweep <= Math.PI / 2 + 0.02) {
      return { cx, cy, ccw, r: r1 };
    }
  }
  return null;
}

/** 圆弧离散为点列(含起点终点) */
function discretizeArc(
  x1: number, y1: number, x2: number, y2: number, arc: ArcParams
): Array<[number, number]> {
  const a1 = Math.atan2(y1 - arc.cy, x1 - arc.cx);
  const a2 = Math.atan2(y2 - arc.cy, x2 - arc.cx);
  let sweep = a2 - a1;
  if (arc.ccw && sweep <= 0) sweep += TWO_PI;
  if (!arc.ccw && sweep >= 0) sweep -= TWO_PI;
  const steps = Math.max(
    2,
    Math.ceil((Math.abs(sweep) / (Math.PI / 2)) * ARC_SEG_PER_90)
  );
  const pts: Array<[number, number]> = [];
  for (let k = 0; k <= steps; k++) {
    const a = a1 + (sweep * k) / steps;
    pts.push([arc.cx + arc.r * Math.cos(a), arc.cy + arc.r * Math.sin(a)]);
  }
  return pts;
}

// ---------------------------------------------------------------------------
// 主解析器
// ---------------------------------------------------------------------------

/** 图层线性变换(LS/LM/LR),逐顶点应用 */
function applyTf(
  x: number, y: number,
  tf: { mx: boolean; my: boolean; rot: number; scale: number } | undefined
): [number, number] {
  if (!tf) return [x, y];
  let nx = x * tf.scale;
  let ny = y * tf.scale;
  if (tf.mx) ny = -ny;
  if (tf.my) nx = -nx;
  if (tf.rot) {
    const a = (tf.rot * Math.PI) / 180;
    const c = Math.cos(a);
    const s = Math.sin(a);
    const rx = nx * c - ny * s;
    const ry = nx * s + ny * c;
    nx = rx;
    ny = ry;
  }
  return [nx, ny];
}

export function extractPads(text: string): ExtractPadsResult {
  const pads: PadPolygon[] = [];
  const apertures = new Map<string, Aperture>();
  const macros = new Map<string, MacroDef>();
  let currentAperture: Aperture | null = null;

  // 格式
  let places: [number, number] = [3, 6];
  let units: "mm" | "in" | null = null;
  const inToMm = 25.4;
  const toMm = (raw: number): number => {
    const v = raw / Math.pow(10, places[1]);
    return units === "in" ? v * inToMm : v;
  };

  // 当前位置(mm)
  let curX = 0;
  let curY = 0;

  // 插补模式
  let interp: 1 | 2 | 3 = 1; // G01/G02/G03
  let multiQuadrant = true; // G75 默认(多数现代文件);G74 显式声明
  let imagePolarity: "D" | "C" = "D";

  // 图层变换
  let tfMx = false;
  let tfMy = false;
  let tfRot = 0;
  let tfScale = 1;
  const tfSnapshot = () =>
    tfMx || tfMy || tfRot !== 0 || tfScale !== 1
      ? { mx: tfMx, my: tfMy, rot: tfRot, scale: tfScale }
      : undefined;

  // 区域模式(G36/G37)
  let inRegion = false;
  let regionContours: Array<Array<[number, number]>> = [];
  let curContour: Array<[number, number]> = [];
  let regionLastOp: "move" | "draw" | null = null;

  // 步进重复(%SR)
  let srActive = false;
  let srNx = 1;
  let srNy = 1;
  let srDx = 0;
  let srDy = 0;
  let srBuffer: PadPolygon[] = [];

  // %AB 块深度
  let abDepth = 0;

  // 宏定义收集
  let inMacroDef = false;
  let macroName = "";
  let macroBody = "";

  let flashCount = 0;
  let lineCount = 0;
  let regionCount = 0;
  let skippedFlashes = 0;
  let skippedLines = 0;
  let skippedBlockGraphics = 0;

  const emit = (pad: PadPolygon) => {
    if (srActive) srBuffer.push(pad);
    else pads.push(pad);
  };

  /** flush SR 缓冲:按步进复制 */
  const flushSR = () => {
    if (!srActive) return;
    srActive = false;
    for (let iy = 0; iy < srNy; iy++) {
      for (let ix = 0; ix < srNx; ix++) {
        if (ix === 0 && iy === 0) {
          pads.push(...srBuffer);
        } else {
          for (const pad of srBuffer) {
            const dx = ix * srDx;
            const dy = iy * srDy;
            pads.push({
              ...pad,
              cx: pad.cx + dx,
              cy: pad.cy + dy,
              parts: pad.parts.map((pt) => ({
                ...pt,
                points: pt.points.map(([x, y]): [number, number] => [x + dx, y + dy]),
                holes: pt.holes?.map((h) =>
                  h.map(([x, y]): [number, number] => [x + dx, y + dy])
                ),
              })),
            });
          }
        }
      }
    }
    srBuffer = [];
  };

  /** 区域结束 → 焊盘 */
  const closeRegion = () => {
    if (curContour.length >= 3) regionContours.push(curContour);
    curContour = [];
    regionLastOp = null;
    if (regionContours.length > 0) {
      const outer = regionContours[0];
      const holes = regionContours.slice(1);
      let sx = 0;
      let sy = 0;
      for (const [px, py] of outer) {
        sx += px;
        sy += py;
      }
      emit({
        type: "region",
        cx: sx / outer.length,
        cy: sy / outer.length,
        polarity: imagePolarity,
        parts: [
          {
            polarity: "D",
            points: outer[outer.length - 1] === outer[0] ? outer : [...outer, outer[0]],
            holes: holes.length > 0 ? holes : undefined,
          },
        ],
      });
      regionCount++;
    }
    regionContours = [];
  };

  /** D03 flash */
  const doFlash = (x: number, y: number) => {
    const tf = tfSnapshot();
    const [px, py] = applyTf(x, y, tf);
    if (!currentAperture) {
      skippedFlashes++;
      return;
    }
    const parts = currentAperture.make().map((pt) => ({
      ...pt,
      points: pt.points.map(([vx, vy]): [number, number] => {
        const [tx, ty] = applyTf(vx + px, vy + py, tf);
        return [tx, ty];
      }),
      holes: pt.holes?.map((h) =>
        h.map(([vx, vy]): [number, number] => {
          const [tx, ty] = applyTf(vx + px, vy + py, tf);
          return [tx, ty];
        })
      ),
    }));
    emit({ type: currentAperture.kind, cx: px, cy: py, polarity: imagePolarity, parts });
    flashCount++;
  };

  /** D01 描线(直线或圆弧);局部坐标(未变换) */
  const doStroke = (
    x1: number, y1: number, x2: number, y2: number,
    i: number | null, j: number | null
  ) => {
    const tf = tfSnapshot();
    if (!currentAperture) {
      skippedLines++;
      return;
    }
    const w = currentAperture.lineWidth * Math.abs(tfScale);
    // 圆弧:先在局部坐标离散,再逐点变换
    let pathPts: Array<[number, number]>;
    if ((interp === 2 || interp === 3) && i !== null) {
      const arc = arcCenter(x1, y1, x2, y2, i, j ?? 0, interp === 3, multiQuadrant);
      if (arc) {
        pathPts = discretizeArc(x1, y1, x2, y2, arc).map(([x, y]) => applyTf(x, y, tf));
      } else {
        pathPts = [applyTf(x1, y1, tf), applyTf(x2, y2, tf)];
      }
    } else {
      pathPts = [applyTf(x1, y1, tf), applyTf(x2, y2, tf)];
    }
    for (let k = 0; k + 1 < pathPts.length; k++) {
      const [ax, ay] = pathPts[k];
      const [bx, by] = pathPts[k + 1];
      emit({
        type: interp !== 1 ? "arc" : "line",
        cx: (ax + bx) / 2,
        cy: (ay + by) / 2,
        polarity: imagePolarity,
        parts: [{ polarity: "D", points: capsuleRing(ax, ay, bx, by, w) }],
      });
    }
    lineCount++;
  };

  const lines = text.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("G04")) continue;

    // --- %AM 宏定义块(单行或多行) ---
    if (inMacroDef) {
      macroBody += "\n" + line;
      if (/%\s*$/.test(rawLine)) {
        macros.set(macroName, { name: macroName, prims: parseMacroBody(macroBody) });
        inMacroDef = false;
      }
      continue;
    }
    const amMatch = line.match(/^%AM([A-Za-z][A-Za-z0-9_]*)\*?(.*)$/i);
    if (amMatch) {
      macroName = amMatch[1].toUpperCase();
      macroBody = amMatch[2] ?? "";
      // 单行闭合 "%AMNAME*...*%"
      if (/%\s*$/.test(rawLine)) {
        macros.set(macroName, { name: macroName, prims: parseMacroBody(macroBody) });
      } else {
        inMacroDef = true;
      }
      continue;
    }

    // --- %AB 光圈块:整块跳过(锡膏层极罕见) ---
    const abMatch = line.match(/^%AB\s*([A-Za-z0-9_]*)/i);
    if (abMatch) {
      if (abMatch[1]) abDepth++;
      else abDepth = Math.max(0, abDepth - 1);
      continue;
    }
    if (abDepth > 0) {
      if (/[XY]-?\d/.test(line)) skippedBlockGraphics++;
      continue;
    }

    // --- 扩展命令 ---
    if (line.startsWith("%")) {
      const fsMatch = rawLine.match(/%FS([LT])?AX(\d)(\d)Y(\d)(\d)\*%/);
      if (fsMatch) places = [parseInt(fsMatch[2], 10), parseInt(fsMatch[3], 10)];
      const moMatch = rawLine.match(/%MO(IN|MM)\*%/i);
      if (moMatch) units = moMatch[1].toUpperCase() === "MM" ? "mm" : "in";
      const lmMatch = rawLine.match(/%LM(XY|X|Y)?\*%/i);
      if (lmMatch) {
        const m = (lmMatch[1] || "").toUpperCase();
        tfMx = m.includes("X");
        tfMy = m.includes("Y");
      }
      const lrMatch = rawLine.match(/%LR(-?[\d.]+)?\*%/i);
      if (lrMatch) tfRot = lrMatch[1] ? parseFloat(lrMatch[1]) : 0;
      const lsMatch = rawLine.match(/%LS(-?[\d.]+)?\*%/i);
      if (lsMatch) tfScale = lsMatch[1] ? parseFloat(lsMatch[1]) : 1;
      const lpMatch = rawLine.match(/%LP([DC])\*%/i);
      if (lpMatch) imagePolarity = lpMatch[1].toUpperCase() === "C" ? "C" : "D";
      // %SR 步进重复
      const srMatch = rawLine.match(/%SRX(\d+)Y(\d+)X(-?[\d.]+)Y(-?[\d.]+)\*%/i);
      if (srMatch) {
        flushSR();
        const nx = parseInt(srMatch[1], 10);
        const ny = parseInt(srMatch[2], 10);
        if (nx > 0 && ny > 0 && (nx > 1 || ny > 1)) {
          srActive = true;
          srNx = nx;
          srNy = ny;
          srDx = parseFloat(srMatch[3]);
          srDy = parseFloat(srMatch[4]);
          srBuffer = [];
        }
      } else if (/^%SR/i.test(rawLine)) {
        // %SR 结束块(无参数)
        flushSR();
      }
      // %ADD 光圈定义(其余 % 命令忽略)
      const ap = parseAperture(rawLine, macros);
      if (ap) apertures.set(ap.code, ap);
      continue;
    }

    // --- 光圈选择(独立行):D nn ≥ 10;G54 旧式;不吞 D01/02/03 ---
    const dSelMatch = line.match(/^(?:G5[04])?D(\d+)\*$/);
    if (dSelMatch && parseInt(dSelMatch[1], 10) >= 10) {
      currentAperture = apertures.get(dSelMatch[1]) ?? null;
      continue;
    }

    // --- 坐标/图形行 ---
    let work = line;
    // 行内光圈选择: "D10X100Y100D03*"
    const inlineSel = work.match(/^D(\d{2,})(?=[XYIJD])/);
    if (inlineSel) {
      currentAperture = apertures.get(inlineSel[1]) ?? null;
      work = work.slice(inlineSel[0].length);
    }

    // G 码(可多个/带坐标)
    for (const g of work.matchAll(/G0*([1-9]\d*)/g)) {
      const n = parseInt(g[1], 10);
      if (n === 1) interp = 1;
      else if (n === 2) interp = 2;
      else if (n === 3) interp = 3;
      else if (n === 4) multiQuadrant = false; // G74
      else if (n === 5) multiQuadrant = true; // G75
      else if (n === 36) {
        inRegion = true;
        regionContours = [];
        curContour = [];
        regionLastOp = null;
      } else if (n === 37) {
        if (inRegion) {
          closeRegion();
          inRegion = false;
        }
      }
      // 其余 G 码(G54 已处理/G70/G71/G90/G91)忽略
    }

    // D 操作码(缺省 = 延续上一操作)
    let op: 1 | 2 | 3 | null = null;
    if (/D0?1\*?\s*$/.test(work)) op = 1;
    else if (/D0?2\*?\s*$/.test(work)) op = 2;
    else if (/D0?3\*?\s*$/.test(work)) op = 3;

    const xMatch = work.match(/X(-?\d+)/);
    const yMatch = work.match(/Y(-?\d+)/);
    const iMatch = work.match(/I(-?\d+)/);
    const jMatch = work.match(/J(-?\d+)/);
    if (!xMatch && !yMatch && !iMatch && !jMatch) {
      // 无坐标的独立操作行:如 "D03*"(在当前位置 flash)
      if (!inRegion && op === 3) doFlash(curX, curY);
      continue;
    }

    const rawX = xMatch ? parseInt(xMatch[1], 10) : null;
    const rawY = yMatch ? parseInt(yMatch[1], 10) : null;
    const x = rawX !== null ? toMm(rawX) : curX;
    const y = rawY !== null ? toMm(rawY) : curY;
    const i = iMatch ? toMm(parseInt(iMatch[1], 10)) : null;
    const j = jMatch ? toMm(parseInt(jMatch[1], 10)) : null;

    if (inRegion) {
      if (op === 2) {
        if (curContour.length >= 3) regionContours.push(curContour);
        curContour = [[x, y]];
        regionLastOp = "move";
      } else if (op === 1 || op === null) {
        const isDraw =
          op === 1 ||
          (op === null && (regionLastOp === "draw" || curContour.length > 1));
        if (isDraw) {
          if (curContour.length === 0) curContour.push([curX, curY]);
          if ((interp === 2 || interp === 3) && i !== null) {
            const arc = arcCenter(curX, curY, x, y, i, j ?? 0, interp === 3, multiQuadrant);
            if (arc) {
              for (const pt of discretizeArc(curX, curY, x, y, arc)) curContour.push(pt);
            } else {
              curContour.push([x, y]);
            }
          } else {
            curContour.push([x, y]);
          }
          regionLastOp = "draw";
        } else if (op === null && regionLastOp === "move" && curContour.length === 1) {
          // 裸坐标延续 move:更新轮廓起点
          curContour[0] = [x, y];
        }
      }
    } else if (op === 3) {
      doFlash(x, y);
    } else if (op === 1) {
      doStroke(curX, curY, x, y, i, j);
    }
    // op === 2 或纯 move:仅移动

    curX = x;
    curY = y;
  }

  // EOF 收尾
  if (inRegion) closeRegion();
  flushSR();

  return {
    pads,
    units,
    apertureCount: apertures.size,
    flashCount,
    lineCount,
    regionCount,
    skippedFlashes,
    skippedLines,
    skippedBlockGraphics,
  };
}
