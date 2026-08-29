import { randomBytes, randomUUID } from 'node:crypto';
import { decryptChunk, encryptChunk, generateFileKey, sha256 } from '../../../packages/crypto/src/index.js';
import { product } from '../../../packages/config/src/index.js';
import { choosePlacement } from '../../../packages/storage-orchestrator/src/index.js';
import type { FileChunk, FileRecord, LedgerEntry, NodeStatus, Platform, StorageNode } from '../../../packages/types/src/index.js';
import { JsonStateStore, type PersistedState } from './state-store.js';

export class DomainError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) {
    super(message);
    this.name = 'DomainError';
  }
}

export interface PledgeDriveServiceOptions {
  store?: JsonStateStore;
  masterKey?: Buffer;
  maxUploadBytes?: number;
  clock?: () => string;
}

const nodeStatuses = new Set<NodeStatus>(['REGISTERING', 'ONLINE', 'DEGRADED', 'PAUSED', 'OFFLINE', 'SUSPENDED', 'RETIRED']);
const platforms = new Set<Platform>(['windows', 'macos', 'linux', 'android', 'ios', 'nas', 'server']);
const ledgerTypes = new Set<LedgerEntry['type']>(['STORAGE_CONTRIBUTION', 'BANDWIDTH_CONTRIBUTION', 'STORAGE_USAGE', 'ADJUSTMENT']);

export class PledgeDriveService {
  readonly nodes = new Map<string, StorageNode>();
  readonly files = new Map<string, FileRecord>();
  /** Encrypted bytes keyed by `${nodeId}:${chunkId}`. */
  readonly chunks = new Map<string, Buffer>();
  readonly ledger: LedgerEntry[] = [];
  readonly quotas = new Map<string, { quotaBytes: number; usedBytes: number }>();

  private readonly store?: JsonStateStore;
  private readonly masterKey: Buffer;
  private readonly maxUploadBytes: number;
  private readonly clock: () => string;

  constructor(options: PledgeDriveServiceOptions = {}) {
    this.store = options.store;
    if (options.masterKey && options.masterKey.length !== 32) throw new Error('masterKey must be exactly 32 bytes');
    this.masterKey = options.masterKey ? Buffer.from(options.masterKey) : randomBytes(32);
    this.maxUploadBytes = options.maxUploadBytes ?? product.maxUploadBytes;
    this.clock = options.clock ?? (() => new Date().toISOString());
    const state = this.store?.load();
    if (state) this.hydrate(state);
  }

  ensureAccount(userId: string) {
    if (!userId || userId.length > 128) throw new DomainError('INVALID_USER', 'A valid user account is required');
    if (!this.quotas.has(userId)) this.quotas.set(userId, { quotaBytes: product.defaultQuotaBytes, usedBytes: 0 });
    return this.quotas.get(userId)!;
  }

  registerNode(input: Omit<StorageNode, 'id' | 'availableBytes' | 'usedBytes' | 'status' | 'lastSeen' | 'reliabilityScore' | 'reliabilityClass'>) {
    return this.transact(() => {
      const userId = this.requiredText(input.userId, 'userId', 128);
      const deviceId = this.requiredText(input.deviceId, 'deviceId', 128);
      const publicKey = this.requiredText(input.publicKey, 'publicKey', 4096);
      const region = this.requiredText(input.region, 'region', 32).toUpperCase();
      const version = this.requiredText(input.version, 'version', 64);
      if (!platforms.has(input.platform)) throw new DomainError('INVALID_PLATFORM', 'Unsupported node platform');
      if (!Number.isSafeInteger(input.capacityBytes) || input.capacityBytes <= 0) throw new DomainError('INVALID_CAPACITY', 'Capacity must be a positive integer');
      if (!Number.isSafeInteger(input.pledgedBytes) || input.pledgedBytes < 0 || input.pledgedBytes > input.capacityBytes) throw new DomainError('INVALID_PLEDGE', 'Pledged capacity must be between zero and physical capacity');
      if (!Number.isFinite(input.bandwidthMbps) || input.bandwidthMbps < 0) throw new DomainError('INVALID_BANDWIDTH', 'Bandwidth must be zero or greater');
      if (this.userNodes(userId).some(node => node.deviceId === deviceId && node.status !== 'RETIRED')) throw new DomainError('NODE_EXISTS', 'A node with this device name is already registered', 409);
      const mobile = input.platform === 'android' || input.platform === 'ios';
      const node: StorageNode = {
        ...input,
        userId,
        deviceId,
        publicKey,
        region,
        version,
        id: randomUUID(),
        availableBytes: input.pledgedBytes,
        usedBytes: 0,
        status: 'ONLINE',
        lastSeen: this.clock(),
        reliabilityScore: mobile ? 0.75 : 0.99,
        reliabilityClass: mobile ? 'C' : 'A'
      };
      this.nodes.set(node.id, node);
      return node;
    });
  }

  upload(userId: string, name: string, data: Buffer) {
    return this.transact(() => {
      const quota = this.ensureAccount(userId);
      const filename = this.validFilename(name);
      if (!Buffer.isBuffer(data) || data.length === 0) throw new DomainError('EMPTY_UPLOAD', 'The uploaded file is empty');
      if (data.length > this.maxUploadBytes) throw new DomainError('UPLOAD_TOO_LARGE', `Uploads are limited to ${this.maxUploadBytes} bytes`, 413);
      if (quota.usedBytes + data.length > quota.quotaBytes) throw new DomainError('QUOTA_EXCEEDED', 'Storage quota exceeded', 413);

      const simulation = new Map([...this.nodes.values()].map(node => [node.id, node.availableBytes]));
      const placements: Array<{ part: Buffer; nodes: StorageNode[] }> = [];
      for (let offset = 0; offset < data.length; offset += product.chunkSizeBytes) {
        const part = data.subarray(offset, offset + product.chunkSizeBytes);
        const candidates = [...this.nodes.values()].map(node => ({ ...node, availableBytes: simulation.get(node.id) ?? 0 }));
        const selected = choosePlacement(candidates, part.length, product.replicationFactor);
        if (selected.length < product.replicationFactor) throw new DomainError('INSUFFICIENT_CAPACITY', 'Not enough healthy, diverse capacity is available for this file', 507);
        for (const node of selected) simulation.set(node.id, (simulation.get(node.id) ?? 0) - part.length);
        placements.push({ part, nodes: selected.map(node => this.nodes.get(node.id)!) });
      }

      const fileKey = generateFileKey();
      const wrappedKey = encryptChunk(fileKey, this.masterKey);
      const chunks: FileChunk[] = [];
      for (const placement of placements) {
        const encrypted = encryptChunk(placement.part, fileKey);
        const chunk: FileChunk = {
          id: randomUUID(),
          hash: sha256(placement.part),
          storageHash: sha256(encrypted.ciphertext),
          bytes: encrypted.ciphertext.length,
          replicas: placement.nodes.map(node => node.id),
          nonce: encrypted.nonce,
          tag: encrypted.tag
        };
        for (const node of placement.nodes) {
          node.availableBytes -= chunk.bytes;
          node.usedBytes += chunk.bytes;
          this.chunks.set(`${node.id}:${chunk.id}`, Buffer.from(encrypted.ciphertext));
        }
        chunks.push(chunk);
      }
      const file: FileRecord = {
        id: randomUUID(),
        userId,
        name: filename,
        size: data.length,
        createdAt: this.clock(),
        encryption: { algorithm: 'AES-256-GCM', wrappedKey: wrappedKey.ciphertext.toString('base64'), nonce: wrappedKey.nonce, tag: wrappedKey.tag },
        chunks
      };
      this.files.set(file.id, file);
      quota.usedBytes += data.length;
      return file;
    });
  }

  download(userId: string, fileId: string): Buffer {
    const file = this.files.get(fileId);
    if (!file || file.userId !== userId) throw new DomainError('FILE_NOT_FOUND', 'File not found', 404);
    let fileKey: Buffer;
    try {
      fileKey = decryptChunk(Buffer.from(file.encryption.wrappedKey, 'base64'), this.masterKey, file.encryption.nonce, file.encryption.tag);
    } catch {
      throw new DomainError('KEY_UNAVAILABLE', 'This file is temporarily unavailable', 503);
    }
    const parts: Buffer[] = [];
    for (const chunk of file.chunks) {
      let recovered: Buffer | undefined;
      for (const replicaId of chunk.replicas) {
        if (this.nodes.get(replicaId)?.status !== 'ONLINE') continue;
        const encrypted = this.chunks.get(`${replicaId}:${chunk.id}`);
        if (!encrypted || sha256(encrypted) !== chunk.storageHash) continue;
        try {
          const plaintext = decryptChunk(encrypted, fileKey, chunk.nonce, chunk.tag);
          if (sha256(plaintext) !== chunk.hash) continue;
          recovered = plaintext;
          break;
        } catch {
          // Try the next independently verified replica.
        }
      }
      if (!recovered) throw new DomainError('FILE_UNAVAILABLE', 'No healthy verified replica is available', 503);
      parts.push(recovered);
    }
    return Buffer.concat(parts);
  }

  deleteFile(userId: string, fileId: string): void {
    this.transact(() => {
      const file = this.files.get(fileId);
      if (!file || file.userId !== userId) throw new DomainError('FILE_NOT_FOUND', 'File not found', 404);
      for (const chunk of file.chunks) {
        for (const replicaId of chunk.replicas) {
          const key = `${replicaId}:${chunk.id}`;
          if (!this.chunks.delete(key)) continue;
          const node = this.nodes.get(replicaId);
          if (node) {
            node.usedBytes = Math.max(0, node.usedBytes - chunk.bytes);
            node.availableBytes = Math.min(node.pledgedBytes - node.usedBytes, node.availableBytes + chunk.bytes);
          }
        }
      }
      this.files.delete(fileId);
      const quota = this.ensureAccount(userId);
      quota.usedBytes = Math.max(0, quota.usedBytes - file.size);
    });
  }

  setNodeStatus(id: string, status: NodeStatus) {
    return this.transact(() => {
      const node = this.nodes.get(id);
      if (!node) throw new DomainError('NODE_NOT_FOUND', 'Node not found', 404);
      if (!nodeStatuses.has(status)) throw new DomainError('INVALID_STATUS', 'Unsupported node status');
      node.status = status;
      node.lastSeen = this.clock();
      return node;
    });
  }

  repair(): number {
    return this.transact(() => {
      let repaired = 0;
      for (const file of this.files.values()) {
        for (const chunk of file.chunks) {
          const healthy = chunk.replicas.filter(id => this.validReplica(file, chunk, id));
          if (healthy.length >= product.replicationFactor) continue;
          const source = healthy.map(id => this.chunks.get(`${id}:${chunk.id}`)).find(Boolean);
          if (!source) continue;
          const candidates = choosePlacement(
            [...this.nodes.values()].filter(node => !chunk.replicas.includes(node.id)),
            chunk.bytes,
            product.replicationFactor - healthy.length
          );
          for (const node of candidates) {
            this.chunks.set(`${node.id}:${chunk.id}`, Buffer.from(source));
            node.availableBytes -= chunk.bytes;
            node.usedBytes += chunk.bytes;
            chunk.replicas.push(node.id);
            repaired++;
          }
        }
      }
      return repaired;
    });
  }

  credit(accountId: string, amount: number, type: LedgerEntry['type'], reference: string) {
    return this.transact(() => {
      if (!Number.isFinite(amount) || amount === 0) throw new DomainError('INVALID_LEDGER_AMOUNT', 'Ledger amount must be a non-zero finite number');
      if (!ledgerTypes.has(type)) throw new DomainError('INVALID_LEDGER_TYPE', 'Unsupported ledger entry type');
      if (!reference || reference.length > 256) throw new DomainError('INVALID_LEDGER_REFERENCE', 'Ledger reference is required');
      this.ensureAccount(accountId);
      const entry = { id: randomUUID(), accountId, amount, type, reference, createdAt: this.clock() } satisfies LedgerEntry;
      this.ledger.push(entry);
      return entry;
    });
  }

  balance(accountId: string) {
    return this.ledger.filter(entry => entry.accountId === accountId).reduce((total, entry) => total + entry.amount, 0);
  }

  ledgerFor(accountId: string) {
    return this.ledger.filter(entry => entry.accountId === accountId);
  }

  dashboard(userId: string) {
    const quota = this.ensureAccount(userId);
    const files = [...this.files.values()].filter(file => file.userId === userId).map(file => ({
      id: file.id,
      userId: file.userId,
      name: file.name,
      size: file.size,
      createdAt: file.createdAt,
      chunks: file.chunks.map(chunk => ({ id: chunk.id, bytes: chunk.bytes, replicaCount: chunk.replicas.length }))
    }));
    const totalChunks = [...this.files.values()].reduce((total, file) => total + file.chunks.length, 0);
    const healthyChunks = [...this.files.values()].reduce((total, file) => total + file.chunks.filter(chunk => chunk.replicas.filter(id => this.validReplica(file, chunk, id)).length >= product.replicationFactor).length, 0);
    const onlineNodes = [...this.nodes.values()].filter(node => node.status === 'ONLINE');
    return {
      quota,
      nodes: this.userNodes(userId),
      files,
      credits: this.balance(userId),
      network: {
        nodes: this.nodes.size,
        onlineNodes: onlineNodes.length,
        pledgedBytes: [...this.nodes.values()].reduce((total, node) => total + node.pledgedBytes, 0),
        verifiedBytes: [...this.nodes.values()].reduce((total, node) => total + node.usedBytes + node.availableBytes, 0),
        onlineBytes: onlineNodes.reduce((total, node) => total + node.availableBytes, 0),
        allocatedBytes: [...this.nodes.values()].reduce((total, node) => total + node.usedBytes, 0),
        totalChunks,
        healthyChunks,
        replicationHealth: totalChunks === 0 ? 1 : healthyChunks / totalChunks
      }
    };
  }

  snapshot(): PersistedState {
    return {
      version: 1,
      nodes: [...this.nodes.values()].map(node => ({ ...node })),
      files: [...this.files.values()].map(file => ({ ...file, chunks: file.chunks.map(chunk => ({ ...chunk, replicas: [...chunk.replicas] })) })),
      chunks: [...this.chunks.entries()].map(([key, data]) => ({ key, data: data.toString('base64') })),
      ledger: this.ledger.map(entry => ({ ...entry })),
      quotas: [...this.quotas.entries()].map(([userId, quota]) => ({ userId, ...quota }))
    };
  }

  private hydrate(state: PersistedState): void {
    this.nodes.clear();
    this.files.clear();
    this.chunks.clear();
    this.ledger.splice(0, this.ledger.length);
    this.quotas.clear();
    for (const node of state.nodes) this.nodes.set(node.id, { ...node });
    for (const file of state.files) this.files.set(file.id, { ...file, chunks: file.chunks.map(chunk => ({ ...chunk, replicas: [...chunk.replicas] })) });
    for (const chunk of state.chunks) this.chunks.set(chunk.key, Buffer.from(chunk.data, 'base64'));
    this.ledger.push(...state.ledger.map(entry => ({ ...entry })));
    for (const quota of state.quotas) this.quotas.set(quota.userId, { quotaBytes: quota.quotaBytes, usedBytes: quota.usedBytes });
  }

  private transact<T>(mutator: () => T): T {
    const previous = this.snapshot();
    try {
      const result = mutator();
      this.store?.save(this.snapshot());
      return result;
    } catch (error) {
      this.hydrate(previous);
      throw error;
    }
  }

  private userNodes(userId: string) {
    return [...this.nodes.values()].filter(node => node.userId === userId);
  }

  private validReplica(file: FileRecord, chunk: FileChunk, nodeId: string): boolean {
    if (this.nodes.get(nodeId)?.status !== 'ONLINE') return false;
    const encrypted = this.chunks.get(`${nodeId}:${chunk.id}`);
    if (!encrypted || sha256(encrypted) !== chunk.storageHash) return false;
    try {
      const fileKey = decryptChunk(Buffer.from(file.encryption.wrappedKey, 'base64'), this.masterKey, file.encryption.nonce, file.encryption.tag);
      const plaintext = decryptChunk(encrypted, fileKey, chunk.nonce, chunk.tag);
      return sha256(plaintext) === chunk.hash;
    } catch {
      return false;
    }
  }

  private requiredText(value: unknown, name: string, maxLength: number): string {
    if (typeof value !== 'string' || !value.trim() || value.length > maxLength) throw new DomainError('INVALID_INPUT', `${name} is required`);
    return value.trim();
  }

  private validFilename(value: string): string {
    if (typeof value !== 'string') throw new DomainError('INVALID_FILE_NAME', 'A file name is required');
    const filename = value.trim();
    if (!filename || filename === '.' || filename === '..' || filename.length > 255 || /[\\/\u0000-\u001f\u007f]/.test(filename)) throw new DomainError('INVALID_FILE_NAME', 'File names must be 1–255 characters and cannot contain path separators');
    return filename;
  }
}
