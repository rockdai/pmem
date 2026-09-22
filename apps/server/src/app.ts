import Fastify from 'fastify';
import secureSession from '@fastify/secure-session';
import rateLimit from '@fastify/rate-limit';
import staticFiles from '@fastify/static';
import { createHmac, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { MAX_BYTES, type SessionInfo } from '../../../packages/contracts/src/index';
import { AppError, Notes, type Store } from './storage';
import { binding, checkPassword, equal } from './auth';
import type { Config } from './config';
declare module '@fastify/secure-session' { interface SessionData { account: string; authBinding: string; csrf: string } }

export async function createApp(config: Config, store: Store, webRoot = resolve('dist/web')) {
  const app = Fastify({ logger: false, bodyLimit: MAX_BYTES, requestTimeout: 30_000, routerOptions: { maxParamLength: 100 } });
  const notes = new Notes(store), authBinding = binding(config.sessionKey, config.account, config.passwordHash);
  const deployment = createHmac('sha256', config.sessionKey).update(`${config.account}:${config.storage}:${config.oss ? config.oss.bucket + '/' + config.oss.prefix : config.dataDir}`).digest('hex').slice(0, 32);
  await app.register(secureSession, { key: config.sessionKey, expiry: 7 * 86400, cookieName: 'pmem-session', cookie: { path: '/', httpOnly: true, sameSite: 'strict', secure: config.origin.startsWith('https:'), maxAge: 7 * 86400 } });
  await app.register(rateLimit, { global: false });
  app.addContentTypeParser('text/markdown', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
  app.addHook('onSend', async (request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'same-origin');
    reply.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    if (request.routeOptions.url?.startsWith('/api/') || request.url === '/healthz') reply.header('Cache-Control', 'no-store');
  });
  app.addHook('preHandler', async (request, reply) => {
    if (!request.routeOptions.url?.startsWith('/api/')) return;
    const login = request.routeOptions.url === '/api/v1/auth/login';
    const mutation = !['GET', 'HEAD'].includes(request.method);
    if (mutation && request.headers.origin !== config.origin) throw new AppError(403, 'origin_rejected');
    if (login) return;
    if (!equal(request.session.get('authBinding'), authBinding) || request.session.get('account') !== config.account) { request.session.delete(); throw new AppError(401, 'unauthorized'); }
    if (mutation && !equal(request.headers['x-csrf-token'], request.session.get('csrf') ?? '')) throw new AppError(403, 'csrf_rejected');
  });
  app.setErrorHandler((error, _request, reply) => {
    const known = error instanceof AppError;
    const candidate = (error as { statusCode?: number }).statusCode;
    const status = known ? error.status : candidate && candidate < 500 ? candidate : 503;
    const code = known ? error.code : status === 413 ? 'too_large' : status === 429 ? 'rate_limited' : status < 500 ? 'invalid_request' : 'storage_unavailable';
    reply.status(status).send({ error: code });
  });
  app.get('/healthz', async () => ({ ok: true }));
  app.post<{ Body: { account?: string; password?: string } }>('/api/v1/auth/login', { bodyLimit: 4096, config: { rateLimit: { max: 10, timeWindow: 15 * 60_000 } } }, async (request) => {
    const { account, password } = request.body ?? {};
    if (typeof account !== 'string' || typeof password !== 'string') throw new AppError(400, 'invalid_credentials');
    const valid = await checkPassword(password, config.passwordHash);
    if (account !== config.account || !valid) throw new AppError(401, 'invalid_credentials');
    request.session.regenerate();
    request.session.set('account', config.account); request.session.set('authBinding', authBinding); request.session.set('csrf', randomBytes(24).toString('hex'));
    return { account: config.account, deployment, csrf: request.session.get('csrf')! } satisfies SessionInfo;
  });
  app.get('/api/v1/auth/session', async request => ({ account: config.account, deployment, csrf: request.session.get('csrf')! } satisfies SessionInfo));
  app.post('/api/v1/auth/logout', async (request, reply) => { request.session.delete(); reply.status(204).send(); });
  app.get<{ Querystring: { cursor?: string; limit?: string } }>('/api/v1/notes', async request => notes.list(request.query.cursor, request.query.limit === undefined ? 20 : Number(request.query.limit)));
  app.get<{ Params: { id: string } }>('/api/v1/notes/:id', async (request, reply) => {
    const result = await notes.get(request.params.id, request.headers['if-none-match']);
    reply.header('ETag', result.etag);
    if (result.body === undefined) return reply.status(304).send();
    return reply.type('text/markdown; charset=utf-8').send(result.body);
  });
  for (const method of ['POST', 'PUT'] as const) {
    app.route<{ Params: { id: string }; Body: Buffer }>({ method, url: '/api/v1/notes/:id', handler: async (request, reply) => {
      if (!Buffer.isBuffer(request.body) || !request.headers['content-type']?.startsWith('text/markdown')) throw new AppError(415, 'markdown_required');
      const etag = await notes.write(request.params.id, request.body, method === 'POST' ? 'create' : 'replace', request.headers['if-match']);
      reply.header('ETag', etag).status(method === 'POST' ? 201 : 204).send();
    } });
  }
  app.delete<{ Params: { id: string } }>('/api/v1/notes/:id', async (request, reply) => { await notes.remove(request.params.id, request.headers['if-match']); reply.status(204).send(); });
  if (existsSync(webRoot)) {
    await app.register(staticFiles, { root: webRoot, index: ['index.html'], preCompressed: true, maxAge: '1y', immutable: true, setHeaders(reply, path) { if (/index\.html(?:\.gz|\.br)?$/.test(path)) reply.header('Cache-Control', 'no-cache'); } });
  }
  return app;
}
