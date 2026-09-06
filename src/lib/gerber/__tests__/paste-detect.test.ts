import { describe, it, expect } from "vitest";
import { detectPasteFiles, detectPasteSide, pickPasteBySide } from "../paste-detect";

describe("detectPasteSide", () => {
  it("扩展名 .gtp/.gpt → top", () => {
    expect(detectPasteSide("board.GTP")).toBe("top");
    expect(detectPasteSide("board.gpt")).toBe("top");
  });

  it("扩展名 .gbp/.gpb → bottom", () => {
    expect(detectPasteSide("board.GBP")).toBe("bottom");
    expect(detectPasteSide("board.gpb")).toBe("bottom");
  });

  it("KiCad 单字母前后缀 F/B_Paste", () => {
    expect(detectPasteSide("myboard-F_Paste.gbr")).toBe("top");
    expect(detectPasteSide("myboard-B_Paste.gbr")).toBe("bottom");
  });

  it("文件名含 top/front → top,bottom/back → bottom", () => {
    expect(detectPasteSide("top-paste.gbr")).toBe("top");
    expect(detectPasteSide("front_paste.gbr")).toBe("top");
    expect(detectPasteSide("bottom-paste.gbr")).toBe("bottom");
    expect(detectPasteSide("back_paste.gbr")).toBe("bottom");
  });

  it("无线索 → unknown", () => {
    expect(detectPasteSide("paste.gbr")).toBe("unknown");
    expect(detectPasteSide("soldermask.gbr")).toBe("unknown");
  });
});

describe("detectPasteFiles", () => {
  it("按优先级排序并带 side 标记", () => {
    const cands = detectPasteFiles([
      "board.gko",
      "board-F_Paste.gbr",
      "board-B_Paste.gbr",
      "readme.txt",
    ]);
    expect(cands).toHaveLength(2);
    expect(cands.map((c) => c.side).sort()).toEqual(["bottom", "top"]);
  });
});

describe("pickPasteBySide", () => {
  it("top/bottom 各取最高优先级,unknown 归 top", () => {
    const cands = detectPasteFiles([
      "a.gtp",       // top, priority 100
      "b-paste.gbr", // unknown(含 paste), priority 90 → top 兜底
      "c.gbp",       // bottom, priority 100
    ]);
    const { top, bottom } = pickPasteBySide(cands);
    expect(top?.filename).toBe("a.gtp");
    expect(bottom?.filename).toBe("c.gbp");
  });

  it("无法判面的 paste 文件兜底归 top", () => {
    const cands = detectPasteFiles(["paste_layer.gbr"]);
    const { top, bottom } = pickPasteBySide(cands);
    expect(top?.filename).toBe("paste_layer.gbr"); // unknown 兜底为 top
    expect(bottom).toBeNull();
  });

  it("只有 bottom 层时 top 为空", () => {
    const cands = detectPasteFiles(["board-bottom-paste.gbr"]);
    const { top, bottom } = pickPasteBySide(cands);
    expect(top).toBeNull();
    expect(bottom?.filename).toBe("board-bottom-paste.gbr");
  });
});
