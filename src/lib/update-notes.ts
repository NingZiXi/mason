export type UpdateNoteBlock =
  | { kind: 'heading'; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'list'; ordered: boolean; start: number; items: string[] };

// Release notes are remote text. Only recognize a small, text-only Markdown
// subset; links and HTML never become executable markup in the settings page.
function plainText(text: string): string {
  return text
    .replace(/!?\[([^\]]+)\]\((?:[^()]|\([^()]*\))*\)/g, '$1')
    .replace(/`+([^`]+)`+/g, '$1')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .trim();
}

export function parseUpdateNotes(source: string): UpdateNoteBlock[] {
  const blocks: UpdateNoteBlock[] = [];
  let paragraph: string[] = [];
  let list: Extract<UpdateNoteBlock, { kind: 'list' }> | undefined;
  let inCode = false;
  const flush = () => {
    if (paragraph.length) {
      blocks.push({ kind: 'paragraph', text: plainText(paragraph.join(' ')) });
      paragraph = [];
    }
    if (list) { blocks.push(list); list = undefined; }
  };

  for (const line of source.replace(/\r\n?/g, '\n').split('\n')) {
    const trimmed = line.trim();
    if (/^```|^~~~/.test(trimmed)) { flush(); inCode = !inCode; continue; }
    if (!trimmed) { flush(); continue; }
    if (inCode) { paragraph.push(trimmed); continue; }
    if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(trimmed)) { flush(); continue; }
    const heading = /^#{1,6}\s+(.+?)(?:\s+#+)?$/.exec(trimmed);
    if (heading) { flush(); blocks.push({ kind: 'heading', text: plainText(heading[1]) }); continue; }
    const item = /^(?:([-+*])|(?:(\d+)[.)]))\s+(.+)$/.exec(trimmed);
    if (item) {
      const ordered = !!item[2];
      if (paragraph.length || (list && list.ordered !== ordered)) flush();
      list ??= { kind: 'list', ordered, start: ordered ? Number(item[2]) : 1, items: [] };
      list.items.push(plainText(item[3]));
      continue;
    }
    // An indented continuation belongs to the previous list item.
    if (list && /^\s+/.test(line)) {
      list.items[list.items.length - 1] += ` ${plainText(trimmed)}`;
      continue;
    }
    if (list) flush();
    paragraph.push(trimmed);
  }
  flush();
  return blocks;
}

export function summarizeUpdateNotes(blocks: UpdateNoteBlock[], limit = 150): string {
  const contents = blocks.flatMap(block => block.kind === 'list' ? block.items : block.kind === 'paragraph' ? [block.text] : []);
  const text = (contents.length ? contents : blocks.map(block => block.kind === 'list' ? block.items.join(' ') : block.text)).join(' · ');
  const characters = Array.from(text);
  return characters.length > limit ? `${characters.slice(0, limit).join('').trimEnd()}…` : text;
}

export function updateNotesNeedExpansion(blocks: UpdateNoteBlock[]): boolean {
  const textLength = blocks.reduce((length, block) => length + (block.kind === 'list' ? block.items.join('').length : block.text.length), 0);
  const entries = blocks.reduce((count, block) => count + (block.kind === 'list' ? block.items.length : 1), 0);
  return textLength > 280 || entries > 4;
}
