import type { Editor } from '@tiptap/core';
import CodeBlock from '@tiptap/extension-code-block';
import { Plugin, TextSelection } from '@tiptap/pm/state';

export function focusAfterCodeBlock(editor: Editor, position: number) {
  if (!editor.isEditable) return false;
  const { state, view } = editor;
  const node = state.doc.nodeAt(position);
  if (node?.type.name !== 'codeBlock') return false;
  const after = position + node.nodeSize;
  const tr = state.tr;
  if (state.doc.nodeAt(after)?.type.name !== 'paragraph')
    tr.insert(after, state.schema.nodes.paragraph.create());
  tr.setSelection(TextSelection.create(tr.doc, after + 1));
  view.dispatch(tr);
  view.focus();
  return true;
}

async function copyCode(text: string) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
  const active = document.activeElement;
  const field = document.createElement('textarea');
  field.value = text;
  field.style.position = 'fixed';
  field.style.opacity = '0';
  document.body.append(field);
  try {
    field.select();
    if (!document.execCommand('copy')) throw new Error('Copy rejected');
  } finally {
    field.remove();
    if (active instanceof HTMLElement) active.focus();
  }
}

export const NoteCodeBlock = CodeBlock.extend({
  addKeyboardShortcuts() {
    const selectCode = () => {
      const { $from, $to } = this.editor.state.selection;
      if ($from.parent.type.name !== this.name || !$from.sameParent($to)) return false;
      return this.editor.commands.setTextSelection({ from: $from.start(), to: $from.end() });
    };
    return { ...this.parent?.(), 'Meta-a': selectCode, 'Ctrl-a': selectCode };
  },
  addProseMirrorPlugins() {
    return [
      ...(this.parent?.() ?? []),
      new Plugin({
        props: {
          handleClick: (view, _position, event) => {
            const last = view.state.doc.lastChild;
            if (event.target !== view.dom || last?.type.name !== this.name) return false;
            const position = view.state.doc.content.size - last.nodeSize;
            const dom = view.nodeDOM(position);
            if (
              !(dom instanceof HTMLElement) ||
              event.clientY < dom.getBoundingClientRect().bottom
            )
              return false;
            return focusAfterCodeBlock(this.editor, position);
          },
        },
      }),
    ];
  },
  addNodeView() {
    return ({ editor, node, getPos }) => {
      let current = node;
      const dom = document.createElement('div');
      dom.className = 'code-block';
      const frame = document.createElement('div');
      frame.className = 'code-block-frame';
      const controls = document.createElement('div');
      controls.className = 'code-block-controls';
      controls.contentEditable = 'false';
      const collapse = document.createElement('button');
      collapse.type = 'button';
      collapse.textContent = '收起';
      collapse.setAttribute('aria-expanded', 'true');
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.textContent = '复制代码';
      const status = document.createElement('span');
      status.setAttribute('role', 'status');
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      const updateLanguage = () => {
        code.className = current.attrs.language ? `language-${current.attrs.language}` : '';
      };
      updateLanguage();
      pre.append(code);
      controls.append(collapse, status, copy);
      frame.append(controls, pre);
      dom.append(frame);
      collapse.onclick = () => {
        collapse.focus();
        pre.hidden = !pre.hidden;
        collapse.textContent = pre.hidden ? '展开' : '收起';
        collapse.setAttribute('aria-expanded', String(!pre.hidden));
      };
      copy.onclick = async () => {
        status.textContent = '';
        try {
          await copyCode(current.textContent);
          status.textContent = '已复制';
        } catch {
          status.textContent = '复制失败，请重试';
        }
      };
      dom.onmousedown = (event) => {
        if (event.target !== dom || event.button !== 0) return;
        const position = getPos();
        if (position !== undefined && focusAfterCodeBlock(editor, position))
          event.preventDefault();
      };
      return {
        dom,
        contentDOM: code,
        update(next) {
          if (next.type !== current.type) return false;
          current = next;
          updateLanguage();
          return true;
        },
        stopEvent: (event) =>
          event.target instanceof globalThis.Node && controls.contains(event.target),
        ignoreMutation: (mutation) =>
          mutation.type !== 'selection' &&
          (!code.contains(mutation.target) ||
            (mutation.type === 'attributes' && mutation.target === code)),
      };
    };
  },
});
