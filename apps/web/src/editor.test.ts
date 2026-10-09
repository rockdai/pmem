// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Editor } from '@tiptap/core';
import { canEdit, createEditor } from './editor';
import { focusAfterCodeBlock } from './code-block';
const live: Editor[] = [];
function selectAll(editor: Editor, shortcut: string) {
  editor.view.dom.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: 'a',
      ctrlKey: shortcut === 'Ctrl-a',
      metaKey: shortcut === 'Meta-a',
      bubbles: true,
      cancelable: true,
    }),
  );
}
function make(content: string) {
  const element = document.createElement('div');
  const editor = createEditor(element, () => {});
  editor.commands.setContent(content, { contentType: 'markdown', emitUpdate: false });
  live.push(editor);
  return { editor, element };
}
afterEach(() => {
  live.splice(0).forEach((e) => e.destroy());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe('Markdown content boundary', () => {
  it.each([
    {
      name: 'headings, emphasis, links and inline code',
      markdown: '# 灵感\n\n中文 **加粗** 与 *斜体* [链接](https://example.com) 和 `code`',
      check(element: HTMLElement) {
        expect(element.querySelector('h1')?.textContent).toBe('灵感');
        expect(element.querySelector('strong')?.textContent).toBe('加粗');
        expect(element.querySelector('em')?.textContent).toBe('斜体');
        expect(element.querySelector('a')?.textContent).toBe('链接');
        expect(element.querySelector('a')?.getAttribute('href')).toBe('https://example.com');
        expect(element.querySelector('code')?.textContent).toBe('code');
      },
    },
    {
      name: 'unordered and ordered lists',
      markdown: '- first\n- second\n\n1. 中文\n2. other',
      check(element: HTMLElement) {
        expect([...element.querySelectorAll('ul > li')].map((li) => li.textContent)).toEqual([
          'first',
          'second',
        ]);
        expect([...element.querySelectorAll('ol > li')].map((li) => li.textContent)).toEqual([
          '中文',
          'other',
        ]);
      },
    },
    {
      name: 'unchecked and checked tasks',
      markdown: '- [ ] 待办\n- [x] 完成',
      check(element: HTMLElement) {
        const tasks = [...element.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
        expect(tasks.map((input) => input.checked)).toEqual([false, true]);
        expect(tasks.map((input) => input.closest('li')?.querySelector('p')?.textContent)).toEqual([
          '待办',
          '完成',
        ]);
      },
    },
    {
      name: 'multi-paragraph quotes',
      markdown: '> 引用\n>\n> 下一段',
      check(element: HTMLElement) {
        expect([...element.querySelectorAll('blockquote > p')].map((p) => p.textContent)).toEqual([
          '引用',
          '下一段',
        ]);
      },
    },
    {
      name: 'hard breaks and separate paragraphs',
      markdown: '第一行  \n第二行\n\n下一段',
      check(element: HTMLElement) {
        expect([...element.querySelectorAll('p')].map((p) => p.textContent)).toEqual([
          '第一行第二行',
          '下一段',
        ]);
        const breaks = element.querySelectorAll('br');
        expect(breaks).toHaveLength(1);
        expect(breaks[0].previousSibling?.textContent).toBe('第一行');
        expect(breaks[0].nextSibling?.textContent).toBe('第二行');
      },
    },
    {
      name: 'literal punctuation and escaped formatting',
      markdown: 'literal & <tag>\n\n\\*普通星号\\*',
      check(element: HTMLElement) {
        expect([...element.querySelectorAll('p')].map((p) => p.textContent)).toEqual([
          'literal & <tag>',
          '*普通星号*',
        ]);
        expect(element.querySelector('tag, em, strong')).toBeNull();
      },
    },
  ])('renders and exports $name', ({ markdown, check }) => {
    const { editor, element } = make(markdown);
    check(element);
    const output = editor.getMarkdown();
    check(make(output).element);
  });
  it.each([
    ['', '  abc  \n\n'],
    ['js', '  const x = 1;\n\n  // 尾部空格  \n'],
  ])('preserves code block language %s and whitespace', (language, content) => {
    const { editor, element } = make(`\`\`\`${language}\n${content}\n\`\`\``);
    expect(element.querySelector('pre code')?.textContent).toBe(content);
    expect(editor.getMarkdown()).toBe(`\`\`\`${language}\n${content}\n\`\`\``);
    expect(make(editor.getMarkdown()).element.querySelector('pre code')?.textContent).toBe(content);
  });
  it('rejects unknown structures and raw HTML before parsing', () => {
    const { editor } = make('');
    for (const md of [
      '<script>alert(1)</script>',
      '| a | b |\n| - | - |\n| c | d |',
      '![image](https://example.com/a.png)',
      '[evil](javascript:alert(1))',
      '~~strike~~',
    ])
      expect(canEdit(editor, md)).toBe(false);
    expect(canEdit(editor, '# 支持\n\n- [x] 完成')).toBe(true);
  });
});

describe('code block interactions', () => {
  it.each(['Ctrl-a', 'Meta-a'])('selects only the current code block with %s', (shortcut) => {
    const { editor } = make('before\n\n```js\n  first\nsecond  \n```\n\nafter');
    const start = editor.state.doc.firstChild!.nodeSize + 1;
    editor.commands.setTextSelection(start + 3);
    selectAll(editor, shortcut);
    expect(
      editor.state.doc.textBetween(editor.state.selection.from, editor.state.selection.to),
    ).toBe('  first\nsecond  ');
    selectAll(editor, shortcut);
    editor.commands.insertContent('replacement');
    expect(editor.getMarkdown()).toBe('before\n\n```js\nreplacement\n```\n\nafter');
  });

  it('keeps normal select-all outside code and handles empty code', () => {
    const { editor } = make('before\n\n```\n\n```');
    editor.commands.setTextSelection(1);
    selectAll(editor, 'Ctrl-a');
    expect(editor.state.selection.from).toBe(0);
    expect(editor.state.selection.to).toBe(editor.state.doc.content.size);
    const start = editor.state.doc.firstChild!.nodeSize + 1;
    editor.commands.setTextSelection(start);
    selectAll(editor, 'Ctrl-a');
    expect(editor.state.selection.from).toBe(start);
    expect(editor.state.selection.to).toBe(start);
  });

  it('collapses and expands without changing Markdown or firing a content update', async () => {
    const { editor } = make('```js\n  const x = 1;\n\n```');
    const before = editor.getMarkdown();
    const changed = vi.fn();
    editor.on('update', changed);
    const collapse = editor.view.dom.querySelector<HTMLButtonElement>('button')!;
    collapse.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(collapse.textContent).toBe('展开');
    expect(collapse.getAttribute('aria-expanded')).toBe('false');
    expect(editor.view.dom.querySelector('pre')!.hidden).toBe(true);
    expect(editor.getMarkdown()).toBe(before);
    collapse.click();
    expect(editor.view.dom.querySelector('pre')!.hidden).toBe(false);
    expect(editor.getHTML()).not.toContain('button');
    expect(changed).not.toHaveBeenCalled();
  });

  it('copies current code verbatim even when collapsed and reports clipboard failures', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', {
      platform: navigator.platform,
      userAgent: navigator.userAgent,
      clipboard: { writeText },
    });
    const { editor } = make('```\nold\n```');
    editor.commands.setTextSelection({ from: 1, to: 4 });
    editor.commands.insertContent('  new\nline  ');
    const [collapse, copy] = editor.view.dom.querySelectorAll<HTMLButtonElement>('button');
    collapse.click();
    copy.click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith('  new\nline  '));
    await vi.waitFor(() =>
      expect(editor.view.dom.querySelector('[role=status]')!.textContent).toBe('已复制'),
    );
    writeText.mockRejectedValueOnce(new Error('Denied'));
    copy.click();
    await vi.waitFor(() =>
      expect(editor.view.dom.querySelector('[role=status]')!.textContent).toBe(
        '复制失败，请重试',
      ),
    );
  });

  it('uses a clipboard fallback without secure-context support and cleans up on failure', async () => {
    vi.stubGlobal('navigator', {
      platform: navigator.platform,
      userAgent: navigator.userAgent,
    });
    const copy = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false);
    Object.defineProperty(document, 'execCommand', { configurable: true, value: copy });
    const { editor } = make('```\n\n```');
    const button = editor.view.dom.querySelectorAll<HTMLButtonElement>('button')[1];
    button.click();
    await vi.waitFor(() =>
      expect(editor.view.dom.querySelector('[role=status]')!.textContent).toBe('已复制'),
    );
    button.click();
    await vi.waitFor(() =>
      expect(editor.view.dom.querySelector('[role=status]')!.textContent).toBe(
        '复制失败，请重试',
      ),
    );
    expect(document.querySelector('textarea')).toBeNull();
    Reflect.deleteProperty(document, 'execCommand');
  });

  it.each(['', '\n\nafter', '\n\n```\nnext\n```'])(
    'enters a paragraph after code without changing nearby blocks: %s',
    (suffix) => {
      const { editor } = make(`\`\`\`\ncode\n\`\`\`${suffix}`);
      const first = editor.state.doc.firstChild!;
      expect(focusAfterCodeBlock(editor, 0)).toBe(true);
      expect(editor.state.selection.$from.parent.type.name).toBe('paragraph');
      editor.commands.insertContent('text');
      expect(editor.state.doc.firstChild).toEqual(first);
      expect(editor.state.doc.child(1).textContent).toBe(
        suffix === '\n\nafter' ? 'textafter' : 'text',
      );
      const count = editor.state.doc.childCount;
      focusAfterCodeBlock(editor, 0);
      expect(editor.state.doc.childCount).toBe(count);
      if (suffix.includes('next')) expect(editor.state.doc.lastChild!.textContent).toBe('next');
    },
  );

  it('does not insert paragraphs in a read-only editor', () => {
    const { editor } = make('```\ncode\n```');
    editor.setEditable(false);
    expect(focusAfterCodeBlock(editor, 0)).toBe(false);
    expect(editor.state.doc.childCount).toBe(1);
  });
});
