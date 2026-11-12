/**
 * useGerberOutline - 处理用户上传的 Gerber ZIP 文件,提取 PCB 板框尺寸 + 实际多边形
 *
 * 工作流:
 * 1. JSZip 解压 ZIP
 * 2. detectOutlineFiles 找板框 Gerber
 * 3. extractOutline 解析(返回多边形点 + 弧线已线性化)
 * 4. 计算 bbox(包围盒)
 * 5. 把多边形点平移到以 bbox 中心为原点(方便 SCAD 居中放置)
 * 6. 返回 reactive 结果供 UI 使用
 */
import { ref, computed, shallowRef } from "vue";
import { GerberImportError, formatImportError } from '../lib/gerber/import-error';
import { extractOutline, type GerberOutline } from "../lib/gerber/parser";
import { makePanelVariant, type PanelVariant } from "../lib/gerber/panel";
import { detectOutlineFiles, type OutlineCandidate } from "../lib/gerber/outline-detect";

export interface GerberOutlineResult {
  bbox: GerberOutline["bbox"];
  filename: string;
  width: number;  // mm
  height: number; // mm
  /** 外框多边形点(已闭合),坐标 = 原 Gerber 坐标 - bbox 中心(居中) */
  outlinePoints: Array<[number, number]>;
  /** 内孔轮廓(已闭合,同 outer 坐标系)— 板内开槽的 PCB */
  holes: Array<Array<[number, number]>>;
  /** 多边形原始包围盒中心(用于 debug) */
  bboxCenter: { x: number; y: number };
  parse: GerberOutline;
  /** 整版 / 单板两套口径(默认字段为整版) */
  variants: { panel: PanelVariant; single: PanelVariant; boards?: PanelVariant[] };
}

export function useGerberOutline() {
  const loading = ref(false);
  const failure = shallowRef<unknown>(null);
  const error = computed(() => formatImportError(failure.value));
  const result = ref<GerberOutlineResult | null>(null);
  const candidates = ref<OutlineCandidate[]>([]);
  let revision = 0;

  const hasResult = computed(() => result.value !== null);

  /**
   * 处理用户上传的文件(支持 .zip,或单个 .gko/.gbr)
   */
  async function processFile(file: File): Promise<GerberOutlineResult | null> {
    const token = ++revision;
    loading.value = true;
    failure.value = null;
    result.value = null;
    candidates.value = [];

    try {
      const lower = file.name.toLowerCase();
      let parsed: { result: GerberOutlineResult; candidates: OutlineCandidate[] };
      if (lower.endsWith(".zip")) {
        parsed = await processZip(file);
      } else if (
        lower.endsWith(".gko") ||
        lower.endsWith(".gm1") ||
        lower.endsWith(".gme") ||
        lower.endsWith(".gbr")
      ) {
        parsed = await processSingleGerber(file);
      } else {
        throw new GerberImportError('gerber.unsupportedOutline', { name: file.name });
      }
      if (token !== revision) return null;
      result.value = parsed.result;
      candidates.value = parsed.candidates;
      return parsed.result;
    } catch (e) {
      if (token === revision) failure.value = e;
      return null;
    } finally {
      if (token === revision) loading.value = false;
    }
  }

  async function processZip(file: File): Promise<{ result: GerberOutlineResult; candidates: OutlineCandidate[] }> {
    const { default: JSZip } = await import("jszip");
    const zip = await JSZip.loadAsync(file);
    const filenames = Object.keys(zip.files).filter((n) => !zip.files[n].dir);
    const detected = detectOutlineFiles(filenames);

    if (detected.length === 0) {
      throw new GerberImportError('gerber.outlineNotFound');
    }

    const top = detected[0];
    const content = await zip.files[top.filename].async("string");
    return { result: finalize(top.filename, content), candidates: detected };
  }

  async function processSingleGerber(file: File): Promise<{ result: GerberOutlineResult; candidates: OutlineCandidate[] }> {
    const text = await file.text();
    return { result: finalize(file.name, text), candidates: [
      { filename: file.name, priority: 100, reason: "用户指定" },
    ] };
  }

  function finalize(filename: string, gerberText: string): GerberOutlineResult {
    const outline = extractOutline(gerberText, { panel: true });

    if (outline.points.length < 3) {
      throw new GerberImportError('gerber.invalidOutline', { name: filename, n: outline.points.length });
    }

    // 拼版文件再按「单板」口径解析一次;非拼版两种口径相同
    const singleOutline = outline.isPanel
      ? extractOutline(gerberText, { panel: false })
      : outline;

    const variants = {
      panel: makePanelVariant(outline),
      single: makePanelVariant(singleOutline),
      boards: outline.boards?.map((board, index) =>
        makePanelVariant(board, undefined, undefined, {
          id: `board-${index + 1}`,
          label: `#${index + 1}`,
        })
      ),
    };
    const applied = variants.panel;

    return {
      bbox: outline.bbox,
      filename,
      width: applied.width,
      height: applied.height,
      outlinePoints: applied.outlinePoints,
      holes: applied.outlineHoles,
      bboxCenter: applied.center,
      parse: outline,
      variants,
    };
  }

  function reset(): void {
    revision++;
    loading.value = false;
    failure.value = null;
    result.value = null;
    candidates.value = [];
  }

  return {
    loading,
    error,
    result,
    candidates,
    processFile,
    reset,
    hasResult,
  };
}
