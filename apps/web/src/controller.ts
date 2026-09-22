import { MAX_BYTES } from '../../../packages/contracts/src/index';
import { Api, HttpError } from './api';
import { type DraftStore, type Draft, type Submission } from './drafts';
export interface ViewState { body: string; status: string; dirty: boolean; block?: Draft['block']; remote?: string; deleted: boolean; localFailed: boolean }
const byteSize = (body: string) => new TextEncoder().encode(body).length;
export class NoteController {
  readonly draft: Draft;
  private queue: Promise<void> = Promise.resolve();
  private timer?: ReturnType<typeof setTimeout>;
  private maximum?: ReturnType<typeof setTimeout>;
  private inFlight = false;
  private localRev = -1;
  private dirty: boolean;
  private composing = false;
  private polling = false;
  private deleted = false;
  private localFailed = false;
  private remote?: string;
  private stopped = false;
  onView: (view: ViewState) => void = () => {};
  onSynced: () => void = () => {};
  onAuth: () => void = () => {};
  constructor(readonly db: DraftStore, readonly api: Api, draft: Draft, dirty = false) {
    this.draft = structuredClone(draft); this.dirty = dirty; this.localRev = draft.rev;
    if (draft.pending) this.draft.block = 'pending';
    if (byteSize(draft.body) > MAX_BYTES) this.draft.block = 'oversize';
  }
  view(): ViewState {
    const messages = { oversize: '内容超过 1 MiB，暂不能同步', invalid: '无法保存，可复制内容或另存为新笔记', auth: '登录已过期，请重新登录', conflict: '其他设备修改了这篇笔记，请选择如何保留内容', deleted: '这篇笔记已被删除，当前草稿仍保留', pending: '保存结果待确认，当前草稿仍保留' };
    return { body: this.draft.body, dirty: this.dirty, block: this.draft.block, remote: this.remote, deleted: this.deleted, localFailed: this.localFailed,
      status: this.localFailed ? '本机保存失败，请复制内容' : this.draft.block ? `${messages[this.draft.block]}${this.dirty && this.localRev === this.draft.rev ? ' · 已保存到本机' : ''}` : this.localRev !== this.draft.rev ? '正在保存' : this.dirty ? '已保存到本机，待同步' : this.draft.base ? '已同步' : '开始记录你的想法' };
  }
  private emit() { this.onView(this.view()); }
  private persist() {
    const snapshot = structuredClone(this.draft);
    const job = this.queue.catch(() => {}).then(() => this.db.put(snapshot));
    this.queue = job;
    return job.then(() => { this.localRev = snapshot.rev; this.localFailed = false; this.emit(); }, error => { this.localFailed = true; this.emit(); throw error; });
  }
  async durable() { await this.queue; }
  change(body: string, meaningful: boolean) {
    if (this.deleted || this.stopped) return;
    this.draft.body = body; this.draft.meaningful = meaningful; this.draft.rev++; this.draft.modified = Date.now(); this.dirty = true;
    const revision = this.draft.rev;
    if (byteSize(body) > MAX_BYTES) this.draft.block = 'oversize';
    else if (this.draft.block === 'oversize') this.draft.block = this.draft.pending ? 'pending' : undefined;
    this.emit();
    void this.persist().then(() => {
      if (!this.draft.base && !meaningful && !this.draft.pending && this.draft.rev === revision) return this.db.remove(this.draft.key, revision);
    }).catch(() => {});
    clearTimeout(this.timer); this.timer = setTimeout(() => { void this.save(); }, 500);
    this.maximum ??= setTimeout(() => { this.maximum = undefined; void this.save(); }, 2000);
  }
  composition(active: boolean) { this.composing = active; if (!active) this.timer = setTimeout(() => { void this.save(); }, 500); }
  private cancelTimers() { clearTimeout(this.timer); clearTimeout(this.maximum); this.timer = this.maximum = undefined; }
  detach() { this.onView = () => {}; this.cancelTimers(); void this.save(); }
  async shutdown() { this.stopped = true; this.cancelTimers(); while (this.inFlight || this.polling) await new Promise(resolve => setTimeout(resolve, 10)); await this.queue.catch(() => {}); }
  resume() { this.stopped = false; }
  async retryLocal() { await this.persist(); await this.save(); }
  async save() {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    if (this.stopped || this.localFailed || this.inFlight || this.composing || !this.dirty || this.draft.block || this.draft.pending || this.deleted) return;
    if (!this.draft.base && !this.draft.meaningful) return;
    if (byteSize(this.draft.body) > MAX_BYTES) return;
    this.cancelTimers(); this.inFlight = true;
    const sent: Submission = { body: this.draft.body, base: this.draft.base, rev: this.draft.rev, kind: this.draft.base ? 'replace' : 'create' };
    this.draft.pending = sent;
    try { await this.persist(); } catch { this.draft.pending = undefined; this.inFlight = false; return; }
    try {
      const response = await this.api.call(`/notes/${this.draft.id}`, { method: sent.kind === 'create' ? 'POST' : 'PUT', headers: { 'content-type': 'text/markdown', ...(sent.base ? { 'if-match': sent.base } : {}) }, body: sent.body });
      const etag = response.headers.get('etag'); if (!etag) throw new Error('Missing save acknowledgment');
      await this.ack(sent, etag);
    } catch (error) { await this.failure(error); }
    finally { this.inFlight = false; this.emit(); }
    if (this.dirty && !this.draft.block) this.timer = setTimeout(() => { void this.save(); }, 500);
  }
  private async ack(sent: Submission, etag: string) {
    this.draft.base = etag; this.draft.pending = undefined; this.draft.block = undefined;
    try { if (this.draft.rev === sent.rev) {
      await this.queue.catch(() => {});
      await this.db.clean(this.draft.namespace, this.draft.id, sent.body, etag, { key: this.draft.key, rev: sent.rev });
      // Input can arrive while IndexedDB commits: never mark that input synchronized.
      if (this.draft.rev === sent.rev) this.dirty = false;
      else await this.persist();
    } else await this.persist(); } catch { this.localFailed = true; }
    if (byteSize(this.draft.body) > MAX_BYTES) this.draft.block = 'oversize';
    this.onSynced(); this.emit();
  }
  private async failure(error: unknown) {
    if (error instanceof HttpError && [400, 401, 403, 404, 409, 412, 413, 415, 422, 428, 429].includes(error.status)) {
      if (error.status === 409) { await this.reconcile(true); return; }
      this.draft.pending = undefined;
      this.draft.block = error.status === 413 ? 'oversize' : error.status === 401 ? 'auth' : error.status === 404 ? 'deleted' : error.status === 412 ? 'conflict' : 'invalid';
      if (error.status === 401) this.onAuth();
    } else this.draft.block = 'pending';
    try { await this.persist(); } catch { /* retain in memory and report */ }
  }
  private async reconcile(rejectedCreate = false) {
    const sent = this.draft.pending; if (!sent) return;
    try {
      const response = await this.api.call(`/notes/${this.draft.id}`);
      const body = await response.text(), etag = response.headers.get('etag');
      if (body === sent.body && sent.kind !== 'delete' && etag) await this.ack(sent, etag);
      else { this.draft.block = rejectedCreate ? 'conflict' : 'pending'; if (rejectedCreate) this.draft.pending = undefined; this.remote = body; await this.persist(); }
    } catch (error) {
      if (error instanceof HttpError && error.status === 404 && sent.kind === 'delete') { await this.finishDelete(); return; }
      this.draft.block = error instanceof HttpError && error.status === 401 ? 'auth' : 'pending';
      if (this.draft.block === 'auth') this.onAuth();
      try { await this.persist(); } catch { /* retain draft */ }
    }
  }
  async refresh() {
    if (this.stopped || this.polling || this.inFlight || this.deleted) return;
    this.polling = true;
    try {
      if (this.draft.pending) { await this.reconcile(); return; }
      if (!this.draft.base) { if (this.draft.block === 'auth') { this.draft.block = undefined; await this.persist(); } return; }
      const baseline = this.draft.base, revision = this.draft.rev;
      const response = await this.api.call(`/notes/${this.draft.id}`, { headers: { 'if-none-match': this.draft.base } });
      if (this.draft.base !== baseline || this.draft.rev !== revision) return;
      if (response.status === 304) { if (this.draft.block === 'auth') { this.draft.block = undefined; await this.persist(); } return; }
      const body = await response.text(), etag = response.headers.get('etag'); if (!etag) return;
      if (this.draft.base !== baseline || this.draft.rev !== revision) return;
      if (this.dirty || this.composing || this.inFlight) { this.remote = body; this.draft.block = 'conflict'; await this.persist(); }
      else { this.draft.body = body; this.draft.base = etag; await this.db.clean(this.draft.namespace, this.draft.id, body, etag); }
    } catch (error) {
      if (error instanceof HttpError && [401, 404].includes(error.status)) { this.draft.block = error.status === 401 ? 'auth' : 'deleted'; if (this.draft.block === 'auth') this.onAuth(); if (this.dirty) await this.persist().catch(() => {}); }
    } finally { this.polling = false; this.emit(); if (this.dirty && !this.draft.block) void this.save(); }
  }
  async useRemote() {
    if (this.inFlight || this.draft.pending || this.composing) return;
    const revision = this.draft.rev;
    const response = await this.api.call(`/notes/${this.draft.id}`); const body = await response.text(), etag = response.headers.get('etag');
    if (!etag) throw new Error('Missing content acknowledgment');
    await this.queue.catch(() => {});
    if (this.draft.rev !== revision || this.inFlight || this.draft.pending || this.composing || this.stopped) throw new Error('Draft changed while reading remote');
    this.draft.body = body; this.draft.base = etag; this.draft.rev++; this.draft.block = undefined; this.remote = undefined;
    const applied = this.draft.rev; this.dirty = false; this.emit();
    const job = this.queue.then(() => this.db.clean(this.draft.namespace, this.draft.id, body, etag, { key: this.draft.key, rev: revision }));
    this.queue = job;
    try { await job; this.localRev = applied; this.localFailed = false; } catch (e) { this.localFailed = true; throw e; } finally { this.emit(); }
  }
  private async finishDelete() {
    this.cancelTimers(); await this.queue.catch(() => {}); await this.db.forget(this.draft.namespace, this.draft.id);
    if (this.draft.pending && this.draft.rev !== this.draft.pending.rev) { this.draft.pending = undefined; this.draft.block = 'deleted'; await this.persist(); }
    else { this.deleted = true; await this.db.remove(this.draft.key); this.dirty = false; this.draft.pending = undefined; }
    this.onSynced(); this.emit();
  }
  async remove() {
    if (this.stopped || this.composing || this.inFlight || this.draft.pending) return false;
    if (!this.draft.base) { await this.finishDelete(); return true; }
    this.inFlight = true; this.cancelTimers();
    this.draft.pending = { body: this.draft.body, base: this.draft.base, rev: this.draft.rev, kind: 'delete' };
    try {
      await this.persist();
      await this.api.call(`/notes/${this.draft.id}`, { method: 'DELETE', headers: { 'if-match': this.draft.base } });
      await this.finishDelete(); return this.deleted;
    } catch (error) { await this.failure(error); return false; }
    finally { this.inFlight = false; this.emit(); }
  }
}
