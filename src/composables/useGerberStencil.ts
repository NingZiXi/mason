/**
 * useGerberStencil - 处理 Gerber ZIP,同时提取板框(卡槽形状)+ 双面锡膏焊盘
 *
 * 工作流:
 * 1. JSZip 解压
 * 2. detectOutlineFiles 找板框,detectPasteFiles 找锡膏层并区分 Top/Bottom 面
 * 3. extractOutline + extractPads 分别解析(两面各一份)
 * 4. 以板框 bbox 中心为原点,统一平移 outline 和两面的 pads
 * 5. 返回 reactive 结果
 *
 * 注意:两面焊盘均保持居中后的原始坐标;物理使用约定(与 Dream_maker
 * 实机验证一致)由 Python 生成时处理 —— 顶层钢网翻面入槽做 Y 镜像,
 * 底层钢网板子正放用原坐标。
 */
import { ref, computed } from "vue";
import JSZip from "jszip";
import { extractOutline, type GerberOutline } from "../lib/gerber/parser";
import { extractPads, type PadPolygon } from "../lib/gerber/pads";
import { detectOutlineFiles } from "../lib/gerber/outline-detect";
import { detectPasteFiles, pickPasteBySide } from "../lib/gerber/paste-detect";

export interface GerberStencilResult {
  /** 板框外框多边形(已居中) */
  outlinePoints: Array<[number, number]>;
  /** 板框内孔(已居中) */
  outlineHoles: Array<Array<[number, number]>>;
  /** 顶层(Top Paste)焊盘多边形列表(已居中,与板框同坐标系) */
  topPads: PadPolygon[];
  /** 底层(Bottom Paste)焊盘多边形列表(已居中,与板框同坐标系) */
  bottomPads: PadPolygon[];
  /** PCB 尺寸 mm */
  width: number;
  height: number;
  /** 板框原始 bbox 中心 */
  bboxCenter: { x: number; y: number };
  /** 文件名(诊断) */
  outlineFile: string;
  topPasteFile: string | null;
  bottomPasteFile: string | null;
  /** 焊盘数量 */
  padCount: number;
  /** 因光圈缺失等被跳过的图形数(>0 表示文件存在兼容问题) */
  skipped: number;
}

export function useGerberStencil() {
  const loading = ref(false);
  const error = ref<string | null>(null);
  const result = ref<GerberStencilResult | null>(null);

  const hasResult = computed(() => result.value !== null);
  const padCount = computed(() => result.value?.padCount ?? 0);

  async function processFile(file: File): Promise<void> {
    loading.value = true;
    error.value = null;
    result.value = null;

    try {
      const lower = file.name.toLowerCase();
      if (lower.endsWith(".zip")) {
        await processZip(file);
      } else if (
        lower.endsWith(".gtp") ||
        lower.endsWith(".gbp") ||
        lower.endsWith(".gbr")
      ) {
        await processSingleGerber(file);
      } else {
        throw new Error(
          `不支持的文件类型: ${file.name}。请提供 .zip(含板框+锡膏层)或锡膏 Gerber (.gtp/.gbp/.gbr)`
        );
      }
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
    } finally {
      loading.value = false;
    }
  }

  async function processZip(file: File): Promise<void> {
    const zip = await JSZip.loadAsync(file);
    const filenames = Object.keys(zip.files).filter((n) => !zip.files[n].dir);

    const outlineCands = detectOutlineFiles(filenames);
    const pasteCands = detectPasteFiles(filenames);

    if (pasteCands.length === 0) {
      throw new Error(
        "ZIP 中未找到锡膏层 Gerber (期望 .GTP/.GBP 或文件名含 paste)"
      );
    }

    const { top, bottom } = pickPasteBySide(pasteCands);
    if (!top && !bottom) {
      throw new Error("未能识别任何锡膏层文件");
    }

    // 板框可选;没有板框时用锡膏层 bbox 作为卡槽形状
    const outlineFile = outlineCands[0]?.filename ?? null;

    const topText = top ? await zip.files[top.filename].async("string") : null;
    const bottomText = bottom ? await zip.files[bottom.filename].async("string") : null;
    const outlineText = outlineFile
      ? await zip.files[outlineFile].async("string")
      : null;

    finalize(
      topText,
      bottomText,
      outlineText,
      top?.filename ?? null,
      bottom?.filename ?? null,
      outlineFile ?? "(锡膏层 bbox)"
    );
  }

  async function processSingleGerber(file: File): Promise<void> {
    const text = await file.text();
    // 单文件模式:无板框 → 卡槽用锡膏层 bbox;扩展名判面,无法判断归 Top
    const lower = file.name.toLowerCase();
    const isBottom = lower.endsWith(".gbp") || lower.endsWith(".gpb");
    finalize(
      isBottom ? null : text,
      isBottom ? text : null,
      null,
      isBottom ? null : file.name,
      isBottom ? file.name : null,
      "(锡膏层 bbox)"
    );
  }

  function finalize(
    topText: string | null,
    bottomText: string | null,
    outlineText: string | null,
    topPasteFile: string | null,
    bottomPasteFile: string | null,
    outlineFile: string
  ): void {
    const topResult = topText ? extractPads(topText) : null;
    const bottomResult = bottomText ? extractPads(bottomText) : null;

    if (!topResult?.pads.length && !bottomResult?.pads.length) {
      throw new Error("锡膏层未解析到任何焊盘,请检查文件");
    }

    const anyPads = topResult?.pads.length ? topResult.pads : bottomResult!.pads;

    // 板框:优先用 outline 层,否则用 pads 的 bbox 生成矩形
    let outline: GerberOutline;
    if (outlineText) {
      outline = extractOutline(outlineText);
      if (outline.points.length < 3) {
        // 板框解析失败,回退到 pads bbox
        outline = bboxToOutline(anyPads);
      }
    } else {
      outline = bboxToOutline(anyPads);
    }

    // 统一居中:以板框 bbox 中心为原点
    const cx = (outline.bbox.minX + outline.bbox.maxX) / 2;
    const cy = (outline.bbox.minY + outline.bbox.maxY) / 2;

    const centeredOutline = outline.points.map(
      ([x, y]): [number, number] => [x - cx, y - cy]
    );
    const centeredHoles = outline.holes.map((h) =>
      h.map(([x, y]): [number, number] => [x - cx, y - cy])
    );
    const centerPads = (pads: PadPolygon[]): PadPolygon[] =>
      pads.map((p) => ({
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
    const centeredTop = topResult ? centerPads(topResult.pads) : [];
    const centeredBottom = bottomResult ? centerPads(bottomResult.pads) : [];

    result.value = {
      outlinePoints: centeredOutline,
      outlineHoles: centeredHoles,
      topPads: centeredTop,
      bottomPads: centeredBottom,
      width: outline.bbox.maxX - outline.bbox.minX,
      height: outline.bbox.maxY - outline.bbox.minY,
      bboxCenter: { x: cx, y: cy },
      outlineFile,
      topPasteFile,
      bottomPasteFile,
      padCount: centeredTop.length + centeredBottom.length,
      skipped:
        (topResult?.skippedFlashes ?? 0) + (topResult?.skippedLines ?? 0) +
        (bottomResult?.skippedFlashes ?? 0) + (bottomResult?.skippedLines ?? 0),
    };
  }

  /** 无板框时,用 pads 的 bbox 生成矩形板框 */
  function bboxToOutline(pads: PadPolygon[]): GerberOutline {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of pads) {
      for (const part of p.parts) {
        for (const [x, y] of part.points) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    // 留 0.1mm 余量
    minX -= 0.1; minY -= 0.1; maxX += 0.1; maxY += 0.1;
    const points: Array<[number, number]> = [
      [minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY], [minX, minY],
    ];
    return {
      points,
      holes: [],
      bbox: { minX, minY, maxX, maxY, units: "mm", commandCount: 0 },
      units: "mm",
      arcsLinearized: 0,
      totalCommands: 0,
    };
  }

  function reset(): void {
    loading.value = false;
    error.value = null;
    result.value = null;
  }

  return {
    loading,
    error,
    result,
    padCount,
    processFile,
    reset,
    hasResult,
  };
}
