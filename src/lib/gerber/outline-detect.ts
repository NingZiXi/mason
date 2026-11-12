/**
 * 在 Gerber ZIP 中识别板框文件
 *
 * 优先级(从高到低):
 * 1. 文件名含 "Edge_Cuts" 或 "edge"
 * 2. .GKO 扩展名(JLCPCB / 嘉立创EDA 板框)
 * 3. .GM1 扩展名(KiCad 板框)
 * 4. 文件名含 "outline"
 * 5. .GME(JLCPCB V-Cut / 机械信息,通常不是板框,放最后)
 */

import { isArchiveContentFile } from './archive-files';

const EXTENSION_HINTS: Array<{ ext: string; priority: number; reason: string }> = [
  { ext: ".gko", priority: 100, reason: "JLCPCB / 嘉立创EDA 板框文件" },
  { ext: ".gm1", priority: 90, reason: "KiCad / Altium 板框文件" },
  { ext: ".gme", priority: 20, reason: "机械层(可能是 V-Cut)" },
];

const FILENAME_HINTS: Array<{ pattern: RegExp; priority: number; reason: string }> = [
  { pattern: /edge[._-]?cuts/i, priority: 110, reason: "KiCad Edge.Cuts" },
  { pattern: /board[-_]?outline/i, priority: 95, reason: "嘉立创EDA 板框" },
  { pattern: /outline/i, priority: 85, reason: "通用 outline" },
];

export interface OutlineCandidate {
  filename: string;
  priority: number;
  reason: string;
}

/**
 * 从文件名列表中选出最可能的板框 Gerber
 * 返回按优先级排序的候选列表(第一个 = 最可能)
 */
export function detectOutlineFiles(filenames: string[]): OutlineCandidate[] {
  const candidates: OutlineCandidate[] = [];

  for (const fn of filenames) {
    if (!isArchiveContentFile(fn)) continue;
    const basename = fn.split(/[/\\]/).pop()!;
    const lower = basename.toLowerCase();
    let best: OutlineCandidate | null = null;

    // 文件名模式优先级最高
    for (const hint of FILENAME_HINTS) {
      if (hint.pattern.test(basename)) {
        if (!best || hint.priority > best.priority) {
          best = { filename: fn, priority: hint.priority, reason: hint.reason };
        }
      }
    }

    // 扩展名优先级
    for (const hint of EXTENSION_HINTS) {
      if (lower.endsWith(hint.ext)) {
        if (!best || hint.priority > best.priority) {
          best = { filename: fn, priority: hint.priority, reason: hint.reason };
        }
      }
    }

    if (best) candidates.push(best);
  }

  return candidates.sort((a, b) => b.priority - a.priority);
}
