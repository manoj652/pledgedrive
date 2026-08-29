import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { loadConfig, product, type AppConfig } from '../../../packages/config/src/index.js';
import type { NodeStatus, Platform } from '../../../packages/types/src/index.js';
import { DomainError, PledgeDriveService } from './domain.js';
import { JsonStateStore } from './state-store.js';

export interface ServerDependencies {
  service: PledgeDriveService;
  config: AppConfig;
}

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = 'HttpError';
  }
}

type Metrics = {
  startedAt: number;
  requests: number;
  errors: number;
  routes: Map<string, number>;
};

const OPENAPI = {
  openapi: '3.0.3',
  info: { title: product.name + ' API', version: '0.1.0', description: 'Encrypted, replicated storage control-plane API.' },
  servers: [{ url: '/' }],
  paths: {
    '/health': { get: { summary: 'Liveness probe', responses: { '200': { description: 'Service is alive' } } } },
    '/ready': { get: { summary: 'Readiness probe', responses: { '200': { description: 'Service is ready' } } } },
    '/api/auth/me': { get: { summary: 'Read current session' } },
    '/api/auth/register': { post: { summary: 'Create an account and session' } },
    '/api/auth/login': { post: { summary: 'Sign in and create a session' } },
    '/api/auth/logout': { post: { summary: 'Revoke the current session' } },
    '/api/dashboard': { get: { summary: 'Account dashboard', responses: { '200': { description: 'Account, files, nodes, and network state' } } } },
    '/api/files': { get: { summary: 'List files', parameters: [{ name: 'query', in: 'query', schema: { type: 'string' } }] } },
    '/api/upload': { post: { summary: 'Upload a file', parameters: [{ name: 'name', in: 'query', required: true, schema: { type: 'string' } }], requestBody: { required: true, content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } } } },
    '/api/files/{id}': { get: { summary: 'Download a file' }, delete: { summary: 'Delete a file' } },
    '/api/nodes': { post: { summary: 'Register a storage node' } },
    '/api/nodes/{id}/status': { patch: { summary: 'Change node status' } },
    '/api/repair': { post: { summary: 'Repair under-replicated chunks' } },
    '/api/ledger': { get: { summary: 'Read the authenticated account ledger' } }
  }
} as const;

const jsonHeaders = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } as const;

function commonHeaders(res: ServerResponse, config: AppConfig, requestId: string): void {
  res.setHeader('x-request-id', requestId);
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('cross-origin-resource-policy', 'same-origin');
  if (config.allowedOrigin) {
    res.setHeader('access-control-allow-origin', config.allowedOrigin);
    res.setHeader('access-control-allow-credentials', 'true');
    res.setHeader('vary', 'Origin');
  }
}

function respondJson(res: ServerResponse, config: AppConfig, requestId: string, status: number, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value));
  commonHeaders(res, config, requestId);
  res.writeHead(status, { ...jsonHeaders, 'content-length': body.length });
  res.end(body);
}

function respondEmpty(res: ServerResponse, config: AppConfig, requestId: string, status: number): void {
  commonHeaders(res, config, requestId);
  res.writeHead(status, { 'cache-control': 'no-store' });
  res.end();
}

function requestIdFrom(req: IncomingMessage): string {
  const supplied = req.headers['x-request-id'];
  return typeof supplied === 'string' && /^[a-zA-Z0-9._:-]{1,100}$/.test(supplied) ? supplied : randomUUID();
}

function contentType(pathname: string): string {
  switch (extname(pathname).toLowerCase()) {
    case '.html': return 'text/html; charset=utf-8';
    case '.css': return 'text/css; charset=utf-8';
    case '.js': return 'application/javascript; charset=utf-8';
    case '.json': return 'application/json; charset=utf-8';
    case '.png': return 'image/png';
    case '.svg': return 'image/svg+xml';
    case '.ico': return 'image/x-icon';
    default: return 'application/octet-stream';
  }
}

async function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const declaredLength = Number(req.headers['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    req.resume();
    throw new HttpError(413, 'PAYLOAD_TOO_LARGE', `Request body exceeds the ${maxBytes}-byte limit`);
  }
  return new Promise((resolveBody, reject) => {
    const parts: Buffer[] = [];
    let total = 0;
    let settled = false;
    req.on('data', (part: Buffer) => {
      if (settled) return;
      total += part.length;
      if (total > maxBytes) {
        settled = true;
        req.resume();
        reject(new HttpError(413, 'PAYLOAD_TOO_LARGE', `Request body exceeds the ${maxBytes}-byte limit`));
        return;
      }
      parts.push(part);
    });
    req.on('end', () => {
      if (!settled) resolveBody(Buffer.concat(parts));
    });
    req.on('error', error => {
      if (!settled) reject(error);
    });
  });
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(req, 1024 * 1024);
  if (!raw.length) throw new HttpError(400, 'INVALID_JSON', 'A JSON request body is required');
  try {
    const value: unknown = JSON.parse(raw.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('object required');
    return value as Record<string, unknown>;
  } catch {
    throw new HttpError(400, 'INVALID_JSON', 'Request body must be valid JSON');
  }
}

function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  return Object.fromEntries(header.split(';').map(part => part.trim().split('=', 2)).filter(([name, value]) => name && value).map(([name, value]) => {
    try { return [name, decodeURIComponent(value)] as const; } catch { return [name, ''] as const; }
  }));
}

function sessionToken(req: IncomingMessage): string | undefined {
  return parseCookies(req.headers.cookie).pledgedrive_session;
}

function setSessionCookie(res: ServerResponse, token: string, config: AppConfig): void {
  const secure = config.environment === 'production' ? '; Secure' : '';
  res.setHeader('set-cookie', `pledgedrive_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${config.sessionTtlSeconds}${secure}`);
}

function clearSessionCookie(res: ServerResponse, config: AppConfig): void {
  const secure = config.environment === 'production' ? '; Secure' : '';
  res.setHeader('set-cookie', `pledgedrive_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`);
}

function authenticatedUser(req: IncomingMessage, config: AppConfig, service: PledgeDriveService): { userId: string; authenticated: boolean } | undefined {
  const bearer = req.headers.authorization;
  if (config.apiToken && bearer === `Bearer ${config.apiToken}`) return { userId: config.userId, authenticated: true };
  const sessionUser = service.resolveSession(sessionToken(req));
  if (sessionUser) return { userId: sessionUser, authenticated: true };
  if (config.environment !== 'production' && !config.apiToken) return { userId: config.userId, authenticated: false };
  return undefined;
}

function authUser(req: IncomingMessage, config: AppConfig, service: PledgeDriveService): string {
  const identity = authenticatedUser(req, config, service);
  if (!identity) throw new HttpError(401, 'UNAUTHORIZED', 'Authentication required');
  return identity.userId;
}

function routeMetric(pathname: string): string {
  if (pathname.startsWith('/api/files/')) return '/api/files/:id';
  if (pathname.startsWith('/api/nodes/') && pathname.endsWith('/status')) return '/api/nodes/:id/status';
  return pathname;
}

function staticRoot(config: AppConfig): string {
  if (existsSync(config.webRoot)) return resolve(config.webRoot);
  const sourceRoot = resolve(fileURLToPath(new URL('../../../../apps/web/public', import.meta.url)));
  return sourceRoot;
}

function safeFilePath(root: string, pathname: string): string {
  const candidate = resolve(root, pathname === '/' ? 'index.html' : pathname.slice(1));
  const rel = relative(root, candidate);
  if (rel.startsWith('..') || rel.includes('..\\') || rel.includes('../')) throw new HttpError(404, 'NOT_FOUND', 'Resource not found');
  return candidate;
}

function metricsText(metrics: Metrics, service: PledgeDriveService): string {
  const lines = [
    '# HELP pledgedrive_requests_total Total HTTP requests handled.',
    '# TYPE pledgedrive_requests_total counter',
    `pledgedrive_requests_total ${metrics.requests}`,
    '# HELP pledgedrive_errors_total Total HTTP errors returned.',
    '# TYPE pledgedrive_errors_total counter',
    `pledgedrive_errors_total ${metrics.errors}`,
    '# HELP pledgedrive_nodes Current registered storage nodes.',
    '# TYPE pledgedrive_nodes gauge',
    `pledgedrive_nodes ${service.nodes.size}`,
    '# HELP pledgedrive_files Current file metadata records.',
    '# TYPE pledgedrive_files gauge',
    `pledgedrive_files ${service.files.size}`,
    '# HELP pledgedrive_uptime_seconds Process uptime in seconds.',
    '# TYPE pledgedrive_uptime_seconds gauge',
    `pledgedrive_uptime_seconds ${Math.floor((Date.now() - metrics.startedAt) / 1000)}`
  ];
  for (const [route, count] of metrics.routes) lines.push(`pledgedrive_route_requests_total{route="${route}"} ${count}`);
  return `${lines.join('\n')}\n`;
}

export function createPledgeDriveServer({ service, config }: ServerDependencies): Server {
  const metrics: Metrics = { startedAt: Date.now(), requests: 0, errors: 0, routes: new Map() };
  const root = staticRoot(config);
  const server = createServer(async (req, res) => {
    const requestId = requestIdFrom(req);
    const started = Date.now();
    const pathname = (() => { try { return new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`).pathname; } catch { return ''; } })();
    metrics.requests++;
    metrics.routes.set(routeMetric(pathname), (metrics.routes.get(routeMetric(pathname)) ?? 0) + 1);
    res.once('finish', () => {
      if (!pathname.startsWith('/health') && !pathname.startsWith('/metrics')) console.log(JSON.stringify({ level: 'info', requestId, method: req.method, path: pathname, status: res.statusCode, durationMs: Date.now() - started }));
    });
    try {
      commonHeaders(res, config, requestId);
      if (!pathname) throw new HttpError(400, 'INVALID_URL', 'Invalid request URL');
      if (req.method === 'OPTIONS') {
        res.setHeader('access-control-allow-methods', 'GET,POST,PATCH,DELETE,OPTIONS');
        res.setHeader('access-control-allow-headers', 'authorization,content-type,x-request-id');
        return respondEmpty(res, config, requestId, 204);
      }
      if (pathname === '/health' && req.method === 'GET') return respondJson(res, config, requestId, 200, { status: 'ok', service: product.name, uptimeSeconds: Math.floor((Date.now() - metrics.startedAt) / 1000) });
      if (pathname === '/ready' && req.method === 'GET') return respondJson(res, config, requestId, 200, { status: 'ready', stateFile: config.stateFile });
      if (pathname === '/metrics' && req.method === 'GET') {
        const body = metricsText(metrics, service);
        res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body) });
        return res.end(body);
      }
      if (pathname === '/openapi.json' && req.method === 'GET') return respondJson(res, config, requestId, 200, OPENAPI);
      if (pathname === '/api/auth/me' && req.method === 'GET') {
        const identity = authenticatedUser(req, config, service);
        const authenticated = Boolean(identity?.authenticated);
        return respondJson(res, config, requestId, 200, { authenticated, user: authenticated ? service.accountView(identity!.userId) || { id: identity!.userId, email: null } : null });
      }
      if (pathname === '/api/auth/register' && req.method === 'POST') {
        const input = await readJson(req);
        const account = service.registerAccount(input.email as string, input.password as string);
        setSessionCookie(res, service.createSession(account.id), config);
        return respondJson(res, config, requestId, 201, { authenticated: true, user: service.accountView(account.id) });
      }
      if (pathname === '/api/auth/login' && req.method === 'POST') {
        const input = await readJson(req);
        const account = service.authenticateAccount(input.email as string, input.password as string);
        setSessionCookie(res, service.createSession(account.id), config);
        return respondJson(res, config, requestId, 200, { authenticated: true, user: service.accountView(account.id) });
      }
      if (pathname === '/api/auth/logout' && req.method === 'POST') {
        service.revokeSession(sessionToken(req));
        clearSessionCookie(res, config);
        return respondJson(res, config, requestId, 200, { authenticated: false, user: null });
      }
      const userId = pathname.startsWith('/api/') ? authUser(req, config, service) : config.userId;
      if (pathname === '/api/dashboard' && req.method === 'GET') return respondJson(res, config, requestId, 200, service.dashboard(userId));
      if (pathname === '/api/files' && req.method === 'GET') {
        const query = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`).searchParams.get('query')?.trim().toLowerCase() || '';
        const files = service.dashboard(userId).files.filter(file => !query || file.name.toLowerCase().includes(query));
        return respondJson(res, config, requestId, 200, { files });
      }
      if (pathname === '/api/upload' && req.method === 'POST') {
        const requestUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
        const name = requestUrl.searchParams.get('name') || 'upload.bin';
        const file = service.upload(userId, name, await readBody(req, config.maxUploadBytes), req.headers['content-type'] || 'application/octet-stream');
        res.setHeader('location', `/api/files/${file.id}`);
        return respondJson(res, config, requestId, 201, { id: file.id, name: file.name, size: file.size, mimeType: file.mimeType, category: file.category, chunks: file.chunks.length });
      }
      const fileMatch = pathname.match(/^\/api\/files\/([^/]+)$/);
      if (fileMatch && (req.method === 'GET' || req.method === 'HEAD' || req.method === 'DELETE')) {
        const fileId = decodeURIComponent(fileMatch[1]);
        if (req.method === 'DELETE') {
          service.deleteFile(userId, fileId);
          return respondEmpty(res, config, requestId, 204);
        }
        const file = service.fileFor(userId, fileId);
        const bytes = service.download(userId, fileId);
        commonHeaders(res, config, requestId);
        const requestUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
        const inlineRequested = requestUrl.searchParams.get('inline') === '1';
        const safeInlineMime = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif', 'video/mp4', 'video/webm', 'video/quicktime', 'video/x-m4v', 'audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/mp4', 'audio/flac', 'application/pdf']);
        const inline = inlineRequested && safeInlineMime.has(file.mimeType);
        res.setHeader('content-type', inline ? file.mimeType : 'application/octet-stream');
        res.setHeader('content-length', bytes.length);
        res.setHeader('content-disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.name)}`);
        res.setHeader('cache-control', 'private, no-store');
        if (req.method === 'HEAD') return res.end();
        return res.end(bytes);
      }
      if (pathname === '/api/nodes' && req.method === 'POST') {
        const input = await readJson(req);
        const node = service.registerNode({
          userId,
          deviceId: String(input.deviceId ?? ''),
          publicKey: String(input.publicKey ?? 'local-device'),
          region: String(input.region ?? 'IN'),
          platform: input.platform as Platform,
          version: String(input.version ?? product.minNodeVersion),
          capacityBytes: Number(input.capacityBytes),
          pledgedBytes: Number(input.pledgedBytes),
          bandwidthMbps: Number(input.bandwidthMbps ?? 0)
        });
        return respondJson(res, config, requestId, 201, node);
      }
      const statusMatch = pathname.match(/^\/api\/nodes\/([^/]+)\/status$/);
      if (statusMatch && req.method === 'PATCH') {
        const input = await readJson(req);
        return respondJson(res, config, requestId, 200, service.setNodeStatus(decodeURIComponent(statusMatch[1]), input.status as NodeStatus));
      }
      if (pathname === '/api/repair' && req.method === 'POST') return respondJson(res, config, requestId, 200, { repaired: service.repair() });
      if (pathname === '/api/ledger' && req.method === 'GET') return respondJson(res, config, requestId, 200, { entries: service.ledgerFor(userId), balance: service.balance(userId) });
      let file: Buffer;
      try {
        file = await readFile(safeFilePath(root, pathname));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new HttpError(404, 'NOT_FOUND', 'Resource not found');
        throw error;
      }
      commonHeaders(res, config, requestId);
      res.setHeader('content-type', contentType(pathname === '/' ? 'index.html' : pathname));
      const assetExtension = extname(pathname).toLowerCase();
      const mutableAsset = pathname === '/' || pathname.endsWith('.html') || assetExtension === '.js' || assetExtension === '.css';
      res.setHeader('cache-control', mutableAsset ? 'no-cache' : 'public, max-age=3600');
      if (pathname === '/' || pathname.endsWith('.html')) res.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
      res.setHeader('content-length', file.length);
      return res.end(file);
    } catch (error) {
      metrics.errors++;
      const domainError = error instanceof DomainError;
      const httpError = error instanceof HttpError;
      const status = domainError ? error.status : httpError ? error.status : 500;
      const code = domainError ? error.code : httpError ? error.code : 'INTERNAL_ERROR';
      const publicMessage = config.exposeErrors || domainError || httpError ? (error instanceof Error ? error.message : 'Request failed') : 'Request failed';
      respondJson(res, config, requestId, status, { error: publicMessage, code, requestId });
      console.error(JSON.stringify({ level: 'error', requestId, method: req.method, path: pathname, status, code, durationMs: Date.now() - started, message: error instanceof Error ? error.message : 'Request failed' }));
    }
  });
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  server.requestTimeout = 120_000;
  return server;
}

export function startServer(): Server {
  const config = loadConfig();
  const store = new JsonStateStore(config.stateFile);
  const service = new PledgeDriveService({ store, masterKey: config.masterKey, maxUploadBytes: config.maxUploadBytes, sessionTtlMs: config.sessionTtlSeconds * 1000 });
  if (config.environment !== 'production' && service.nodes.size === 0) {
    for (const [deviceId, platform, region] of [['Windows PC', 'windows', 'IN'], ['Linux NAS', 'linux', 'DE'], ['Mac mini', 'macos', 'US']] as const) {
      service.registerNode({ userId: config.userId, deviceId, publicKey: 'local-demo-key', region, platform, version: product.minNodeVersion, capacityBytes: 2 * 1024 ** 4, pledgedBytes: 500 * 1024 ** 3, bandwidthMbps: 100 });
    }
  }
  const server = createPledgeDriveServer({ service, config });
  const displayHost = config.host.includes(':') ? `[${config.host}]` : config.host;
  server.listen(config.port, config.host, () => console.log(JSON.stringify({ level: 'info', service: product.name, url: `http://${displayHost}:${config.port}`, environment: config.environment, stateFile: config.stateFile })));
  const shutdown = (signal: string) => {
    console.log(JSON.stringify({ level: 'info', message: 'Shutting down', signal }));
    server.close(error => { if (error) { console.error(error); process.exitCode = 1; } });
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) startServer();
