import { useEffect, useRef, useState } from 'react';
import type { Editor } from '@tiptap/core';
import { canEdit, createEditor, safeLink } from './editor';
import type { NoteController, ViewState } from './controller';
const actions = [
  ['正文', (e: Editor) => e.chain().focus().setParagraph().run()],
  ['标题 1', (e: Editor) => e.chain().focus().toggleHeading({ level: 1 }).run()],
  ['标题 2', (e: Editor) => e.chain().focus().toggleHeading({ level: 2 }).run()],
  ['标题 3', (e: Editor) => e.chain().focus().toggleHeading({ level: 3 }).run()],
  ['项目列表', (e: Editor) => e.chain().focus().toggleBulletList().run()],
  ['有序列表', (e: Editor) => e.chain().focus().toggleOrderedList().run()],
  ['任务列表', (e: Editor) => e.chain().focus().toggleTaskList().run()],
  ['引用', (e: Editor) => e.chain().focus().toggleBlockquote().run()],
  ['代码块', (e: Editor) => e.chain().focus().toggleCodeBlock().run()],
] as const;
export function EditorView({ controller, onState }: { controller: NoteController; onState: (state: ViewState) => void }) {
  const host = useRef<HTMLDivElement>(null), editor = useRef<Editor | null>(null);
  const [raw, setRaw] = useState<string | null>(null), [slash, setSlash] = useState(false);
  const onStateRef = useRef(onState); onStateRef.current = onState;
  useEffect(() => {
    let seen = controller.draft.body, supported = true;
    const initializing = performance.now();
    const instance = createEditor(host.current!, (body, meaningful) => { seen = body; controller.change(body, meaningful); }, value => controller.composition(value));
    editor.current = instance;
    const display = (body: string) => {
      const start = performance.now();
      supported = canEdit(instance, body);
      if (supported) { setRaw(null); instance.setEditable(true, false); instance.commands.setContent(body, { contentType: 'markdown', emitUpdate: false }); }
      else { instance.setEditable(false, false); instance.commands.setContent('', { emitUpdate: false }); setRaw(body); }
      performance.clearMeasures('pmem:markdown'); performance.measure('pmem:markdown', { start, end: performance.now() });
    };
    display(seen);
    const updateMenu = () => setSlash(!instance.view.composing && /^\/[^\s]*$/.test(instance.state.selection.$from.parent.textContent));
    instance.on('selectionUpdate', updateMenu); instance.on('update', updateMenu);
    controller.onView = state => {
      if (state.body !== seen && !instance.view.composing) { seen = state.body; display(state.body); }
      const editable = supported && controller.draft.pending?.kind !== 'delete';
      if (instance.isEditable !== editable) instance.setEditable(editable, false);
      onStateRef.current(state);
    };
    onStateRef.current(controller.view());
    performance.clearMeasures('pmem:editor'); performance.measure('pmem:editor', { start: initializing, end: performance.now() });
    const frame = requestAnimationFrame(() => { performance.clearMarks('pmem:ready'); performance.mark('pmem:ready'); document.documentElement.dataset.ready = controller.draft.id; });
    return () => { cancelAnimationFrame(frame); controller.onView = () => {}; instance.destroy(); editor.current = null; };
  }, [controller]);
  const run = (action: (e: Editor) => unknown) => { const e = editor.current; if (e?.isEditable && !e.view.composing) action(e); };
  return <>
    <div className="toolbar" aria-label="文字格式">
      <select aria-label="段落格式" value="" disabled={raw !== null} onChange={event => run(e => actions[Number(event.target.value)][1](e))}>
        <option value="" disabled>段落</option>{actions.map(([label], i) => <option key={label} value={i}>{label}</option>)}
      </select>
      <button title="加粗 Ctrl/⌘ B" aria-label="加粗" disabled={raw !== null} onMouseDown={e => e.preventDefault()} onClick={() => run(e => e.chain().focus().toggleBold().run())}><b>B</b></button>
      <button title="斜体 Ctrl/⌘ I" aria-label="斜体" disabled={raw !== null} onMouseDown={e => e.preventDefault()} onClick={() => run(e => e.chain().focus().toggleItalic().run())}><i>I</i></button>
      <button disabled={raw !== null} onMouseDown={e => e.preventDefault()} onClick={() => run(e => { const href = window.prompt('链接地址（https://、http:// 或 mailto:）', e.getAttributes('link').href ?? 'https://'); if (href === '') e.chain().focus().unsetLink().run(); else if (href && safeLink(href)) e.chain().focus().setLink({ href }).run(); })}>链接</button>
      <span className="toolbar-spacer" />
      <button aria-label="撤销" disabled={raw !== null} onClick={() => run(e => e.chain().focus().undo().run())}>↶</button>
      <button aria-label="重做" disabled={raw !== null} onClick={() => run(e => e.chain().focus().redo().run())}>↷</button>
    </div>
    {raw !== null && <div className="raw-note"><p>这篇笔记包含暂不支持的格式，已保留原文。你可以查看、复制，或另存后继续记录。</p><textarea aria-label="笔记原文" readOnly value={raw} /></div>}
    <div className={raw !== null ? 'hidden' : 'editor-page'}><div ref={host} />
      {slash && <div className="slash-menu" aria-label="插入内容">{actions.map(([label, action]) => <button key={label} onMouseDown={e => e.preventDefault()} onClick={() => run(e => { const at = e.state.selection.$from; e.commands.deleteRange({ from: at.start(), to: at.pos }); action(e); setSlash(false); })}>{label}</button>)}</div>}
    </div>
  </>;
}
