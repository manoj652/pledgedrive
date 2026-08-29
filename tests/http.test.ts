import test from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { loadConfig } from '../packages/config/src/index.js';
import { PledgeDriveService } from '../services/api/src/domain.js';
import { createPledgeDriveServer } from '../services/api/src/server.js';

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('Server did not expose a TCP address'));
      resolve(address.port);
    });
  });
}

test('HTTP contract exposes probes and guarded file lifecycle', async () => {
  const config = loadConfig({ NODE_ENV: 'test', PLEDGEDRIVE_HOST: '127.0.0.1', PLEDGEDRIVE_MAX_UPLOAD_BYTES: '64' });
  const service = new PledgeDriveService({ masterKey: config.masterKey, maxUploadBytes: config.maxUploadBytes });
  for (const userId of ['a', 'b', 'c']) service.registerNode({ userId, deviceId: `${userId}-node`, publicKey: `pk-${userId}`, region: 'IN', platform: 'linux', version: '0.1.0', capacityBytes: 1000, pledgedBytes: 800, bandwidthMbps: 50 });
  const server = createPledgeDriveServer({ service, config });
  const port = await listen(server);
  const base = `http://127.0.0.1:${port}`;
  try {
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    assert.equal(health.headers.get('x-content-type-options'), 'nosniff');
    assert.ok(health.headers.get('x-request-id'));
    const page = await fetch(`${base}/`);
    assert.equal(page.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.match(await page.text(), /PledgeDrive/);

    const upload = await fetch(`${base}/api/upload?name=hello.txt`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: Buffer.from('hello') });
    assert.equal(upload.status, 201);
    const uploaded = await upload.json() as { id: string; category: string; mimeType: string };
    assert.equal(uploaded.category, 'text');
    assert.equal(uploaded.mimeType, 'text/plain');
    const download = await fetch(`${base}/api/files/${uploaded.id}`);
    assert.equal(download.status, 200);
    assert.equal(Buffer.from(await download.arrayBuffer()).toString(), 'hello');

    const imageUpload = await fetch(`${base}/api/upload?name=photo.png`, { method: 'POST', headers: { 'content-type': 'image/png' }, body: Buffer.from('png bytes') });
    assert.equal(imageUpload.status, 201);
    const image = await imageUpload.json() as { id: string; category: string };
    assert.equal(image.category, 'image');
    const preview = await fetch(`${base}/api/files/${image.id}?inline=1`);
    assert.equal(preview.headers.get('content-type'), 'image/png');
    assert.match(preview.headers.get('content-disposition') || '', /^inline/);

    const tooLarge = await fetch(`${base}/api/upload?name=too.bin`, { method: 'POST', body: Buffer.alloc(65) });
    assert.equal(tooLarge.status, 413);
    const tooLargeBody = await tooLarge.json() as { code: string; requestId: string };
    assert.equal(tooLargeBody.code, 'PAYLOAD_TOO_LARGE');
    assert.ok(tooLargeBody.requestId);

    assert.equal((await fetch(`${base}/api/files/${uploaded.id}`, { method: 'DELETE' })).status, 204);
    assert.equal((await fetch(`${base}/api/files/${image.id}`, { method: 'DELETE' })).status, 204);
    assert.equal((await (await fetch(`${base}/api/dashboard`)).json() as { quota: { usedBytes: number } }).quota.usedBytes, 0);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test('configured API token protects account routes', async () => {
  const config = loadConfig({ NODE_ENV: 'test', PLEDGEDRIVE_API_TOKEN: 't'.repeat(32), PLEDGEDRIVE_MASTER_KEY: 'a'.repeat(64), PLEDGEDRIVE_HOST: '127.0.0.1' });
  const service = new PledgeDriveService({ masterKey: config.masterKey, maxUploadBytes: config.maxUploadBytes });
  const server = createPledgeDriveServer({ service, config });
  const port = await listen(server);
  const base = `http://127.0.0.1:${port}`;
  try {
    assert.equal((await fetch(`${base}/api/dashboard`)).status, 401);
    assert.equal((await fetch(`${base}/api/dashboard`, { headers: { authorization: `Bearer ${config.apiToken}` } })).status, 200);
    assert.equal((await fetch(`${base}/health`)).status, 200);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test('register, session, and logout endpoints manage an account cookie', async () => {
  const config = loadConfig({ NODE_ENV: 'test', PLEDGEDRIVE_HOST: '127.0.0.1' });
  const service = new PledgeDriveService({ masterKey: config.masterKey });
  const server = createPledgeDriveServer({ service, config });
  const port = await listen(server);
  const base = `http://127.0.0.1:${port}`;
  try {
    const register = await fetch(`${base}/api/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'new-user@example.com', password: 'correct horse battery' }) });
    assert.equal(register.status, 201);
    const cookieHeader = register.headers.get('set-cookie');
    assert.ok(cookieHeader);
    const cookie = cookieHeader.split(';', 1)[0];
    const me = await fetch(`${base}/api/auth/me`, { headers: { cookie } });
    assert.equal(me.status, 200);
    assert.equal((await me.json() as { authenticated: boolean }).authenticated, true);
    assert.equal((await fetch(`${base}/api/dashboard`, { headers: { cookie } })).status, 200);
    assert.equal((await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { cookie } })).status, 200);
    assert.equal((await (await fetch(`${base}/api/auth/me`, { headers: { cookie } })).json() as { authenticated: boolean }).authenticated, false);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
