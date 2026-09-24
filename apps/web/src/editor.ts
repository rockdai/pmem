import { Editor, type JSONContent } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import HardBreak from '@tiptap/extension-hard-break';

export const safeLink = (href: string) => /^(https?:\/\/|mailto:)/i.test(href);
export function extensions() {
  return [
    StarterKit.configure({
      horizontalRule: false,
      strike: false,
      underline: false,
      trailingNode: false,
      hardBreak: false,
      link: {
        openOnClick: false,
        autolink: false,
        isAllowedUri: safeLink,
        HTMLAttributes: { rel: 'noopener noreferrer' },
      },
    }),
    HardBreak,
    TaskList,
    TaskItem.configure({ nested: true }),
    Markdown.configure({ markedOptions: { gfm: true } }),
  ];
}

const allowed = new Set([
  'space',
  'paragraph',
  'text',
  'heading',
  'strong',
  'em',
  'codespan',
  'code',
  'br',
  'escape',
  'link',
  'list',
  'list_item',
  'blockquote',
  'taskList',
  'taskItem',
]);
// Refuse lossy imports before the editor's Markdown parser can discard unknown nodes.
export function canEdit(editor: Editor, markdown: string): boolean {
  try {
    const tokens = editor.markdown!.instance.lexer(markdown);
    const inspect = (value: unknown): boolean => {
      if (Array.isArray(value)) return value.every(inspect);
      if (!value || typeof value !== 'object') return true;
      const token = value as Record<string, unknown>;
      if (typeof token.type === 'string' && !allowed.has(token.type)) return false;
      if (token.type === 'link' && (!safeLink(String(token.href)) || token.title)) return false;
      return Object.entries(token).every(([key, child]) =>
        ['tokens', 'items'].includes(key) ? inspect(child) : true,
      );
    };
    if (!inspect(tokens)) return false;
    const first = editor.markdown!.parse(markdown);
    const second = editor.markdown!.parse(editor.markdown!.serialize(first));
    return JSON.stringify(first) === JSON.stringify(second);
  } catch {
    return false;
  }
}

export function hasContent(doc: JSONContent): boolean {
  return Boolean(doc.text?.trim()) || Boolean(doc.content?.some(hasContent));
}

export function createEditor(
  element: HTMLElement,
  onChange: (body: string, meaningful: boolean) => void,
  onComposition?: (active: boolean) => void,
) {
  const editor = new Editor({
    element,
    extensions: extensions(),
    content: '',
    contentType: 'markdown',
    editorProps: {
      attributes: {
        class: 'note-editor',
        role: 'textbox',
        'aria-label': '笔记正文',
        'aria-multiline': 'true',
        spellcheck: 'false',
      },
      handlePaste(view, event) {
        const clipboard = event.clipboardData;
        if (!clipboard) return false;
        const html = clipboard.getData('text/html'),
          text = clipboard.getData('text/plain') || html;
        if (html && !editor.isActive('codeBlock')) {
          const document = new DOMParser().parseFromString(html, 'text/html');
          const tags = new Set([
            'P',
            'BR',
            'STRONG',
            'B',
            'EM',
            'I',
            'A',
            'UL',
            'OL',
            'LI',
            'BLOCKQUOTE',
            'PRE',
            'CODE',
            'H1',
            'H2',
            'H3',
          ]);
          // The editor schema strips attributes; unsupported HTML falls back to visible text.
          if (
            [...document.querySelectorAll('head *, body *')].every(
              (node) =>
                tags.has(node.tagName) &&
                (node.tagName !== 'A' || safeLink(node.getAttribute('href') ?? '')),
            )
          )
            return false;
        }
        event.preventDefault();
        if (editor.isActive('codeBlock')) {
          view.dispatch(view.state.tr.insertText(text));
          return true;
        }
        const content = text
          .split(/\r?\n/)
          .map((line) => ({
            type: 'paragraph',
            content: line ? [{ type: 'text', text: line }] : [],
          }));
        editor.commands.insertContent(content);
        return true;
      },
      handleDOMEvents: {
        compositionstart: () => {
          onComposition?.(true);
          return false;
        },
        compositionend: () => {
          queueMicrotask(() => {
            onComposition?.(false);
            onChange(editor.getMarkdown(), hasContent(editor.getJSON()));
          });
          return false;
        },
      },
    },
    onUpdate: ({ editor }) => {
      if (!editor.view.composing) onChange(editor.getMarkdown(), hasContent(editor.getJSON()));
    },
  });
  return editor;
}
