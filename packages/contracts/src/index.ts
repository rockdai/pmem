export const MAX_BYTES = 1024 * 1024;
export const NOTE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export interface NoteSummary { id: string; title: string; modified: number }
export interface NotePage { notes: NoteSummary[]; cursor?: string }
export interface SessionInfo { account: string; deployment: string; csrf: string }
export type BlockReason = 'oversize' | 'invalid' | 'auth' | 'conflict' | 'deleted' | 'pending';
export function noteTitle(body: string) {
  const line = body.split(/\r?\n/).find(value => value.trim()) ?? '';
  return line.replace(/^\s*(?:#{1,6}\s+|>\s?|[-+*]\s+|\d+[.)]\s+)/, '').replace(/^\[[ xX]\]\s+/, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/[*_`]/g, '').trim().slice(0, 120) || '未命名笔记';
}
