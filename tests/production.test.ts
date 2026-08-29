import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { PledgeDriveService } from '../services/api/src/domain.js';
import { JsonStateStore } from '../services/api/src/state-store.js';
import { loadConfig } from '../packages/config/src/index.js';

const masterKey = Buffer.alloc(32, 7);

test('production configuration fails closed without real secrets', () => {
  assert.throws(() => loadConfig({ NODE_ENV: 'production', PLEDGEDRIVE_API_TOKEN: 'too-short' }), /PLEDGEDRIVE_API_TOKEN/);
  assert.throws(() => loadConfig({ NODE_ENV: 'production', PLEDGEDRIVE_API_TOKEN: 'x'.repeat(32) }), /PLEDGEDRIVE_MASTER_KEY/);
  const config = loadConfig({ NODE_ENV: 'production', PLEDGEDRIVE_API_TOKEN: 'x'.repeat(32), PLEDGEDRIVE_MASTER_KEY: 'a'.repeat(64) });
  assert.equal(config.exposeErrors, false);
});

function addNode(service: PledgeDriveService, userId: string, deviceId = userId, pledge = 800_000) {
  return service.registerNode({ userId, deviceId, publicKey: `pk-${deviceId}`, region: 'IN', platform: 'linux', version: '0.1.0', capacityBytes: 1_000_000, pledgedBytes: pledge, bandwidthMbps: 100 });
}

test('encrypted replicas fail over around an offline and corrupted node', () => {
  const service = new PledgeDriveService({ masterKey });
  const nodes = [addNode(service, 'owner', 'owner-node'), addNode(service, 'provider-a'), addNode(service, 'provider-b'), addNode(service, 'provider-c')];
  const payload = Buffer.from('private payload');
  const file = service.upload('owner', 'private.txt', payload);
  const chunk = file.chunks[0];
  const firstReplica = chunk.replicas[0];
  const secondReplica = chunk.replicas[1];
  assert.notDeepEqual(service.chunks.get(`${firstReplica}:${chunk.id}`), payload);
  service.setNodeStatus(firstReplica, 'OFFLINE');
  service.chunks.set(`${secondReplica}:${chunk.id}`, Buffer.from('corrupt replica'));
  assert.deepEqual(service.download('owner', file.id), payload);
  assert.equal(nodes.length, 4);
});

test('failed uploads leave quota, node capacity, and chunks unchanged', () => {
  const service = new PledgeDriveService({ masterKey, maxUploadBytes: 1024 });
  addNode(service, 'a', 'a-node', 10);
  addNode(service, 'b', 'b-node', 10);
  addNode(service, 'c', 'c-node', 10);
  const before = service.snapshot();
  assert.throws(() => service.upload('owner', 'too-large.bin', Buffer.alloc(11)), /healthy, diverse capacity|limited/);
  assert.deepEqual(service.snapshot(), before);
});

test('state survives a restart with the same encryption key', () => {
  const directory = mkdtempSync(join(process.cwd(), 'pledgedrive-test-'));
  try {
    const statePath = join(directory, 'state.json');
    const first = new PledgeDriveService({ store: new JsonStateStore(statePath), masterKey });
    addNode(first, 'a', 'a-node'); addNode(first, 'b', 'b-node'); addNode(first, 'c', 'c-node'); addNode(first, 'd', 'd-node');
    const file = first.upload('a', 'restart.txt', Buffer.from('durable data'));
    assert.doesNotMatch(readFileSync(statePath, 'utf8'), /durable data/);
    const second = new PledgeDriveService({ store: new JsonStateStore(statePath), masterKey });
    assert.deepEqual(second.download('a', file.id), Buffer.from('durable data'));
    assert.equal(second.files.size, 1);
    assert.equal(second.nodes.size, 4);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('deleting a file releases quota and replica capacity', () => {
  const service = new PledgeDriveService({ masterKey });
  const nodes = [addNode(service, 'a', 'a-node'), addNode(service, 'b', 'b-node'), addNode(service, 'c', 'c-node')];
  const file = service.upload('a', 'remove.txt', Buffer.from('remove me'));
  const usedBefore = nodes.map(node => node.usedBytes);
  service.deleteFile('a', file.id);
  assert.equal(service.files.size, 0);
  assert.equal(service.ensureAccount('a').usedBytes, 0);
  assert.deepEqual(nodes.map(node => node.usedBytes), usedBefore.map(() => 0));
});
