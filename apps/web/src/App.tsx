import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import {
  NOTE_ID,
  noteTitle,
  type NotePage,
  type NoteSummary,
  type SessionInfo,
} from '../../../packages/contracts/src/index';
import { Api, HttpError } from './api';
import { Drafts, acquireSlot, removeOrphan, type Draft, type DraftStore } from './drafts';
import { NoteController, type ViewState } from './controller';
import { EditorView } from './EditorView';

function Login({
  onLogin,
  message,
}: {
  onLogin: (session: SessionInfo) => void;
  message?: string;
}) {
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    const data = new FormData(event.currentTarget);
    try {
      const response = await fetch('/api/v1/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ account: data.get('account'), password: data.get('password') }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok)
        throw new Error(
          response.status === 429 ? '尝试次数过多，请稍后再试' : '登录失败，请检查账号和密码',
        );
      onLogin(await response.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : '暂时无法连接');
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="login-page">
      <form className="login-card" onSubmit={submit}>
        <div className="brand-mark">m.</div>
        <p className="eyebrow">PERSONAL MEMORY</p>
        <h1>留住此刻的想法。</h1>
        <p className="muted">一个安静的地方，记录属于你的文字。</p>
        {message && <p role="status">{message}</p>}
        <label>
          账号
          <input name="account" autoComplete="username" required autoFocus maxLength={100} />
        </label>
        <label>
          密码
          <input name="password" type="password" autoComplete="current-password" required />
        </label>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button className="primary" disabled={busy}>
          {busy ? '正在登录…' : '进入笔记本 →'}
        </button>
        <small>你的笔记，保存在你自己的服务中。</small>
      </form>
    </main>
  );
}
export function App() {
  const [api, setApi] = useState<Api | null>(null),
    [loading, setLoading] = useState(true),
    [expired, setExpired] = useState(false),
    [generation, setGeneration] = useState(0);
  useEffect(() => {
    fetch('/api/v1/auth/session', { cache: 'no-store', signal: AbortSignal.timeout(10_000) })
      .then(async (r) => {
        if (r.ok) setApi(new Api(await r.json()));
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);
  const login = (session: SessionInfo) => {
    if (api) api.session = session;
    else setApi(new Api(session));
    setExpired(false);
    setGeneration((n) => n + 1);
  };
  if (loading)
    return (
      <div className="loading" role="status">
        正在打开笔记本…
      </div>
    );
  if (!api) return <Login onLogin={login} />;
  return (
    <>
      <Workspace
        api={api}
        generation={generation}
        onExpired={() => setExpired(true)}
        onLogout={() => {
          setApi(null);
          setExpired(false);
        }}
      />
      {expired && (
        <div className="login-overlay">
          <Login onLogin={login} message="登录已过期，本机草稿仍然保留。" />
        </div>
      )}
    </>
  );
}

function Workspace({
  api,
  generation,
  onExpired,
  onLogout,
}: {
  api: Api;
  generation: number;
  onExpired: () => void;
  onLogout: () => void;
}) {
  const [db, setDb] = useState<DraftStore | null>(null),
    [slot, setSlot] = useState(''),
    [notes, setNotes] = useState<NoteSummary[]>([]),
    [cursor, setCursor] = useState<string | undefined>();
  const [controller, setController] = useState<NoteController | null>(null),
    [view, setView] = useState<ViewState | null>(null),
    [error, setError] = useState(''),
    [opening, setOpening] = useState(false);
  const [sidebar, setSidebar] = useState(false),
    [drafts, setDrafts] = useState<Draft[]>([]),
    [recoverCount, setRecoverCount] = useState(5),
    [showRecovery, setShowRecovery] = useState(false),
    [remote, setRemote] = useState<string | null>(null);
  const current = useRef<NoteController | null>(null),
    all = useRef(new Set<NoteController>()),
    sequence = useRef(0),
    release = useRef<() => void>(() => {}),
    channel = useRef<BroadcastChannel | null>(null);
  const namespace = api.session.deployment;
  const refreshList = useCallback(
    async (next?: string) => {
      try {
        const response = await api.call(
          `/notes${next ? `?cursor=${encodeURIComponent(next)}` : ''}`,
        );
        const page: NotePage = await response.json();
        setNotes((old) =>
          next ? [...new Map([...old, ...page.notes].map((n) => [n.id, n])).values()] : page.notes,
        );
        setCursor(page.cursor);
      } catch (e) {
        if (e instanceof HttpError && e.status === 401) onExpired();
        else setError('暂时无法加载笔记列表，可继续记录或稍后刷新。');
      }
    },
    [api],
  );
  const refreshDrafts = useCallback(async () => {
    if (db) setDrafts(await db.all(namespace));
  }, [db, namespace]);
  const install = useCallback(
    (next: NoteController) => {
      current.current?.detach();
      current.current = next;
      all.current.add(next);
      next.onSynced = () => {
        void refreshList();
        void refreshDrafts();
      };
      next.onAuth = onExpired;
      setController(next);
      setView(next.view());
      setSidebar(false);
      setRemote(null);
      history.replaceState(null, '', `#/note/${next.draft.id}`);
      localStorage.setItem(`pmem-last:${namespace}`, next.draft.id);
    },
    [refreshList, refreshDrafts, namespace],
  );
  const newNote = useCallback(
    (text = '') => {
      if (!db || !slot) return;
      sequence.current++;
      const id = crypto.randomUUID();
      const draft: Draft = {
        key: `${namespace}:${slot}:${id}`,
        namespace,
        slot,
        id,
        body: '',
        base: null,
        rev: 0,
        modified: Date.now(),
        meaningful: false,
      };
      const next = new NoteController(db, api, draft);
      install(next);
      setOpening(false);
      if (text) next.change(text, true);
    },
    [db, slot, namespace, install, api],
  );
  const openNote = useCallback(
    async (id: string) => {
      if (!db || !slot || !NOTE_ID.test(id)) return;
      const existing = [...all.current].find((c) => c.draft.id === id && !c.view().deleted);
      if (existing) {
        sequence.current++;
        install(existing);
        setOpening(false);
        void existing.refresh();
        return;
      }
      const request = ++sequence.current;
      setOpening(true);
      setError('');
      try {
        const saved = await db.get(`${namespace}:${slot}:${id}`),
          cached = await db.cached(namespace, id);
        let draft = saved;
        if (!draft) {
          let body = cached?.body,
            base = cached?.etag;
          if (body === undefined) {
            const start = performance.now();
            const response = await api.call(`/notes/${id}`);
            body = await response.text();
            base = response.headers.get('etag') ?? undefined;
            if (!base) throw new Error('Missing ETag');
            await db.clean(namespace, id, body, base);
            performance.clearMeasures('pmem:read');
            performance.measure('pmem:read', { start, end: performance.now() });
          }
          draft = {
            key: `${namespace}:${slot}:${id}`,
            namespace,
            slot,
            id,
            body,
            base: base!,
            rev: 0,
            modified: Date.now(),
            meaningful: Boolean(body.trim()),
          };
        }
        if (request !== sequence.current) return;
        const next = new NoteController(db, api, draft, Boolean(saved));
        install(next);
        void next.refresh();
      } catch (e) {
        if (request === sequence.current) {
          setError(
            e instanceof HttpError && e.status === 404
              ? '这篇笔记已不存在。未同步内容可从草稿中恢复。'
              : '打开失败，请检查连接后重试。',
          );
          if (e instanceof HttpError && e.status === 401) onExpired();
        }
      } finally {
        if (request === sequence.current) setOpening(false);
      }
    },
    [db, slot, namespace, api, install],
  );
  useEffect(() => {
    let alive = true;
    const database = Drafts.open().catch(() => {
      setError('浏览器存储不可用。当前文字仅保留在页面内，请复制后再关闭。');
      return Drafts.unavailable();
    });
    void Promise.all([database, acquireSlot(namespace)])
      .then(([database, lock]) => {
        if (!alive) {
          database.close();
          lock.release();
          return;
        }
        release.current = lock.release;
        setDb(database);
        setSlot(lock.id);
      })
      .catch(() => setError('无法保存本机草稿。请允许此网站使用浏览器存储后重新打开。'));
    return () => {
      alive = false;
      sequence.current++;
      void Promise.all([...all.current].map((c) => c.shutdown())).finally(() => release.current());
    };
  }, [namespace]);
  const started = useRef(false);
  useEffect(() => {
    if (!db || !slot || started.current) return;
    started.current = true;
    void refreshList();
    void refreshDrafts();
    const id =
      location.hash.match(/^#\/note\/([0-9a-f-]+)$/)?.[1] ??
      localStorage.getItem(`pmem-last:${namespace}`);
    if (id && NOTE_ID.test(id)) void openNote(id);
    else newNote();
  }, [db, slot, openNote, newNote, refreshList, refreshDrafts, namespace]);
  useEffect(() => {
    const resume = () => {
      if (document.visibilityState === 'visible') {
        void current.current?.refresh();
        void refreshDrafts();
      }
    };
    const hash = () => {
      const id = location.hash.match(/^#\/note\/([0-9a-f-]+)$/)?.[1];
      if (id && id !== current.current?.draft.id) void openNote(id);
    };
    const timer = setInterval(resume, 5000);
    document.addEventListener('visibilitychange', resume);
    window.addEventListener('online', resume);
    window.addEventListener('hashchange', hash);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', resume);
      window.removeEventListener('online', resume);
      window.removeEventListener('hashchange', hash);
    };
  }, [openNote, refreshDrafts]);
  useEffect(() => {
    if (generation) void current.current?.refresh();
  }, [generation]);
  async function logout(remoteLogout = false) {
    if (
      !remoteLogout &&
      !window.confirm(
        '退出会清除此浏览器所有标签页的本机草稿。请先确认内容已同步或复制。继续退出？',
      )
    )
      return;
    setOpening(true);
    try {
      await Promise.all([...all.current].map((c) => c.shutdown()));
      if (!remoteLogout) {
        await api.call('/auth/logout', { method: 'POST' });
        channel.current?.postMessage('logout');
      }
      await db?.clear(namespace);
      localStorage.removeItem(`pmem-last:${namespace}`);
      onLogout();
    } catch {
      setError('退出未完成，请检查连接。草稿仍然保留，重新打开页面可继续。');
      setOpening(false);
    }
  }
  useEffect(() => {
    const c = new BroadcastChannel(`pmem:${namespace}`);
    channel.current = c;
    c.onmessage = (e) => {
      if (e.data === 'logout') void logout(true);
    };
    return () => c.close();
  }, [db]);
  async function restore(source: Draft) {
    if (!db) return;
    const existing = [...all.current].find((c) => c.draft.id === source.id && !c.view().deleted);
    if (existing?.draft.key === source.key) {
      install(existing);
      setShowRecovery(false);
      return;
    }
    if (existing?.draft.pending) throw new Error('Note has an unresolved save');
    const restored = {
      ...source,
      key: `${namespace}:${slot}:${source.id}`,
      slot,
      rev: source.rev + 1,
      modified: Date.now(),
    };
    const previous = await db.get(restored.key);
    if (
      previous &&
      previous.key !== source.key &&
      !window.confirm('当前标签也有未同步内容。用选中的草稿替换它？')
    )
      return;
    if (existing) {
      await existing.shutdown();
      if (existing.draft.pending) {
        existing.resume();
        throw new Error('Note has an unresolved save');
      }
    }
    try {
      await db.put(restored);
    } catch (e) {
      existing?.resume();
      throw e;
    }
    if (existing) all.current.delete(existing);
    if (restored.key !== source.key) await removeOrphan(db, source).catch(() => {});
    install(new NoteController(db, api, restored, true));
    setShowRecovery(false);
    await refreshDrafts();
  }
  async function discard(source: Draft) {
    if (!db || !window.confirm('永久丢弃这份本机草稿？')) return;
    const existing = [...all.current].find((c) => c.draft.key === source.key);
    if (existing) {
      await existing.shutdown();
      if (existing.draft.pending) {
        existing.resume();
        setError('这份草稿仍有待确认的保存，请先检查同步或复制内容。');
        return;
      }
      try {
        await db.remove(source.key, existing.draft.rev);
      } catch {
        existing.resume();
        setError('丢弃失败，草稿仍保留。');
        return;
      }
      all.current.delete(existing);
      if (existing === current.current) newNote();
    } else if (source.slot === slot) await db.remove(source.key, source.rev);
    else await removeOrphan(db, source);
    await refreshDrafts();
  }
  const copy = async () => {
    const text = current.current?.draft.body ?? '';
    try {
      await navigator.clipboard.writeText(text);
      setError('已复制笔记内容。');
    } catch {
      setRemote(text);
    }
  };
  const title = controller?.draft.body ? noteTitle(controller.draft.body) : '新的想法';
  return (
    <div className="workspace">
      <aside className={`sidebar ${sidebar ? 'open' : ''}`}>
        <div className="brand">
          <span className="brand-mark small">m.</span>
          <div>
            Personal Memory<small>我的笔记本</small>
          </div>
          <button className="mobile-only" onClick={() => setSidebar(false)} aria-label="收起列表">
            ×
          </button>
        </div>
        <button className="primary new-note" disabled={!db} onClick={() => newNote()}>
          ＋ 新的笔记 <kbd>想到了，就记下</kbd>
        </button>
        <div className="list-heading">
          <span>最近修改</span>
          <button onClick={() => void refreshList()} aria-label="刷新列表">
            ↻
          </button>
        </div>
        <nav aria-label="笔记列表">
          {notes.map((note) => (
            <button
              className={`note-row ${controller?.draft.id === note.id ? 'selected' : ''}`}
              key={note.id}
              onClick={() => void openNote(note.id)}
            >
              <span className="note-icon">▤</span>
              <span>
                {note.title}
                <small>{new Date(note.modified).toLocaleDateString()}</small>
              </span>
            </button>
          ))}
          {!notes.length && (
            <p className="empty-list">
              写下第一条笔记，
              <br />
              从一个小想法开始。
            </p>
          )}
          {cursor && (
            <button className="load-more" onClick={() => void refreshList(cursor)}>
              加载更多
            </button>
          )}
        </nav>
        <div className="sidebar-bottom">
          <button
            onClick={() => {
              void refreshDrafts();
              setShowRecovery(true);
            }}
          >
            本机草稿{drafts.length ? ` · ${drafts.length}` : ''}
          </button>
          <div>
            <span>{api.session.account}</span>
            <button onClick={() => void logout()}>退出</button>
          </div>
        </div>
      </aside>
      {sidebar && (
        <button
          className="sidebar-backdrop mobile-only"
          aria-label="关闭列表"
          onClick={() => setSidebar(false)}
        />
      )}
      <main className="main-panel">
        <header className="note-header">
          <button
            className="mobile-only"
            aria-label="打开笔记列表"
            onClick={() => setSidebar(true)}
          >
            ☰
          </button>
          <div className="breadcrumb">
            笔记本 <span>/</span> {title}
          </div>
          <button disabled={!controller} onClick={() => void copy()}>
            复制
          </button>
          <button
            disabled={!controller || opening}
            onClick={() => {
              if (controller && window.confirm('删除这篇笔记？此操作没有历史版本可恢复。'))
                void controller.remove().then((ok) => {
                  if (ok) newNote();
                  else setError('删除尚未完成，请先处理保存状态。');
                });
            }}
          >
            删除
          </button>
        </header>
        {error && (
          <div className="notice" role="alert">
            {error}
            <button aria-label="关闭提示" onClick={() => setError('')}>
              ×
            </button>
          </div>
        )}
        {opening && (
          <div className="notice" role="status">
            正在打开…
          </div>
        )}
        {drafts.some((d) => d.slot !== slot) && (
          <div className="draft-hint">
            <button onClick={() => setShowRecovery(true)}>有未同步的本机草稿，查看并恢复 →</button>
          </div>
        )}
        {controller && (
          <>
            <div
              className={`save-status ${view?.block || view?.localFailed ? 'attention' : ''}`}
              role="status"
            >
              <span className="status-dot" />
              {view?.status}
              {view?.localFailed && (
                <button onClick={() => void controller.retryLocal().catch(() => {})}>
                  重试本机保存
                </button>
              )}
              {view?.block && (
                <>
                  <button
                    onClick={() => {
                      newNote(controller.draft.body);
                    }}
                  >
                    另存为新笔记
                  </button>
                  <button onClick={() => void controller.refresh()}>检查同步</button>
                </>
              )}
              {view?.block === 'conflict' && (
                <>
                  <button onClick={() => setRemote(view.remote ?? '')}>查看远端内容</button>
                  <button
                    onClick={() => {
                      if (window.confirm('使用远端内容会丢弃当前标签的草稿。继续？'))
                        void controller
                          .useRemote()
                          .catch(() => setError('无法读取远端内容，请稍后重试。'));
                    }}
                  >
                    使用远端内容
                  </button>
                </>
              )}
            </div>
            <EditorView key={controller.draft.key} controller={controller} onState={setView} />
            <footer className="editor-footer">
              <span>文字留在这里，思绪继续向前。</span>
              <span>{controller.draft.body.length.toLocaleString()} 字符 · 输入 / 插入内容</span>
            </footer>
          </>
        )}
        {!controller && !opening && (
          <div className="welcome">
            <p className="eyebrow">A SPACE FOR YOUR THOUGHTS</p>
            <h1>从此刻，开始记录。</h1>
            <p>选择一篇笔记，或捕捉一个新的想法。</p>
            <button className="primary" onClick={() => newNote()} disabled={!db}>
              写一篇笔记
            </button>
          </div>
        )}
      </main>
      {showRecovery && (
        <div className="dialog-backdrop">
          <section className="dialog" role="dialog" aria-modal="true" aria-label="恢复本机草稿">
            <header>
              <h2>本机草稿 · {drafts.length}</h2>
              <button aria-label="关闭草稿" onClick={() => setShowRecovery(false)}>
                ×
              </button>
            </header>
            <p>未同步的文字会保留在这里。选择一份继续记录。</p>
            {drafts.slice(0, recoverCount).map((d) => (
              <div className="draft-row" key={d.key}>
                <div>
                  {d.body.slice(0, 80) || '空白草稿'}
                  <small>{new Date(d.modified).toLocaleString()}</small>
                </div>
                <button
                  onClick={() => void restore(d).catch(() => setError('恢复失败，原草稿仍保留。'))}
                >
                  恢复
                </button>
                <button
                  onClick={() => void discard(d).catch(() => setError('丢弃失败，草稿仍保留。'))}
                >
                  丢弃
                </button>
              </div>
            ))}
            {recoverCount < drafts.length && (
              <button onClick={() => setRecoverCount((n) => n + 5)}>加载更多</button>
            )}
          </section>
        </div>
      )}
      {remote !== null && (
        <div className="dialog-backdrop">
          <section className="dialog" role="dialog" aria-modal="true" aria-label="查看内容">
            <header>
              <h2>内容原文</h2>
              <button aria-label="关闭原文" onClick={() => setRemote(null)}>
                ×
              </button>
            </header>
            <textarea readOnly aria-label="内容原文" value={remote} />
          </section>
        </div>
      )}
    </div>
  );
}
