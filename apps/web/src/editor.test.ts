// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import { canEdit, extensions } from './editor';
const live: Editor[] = [];
function make(content: string) { const editor = new Editor({ extensions: extensions(), content, contentType: 'markdown' }); live.push(editor); return editor; }
afterEach(() => live.splice(0).forEach(e => e.destroy()));
describe('Markdown content boundary', () => {
  it.each([
    '# 灵感\n\n中文 **加粗** 与 *斜体* [链接](https://example.com) 和 `code`',
    '- first\n- second\n\n1. 中文\n2. other',
    '- [ ] 待办\n- [x] 完成',
    '> 引用\n>\n> 下一段',
    '第一行  \n第二行\n\n下一段',
    '```js\n  const x = 1;\n\n  // 尾部空格  \n\n```',
    'literal & <tag>\n\n\\*普通星号\\*',
  ])('preserves supported semantics: %s', markdown => {
    const editor = make(markdown);
    const before = editor.getJSON();
    const output = editor.getMarkdown();
    editor.commands.setContent(output, { contentType: 'markdown', emitUpdate: false });
    expect(editor.getJSON()).toEqual(before);
  });
  it('preserves code block whitespace', () => {
    const editor = make('```\n  abc  \n\n\n```');
    expect((editor.getJSON().content?.[0].content?.[0] as { text: string }).text).toBe('  abc  \n\n');
    expect(editor.getMarkdown()).toContain('  abc  \n\n');
  });
  it('rejects unknown structures and raw HTML before parsing', () => {
    const editor = make('');
    for (const md of ['<script>alert(1)</script>', '| a | b |\n| - | - |\n| c | d |', '![image](https://example.com/a.png)', '[evil](javascript:alert(1))', '~~strike~~']) expect(canEdit(editor, md)).toBe(false);
    expect(canEdit(editor, '# 支持\n\n- [x] 完成')).toBe(true);
  });
});
