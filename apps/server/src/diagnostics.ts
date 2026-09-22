// Deliberately exclude messages, stacks, URLs, headers and SDK response objects:
// those can contain credentials, signed URLs or note contents.
export interface ErrorIdentity {
  errorName: string;
  errorCode?: string;
  ossRequestId?: string;
}
export interface StorageDiagnostic extends ErrorIdentity {
  stage: 'pending_record' | 'oss_request' | 'pending_clear' | 'pending_verify';
  operation: 'create' | 'replace' | 'delete';
  noteId: string;
  operationId: string;
}
export interface RuntimeDiagnostic extends ErrorIdentity {
  event: 'request_error';
  requestId?: string;
  method: string;
  route?: string;
  status: number;
  code: string;
  stage?: StorageDiagnostic['stage'];
  operation?: StorageDiagnostic['operation'];
  noteId?: string;
  operationId?: string;
}
export type DiagnosticSink = (entry: RuntimeDiagnostic) => void;
export const safeToken = (value: unknown) =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : undefined;
export function errorIdentity(error: unknown): ErrorIdentity {
  const value = error as { name?: unknown; code?: unknown; requestId?: unknown } | null;
  return {
    errorName: safeToken(value?.name) ?? 'UnknownError',
    ...(safeToken(value?.code) ? { errorCode: safeToken(value?.code) } : {}),
    ...(safeToken(value?.requestId) ? { ossRequestId: safeToken(value?.requestId) } : {}),
  };
}
export const writeDiagnostic: DiagnosticSink = (entry) => {
  process.stderr.write(`${JSON.stringify(entry)}\n`);
};
