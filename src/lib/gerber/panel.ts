/**
 * 拼版 / 单板两种口径的派生结果
 *
 * 同一个拼版 Gerber 可以按两种口径建模:
 * - panel  整版:外框取含工艺边 / V-CUT 框的整体范围,焊盘全量
 * - single 单板:只取其中一块板的外框,焊盘按该块外框过滤
 *
 * 两种口径都做居中(各自以外框 bbox 中心为原点),由调用方按用户选择取用。
 */

import type { GerberOutline } from "./parser";
import type { PadPolygon } from "./pads";

export type PanelMode = "panel" | "single";

export interface PanelVariant {
  /** 外框多边形(已居中) */
  outlinePoints: Array<[number, number]>;
  /** 内孔(已居中) */
  outlineHoles: Array<Array<[number, number]>>;
  /** 锡膏焊盘(已居中);纯板框导入时为 undefined，应用时清除旧焊盘 */
  topPads?: PadPolygon[];
  bottomPads?: PadPolygon[];
  width: number;
  height: number;
  /** 外框原始 bbox 中心 */
  center: { x: number; y: number };
}

export interface GerberImportPayload {
  filename: string;
  /** 文件是否识别为拼版 */
  isPanel: boolean;
  /** 拼版阵列(仅 %SR 声明时存在) */
  panelGrid?: { nx: number; ny: number };
  panel: PanelVariant;
  single: PanelVariant;
}

/** 把焊盘点列平移到以 (cx, cy) 为原点 */
function centerPads(
  pads: PadPolygon[],
  cx: number,
  cy: number
): PadPolygon[] {
  return pads.map((p) => ({
    ...p,
    cx: p.cx - cx,
    cy: p.cy - cy,
    parts: p.parts.map((pt) => ({
      ...pt,
      points: pt.points.map(([x, y]): [number, number] => [x - cx, y - cy]),
      holes: pt.holes?.map((h) =>
        h.map(([x, y]): [number, number] => [x - cx, y - cy])
      ),
    })),
  }));
}

/** 由一条板框轮廓 + 焊盘生成某一口径的建模输入 */
export function makePanelVariant(
  outline: GerberOutline,
  topPads?: PadPolygon[],
  bottomPads?: PadPolygon[]
): PanelVariant {
  const { minX, minY, maxX, maxY } = outline.bbox;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;

  // 只保留外框范围内的焊盘:整版口径下即全量,单板口径下即该块板上的焊盘
  const inside = (p: PadPolygon) =>
    p.cx >= minX - 1e-6 && p.cx <= maxX + 1e-6 &&
    p.cy >= minY - 1e-6 && p.cy <= maxY + 1e-6;

  return {
    outlinePoints: outline.points.map(
      ([x, y]): [number, number] => [x - cx, y - cy]
    ),
    outlineHoles: outline.holes.map((h) =>
      h.map(([x, y]): [number, number] => [x - cx, y - cy])
    ),
    topPads: topPads ? centerPads(topPads.filter(inside), cx, cy) : undefined,
    bottomPads: bottomPads ? centerPads(bottomPads.filter(inside), cx, cy) : undefined,
    width: maxX - minX,
    height: maxY - minY,
    center: { x: cx, y: cy },
  };
}
