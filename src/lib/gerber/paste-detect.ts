/**
 * 在 Gerber ZIP 中识别锡膏层文件
 *
 * 优先级(从高到低):
 * 1. .GTP / .GBP 扩展名(Top/Bottom Paste)
 * 2. 文件名含 "paste" / "Paste"
 * 3. .GPT / .GPB 扩展名(部分 EDA 命名)
 *
 * 每个候选带 side 标记(top/bottom/unknown):
 * - .GTP/.GPT → top;.GBP/.GPB → bottom
 * - KiCad 风格 -F_Paste / -B_Paste 单字母前后缀
 * - 文件名含 top/front → top;bottom/back → bottom
 */

const EXTENSION_HINTS: Array<{ ext: string; priority: number; reason: string }> = [
  { ext: ".gtp", priority: 100, reason: "Top Paste 锡膏层" },
  { ext: ".gbp", priority: 100, reason: "Bottom Paste 锡膏层" },
  { ext: ".gpt", priority: 80, reason: "Top Paste(变体命名)" },
  { ext: ".gpb", priority: 80, reason: "Bottom Paste(变体命名)" },
];

const FILENAME_HINTS: Array<{ pattern: RegExp; priority: number; reason: string }> = [
  { pattern: /paste/i, priority: 90, reason: "锡膏层" },
];

export type PasteSide = "top" | "bottom" | "unknown";

/** 从文件名判断锡膏层属于哪一面 */
export function detectPasteSide(filename: string): PasteSide {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".gtp") || lower.endsWith(".gpt")) return "top";
  if (lower.endsWith(".gbp") || lower.endsWith(".gpb")) return "bottom";
  // KiCad 风格:xxx-F_Paste.gbr / xxx-B_Paste.gbr(单字母紧邻 paste)
  if (/[-_.]f[^a-z]*paste/.test(lower) || /paste[^a-z]*[-_.]f(?![a-z])/.test(lower)) return "top";
  if (/[-_.]b[^a-z]*paste/.test(lower) || /paste[^a-z]*[-_.]b(?![a-z])/.test(lower)) return "bottom";
  if (/(^|[^a-z])(top|front)([^a-z]|$)/.test(lower)) return "top";
  if (/(^|[^a-z])(bottom|back)([^a-z]|$)/.test(lower)) return "bottom";
  return "unknown";
}

export interface PasteCandidate {
  filename: string;
  priority: number;
  reason: string;
  side: PasteSide;
}

/**
 * 从文件名列表中选出最可能的锡膏层 Gerber
 * 返回按优先级排序的候选列表(第一个 = 最可能)
 */
export function detectPasteFiles(filenames: string[]): PasteCandidate[] {
  const candidates: PasteCandidate[] = [];

  for (const fn of filenames) {
    const lower = fn.toLowerCase();
    let best: PasteCandidate | null = null;

    for (const hint of FILENAME_HINTS) {
      if (hint.pattern.test(fn)) {
        if (!best || hint.priority > best.priority) {
          best = { filename: fn, priority: hint.priority, reason: hint.reason, side: detectPasteSide(fn) };
        }
      }
    }

    for (const hint of EXTENSION_HINTS) {
      if (lower.endsWith(hint.ext)) {
        if (!best || hint.priority > best.priority) {
          best = { filename: fn, priority: hint.priority, reason: hint.reason, side: detectPasteSide(fn) };
        }
      }
    }

    if (best) candidates.push(best);
  }

  return candidates.sort((a, b) => b.priority - a.priority);
}

/** 从候选中按面挑选:top 取 side∈{top,unknown} 最高优先级,bottom 取 side=bottom 最高优先级 */
export function pickPasteBySide(candidates: PasteCandidate[]): { top: PasteCandidate | null; bottom: PasteCandidate | null } {
  const top = candidates.find((c) => c.side === "top" || c.side === "unknown") ?? null;
  const bottom = candidates.find((c) => c.side === "bottom") ?? null;
  return { top, bottom };
}
