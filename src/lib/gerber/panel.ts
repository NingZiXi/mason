/**
 * 拼版 / 单板两种口径的派生结果
 *
 * 同一个拼版 Gerber 可以按两种口径建模:
 * - panel  整版:外框取含工艺边 / V-CUT 框的整体范围,焊盘全量
 * - single 单板:只取其中一块板的外框,焊盘按该块外框过滤
 *
 * 两种口径都做居中(各自以外框 bbox 中心为原点),由调用方按用户选择取用。
 */

import type { GerberBoardOutline, GerberOutline } from "./parser";
import type { PadPolygon } from "./pads";
import { pointInPolygon } from "./geometry";

export type PanelMode = "panel" | "single" | "board";

export interface PanelVariant {
  /** 子板稳定编号(仅 boards 条目使用) */
  id?: string;
  /** 子板显示名称 */
  label?: string;
  /** Board boundaries inferred from connecting tabs rather than explicit outlines. */
  inferred?: boolean;
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

export interface GerberVariants {
  panel: PanelVariant;
  single: PanelVariant;
  boards?: PanelVariant[];
  hasPads: boolean;
}

export interface GerberImportPayload {
  filename: string;
  /** 文件是否识别为拼版 */
  isPanel: boolean;
  /** 拼版阵列(仅 %SR 声明时存在) */
  panelGrid?: { nx: number; ny: number };
  panel: PanelVariant;
  single: PanelVariant;
  /** 混合拼版中的可选子板 */
  boards?: PanelVariant[];
}

interface PanelVariantSet {
  panel: PanelVariant;
  single: PanelVariant; // Legacy automatic selection; never shown as a third scope.
  boards?: PanelVariant[];
}

export function getPanelBoards(variants: PanelVariantSet): PanelVariant[] {
  return variants.boards?.length ? variants.boards : [variants.single];
}

/** Normalize legacy single-board choices into the explicit board selector. */
export function resolvePanelSelection(variants: PanelVariantSet, mode: PanelMode, index?: number | null) {
  if (mode === "panel") return { mode: "panel" as const, index: null, variant: variants.panel };
  const boards = getPanelBoards(variants);
  const selected = mode === "single" ? boards.indexOf(variants.single) : index;
  // An automatic single-board variant may be a separate object representing
  // exactly the same board. Match position and dimensions before defaulting.
  const legacyIndex = mode === "single" && selected === -1 ? boards.findIndex((board) =>
    Math.abs(board.width - variants.single.width) < 1e-6 && Math.abs(board.height - variants.single.height) < 1e-6 &&
    Math.abs(board.center.x - variants.single.center.x) < 1e-6 && Math.abs(board.center.y - variants.single.center.y) < 1e-6
  ) : selected;
  const boardIndex = Number.isInteger(legacyIndex)
    ? Math.max(0, Math.min(legacyIndex!, boards.length - 1)) : 0;
  return { mode: "board" as const, index: boardIndex, variant: boards[boardIndex] };
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
  outline: GerberOutline | GerberBoardOutline,
  topPads?: PadPolygon[],
  bottomPads?: PadPolygon[],
  identity?: { id?: string; label?: string }
): PanelVariant {
  const { minX, minY, maxX, maxY } = outline.bbox;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;

  // Check the actual polygon as well as the bounds: interlocking boards may
  // share a bounding box without sharing any PCB material.
  const inside = (p: PadPolygon) =>
    p.cx >= minX - 1e-6 && p.cx <= maxX + 1e-6 &&
    p.cy >= minY - 1e-6 && p.cy <= maxY + 1e-6 &&
    pointInPolygon(p.cx, p.cy, outline.points) &&
    !outline.holes.some((hole) => pointInPolygon(p.cx, p.cy, hole));

  return {
    ...identity,
    ...("inferred" in outline && outline.inferred ? { inferred: true } : {}),
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
