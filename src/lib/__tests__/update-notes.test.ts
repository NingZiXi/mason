import { describe, expect, it } from 'vitest';
import { createSSRApp } from 'vue';
import { renderToString } from '@vue/server-renderer';
import { createI18n } from 'vue-i18n';
import UpdateNotes from '../../components/UpdateNotes.vue';
import { parseUpdateNotes, summarizeUpdateNotes, updateNotesNeedExpansion } from '../update-notes';

describe('update notes text formatting', () => {
  it('groups headings, multiline paragraphs and ordered or unordered lists', () => {
    expect(parseUpdateNotes('## 修复\r\n\r\n这次更新\r\n更加流畅。\r\n\r\n- **布局**稳定\r\n  支持小窗口\r\n- `快捷键`\r\n\r\n3. 第三项\r\n4. 第四项')).toEqual([
      { kind: 'heading', text: '修复' },
      { kind: 'paragraph', text: '这次更新 更加流畅。' },
      { kind: 'list', ordered: false, start: 1, items: ['布局稳定 支持小窗口', '快捷键'] },
      { kind: 'list', ordered: true, start: 3, items: ['第三项', '第四项'] },
    ]);
  });

  it('keeps remote HTML as text and does not expose links as navigation', () => {
    expect(parseUpdateNotes('- [更新](javascript:alert(1))\n- <img src=x onerror=alert(1)>\n<script>alert(1)</script>')).toEqual([
      { kind: 'list', ordered: false, start: 1, items: ['更新', '<img src=x onerror=alert(1)>'] },
      { kind: 'paragraph', text: '<script>alert(1)</script>' },
    ]);
  });

  it('renders the actual notes component with escaped remote HTML and plain link labels', async () => {
    const app = createSSRApp(UpdateNotes, { body: '## 更新\n- <img src=x onerror=alert(1)>\n- [查看](javascript:alert(1))' });
    app.use(createI18n({ legacy: false, locale: 'en', messages: { en: { updates: { releaseNotes: 'Changes' } } } }));
    const html = await renderToString(app);
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('<li');
    expect(html).toContain('查看');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('href=');
    expect(html).not.toContain('javascript:');
  });

  it('does not interpret a fenced example as headings or list items', () => {
    expect(parseUpdateNotes('```text\n# example\n- example\n```\n---')).toEqual([
      { kind: 'paragraph', text: '# example - example' },
    ]);
  });

  it('handles empty notes and summarizes long notes without splitting Unicode characters', () => {
    expect(parseUpdateNotes(' \n\r\n')).toEqual([]);
    expect(summarizeUpdateNotes(parseUpdateNotes('# 更新\n- 更快\n- 更顺滑'))).toBe('更快 · 更顺滑');
    expect(summarizeUpdateNotes(parseUpdateNotes('🛠️修改完成'), 1)).toBe('🛠…');
    expect(summarizeUpdateNotes(parseUpdateNotes('# 更新'))).toBe('更新');
  });

  it('keeps short notes visible and folds long paragraphs or many changes', () => {
    expect(updateNotesNeedExpansion(parseUpdateNotes('## 修复\n- 一个修复'))).toBe(false);
    expect(updateNotesNeedExpansion(parseUpdateNotes('一个修复'.repeat(80)))).toBe(true);
    expect(updateNotesNeedExpansion(parseUpdateNotes('- 一\n- 二\n- 三\n- 四\n- 五'))).toBe(true);
  });
});
