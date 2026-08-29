import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { extname } from 'node:path';
import { decryptChunk, encryptChunk, generateFileKey, sha256 } from '../../../packages/crypto/src/index.js';
import { product } from '../../../packages/config/src/index.js';
import { choosePlacement } from '../../../packages/storage-orchestrator/src/index.js';
import type { AccountRecord, FileCategory, FileChunk, FileRecord, LedgerEntry, NodeStatus, Platform, SessionRecord, StorageNode } from '../../../packages/types/src/index.js';
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
  sessionTtlMs?: number;
  clock?: () => string;
}

const nodeStatuses = new Set<NodeStatus>(['REGISTERING', 'ONLINE', 'DEGRADED', 'PAUSED', 'OFFLINE', 'SUSPENDED', 'RETIRED']);
const platforms = new Set<Platform>(['windows', 'macos', 'linux', 'android', 'ios', 'nas', 'server']);
const ledgerTypes = new Set<LedgerEntry['type']>(['STORAGE_CONTRIBUTION', 'BANDWIDTH_CONTRIBUTION', 'STORAGE_USAGE', 'ADJUSTMENT']);
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const extensionTypes: Record<string, { mimeType: string; category: FileCategory }> = {
  '.jpg': { mimeType: 'image/jpeg', category: 'image' }, '.jpeg': { mimeType: 'image/jpeg', category: 'image' }, '.png': { mimeType: 'image/png', category: 'image' }, '.gif': { mimeType: 'image/gif', category: 'image' }, '.webp': { mimeType: 'image/webp', category: 'image' }, '.svg': { mimeType: 'image/svg+xml', category: 'image' }, '.heic': { mimeType: 'image/heic', category: 'image' }, '.avif': { mimeType: 'image/avif', category: 'image' },
  '.mp4': { mimeType: 'video/mp4', category: 'video' }, '.webm': { mimeType: 'video/webm', category: 'video' }, '.mov': { mimeType: 'video/quicktime', category: 'video' }, '.m4v': { mimeType: 'video/x-m4v', category: 'video' }, '.mkv': { mimeType: 'video/x-matroska', category: 'video' },
  '.mp3': { mimeType: 'audio/mpeg', category: 'audio' }, '.wav': { mimeType: 'audio/wav', category: 'audio' }, '.ogg': { mimeType: 'audio/ogg', category: 'audio' }, '.m4a': { mimeType: 'audio/mp4', category: 'audio' }, '.flac': { mimeType: 'audio/flac', category: 'audio' },
  '.pdf': { mimeType: 'application/pdf', category: 'document' }, '.doc': { mimeType: 'application/msword', category: 'document' }, '.docx': { mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', category: 'document' }, '.xls': { mimeType: 'application/vnd.ms-excel', category: 'document' }, '.xlsx': { mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', category: 'document' }, '.ppt': { mimeType: 'application/vnd.ms-powerpoint', category: 'document' }, '.pptx': { mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', category: 'document' },
  '.zip': { mimeType: 'application/zip', category: 'archive' }, '.tar': { mimeType: 'application/x-tar', category: 'archive' }, '.gz': { mimeType: 'application/gzip', category: 'archive' }, '.7z': { mimeType: 'application/x-7z-compressed', category: 'archive' }, '.rar': { mimeType: 'application/vnd.rar', category: 'archive' },
  '.txt': { mimeType: 'text/plain', category: 'text' }, '.md': { mimeType: 'text/markdown', category: 'text' }, '.csv': { mimeType: 'text/csv', category: 'text' }, '.json': { mimeType: 'application/json', category: 'text' }
};

export class PledgeDriveService {
  readonly nodes = new Map<string, StorageNode>();
  readonly files = new Map<string, FileRecord>();
  /** Encrypted bytes keyed by `${nodeId}:${chunkId}`. */
  readonly chunks = new Map<string, Buffer>();
  readonly ledger: LedgerEntry[] = [];
  readonly quotas = new Map<string, { quotaBytes: number; usedBytes: number }>();
  readonly accounts = new Map<string, AccountRecord>();
  readonly sessions = new Map<string, SessionRecord>();

  private readonly store?: JsonStateStore;
  private readonly masterKey: Buffer;
  private readonly maxUploadBytes: number;
  private readonly sessionTtlMs: number;
  private readonly clock: () => string;

  constructor(options: PledgeDriveServiceOptions = {}) {
    this.store = options.store;
    if (options.masterKey && options.masterKey.length !== 32) throw new Error('masterKey must be exactly 32 bytes');
    this.masterKey = options.masterKey ? Buffer.from(options.masterKey) : randomBytes(32);
    this.maxUploadBytes = options.maxUploadBytes ?? product.maxUploadBytes;
    this.sessionTtlMs = options.sessionTtlMs ?? 7 * 24 * 60 * 60 * 1000;
    this.clock = options.clock ?? (() => new Date().toISOString());
    const state = this.store?.load();
    if (state) this.hydrate(state);
  }

  ensureAccount(userId: string) {
    if (!userId || userId.length > 128) throw new DomainError('INVALID_USER', 'A valid user account is required');
    if (!this.quotas.has(userId)) this.quotas.set(userId, { quotaBytes: product.defaultQuotaBytes, usedBytes: 0 });
    return this.quotas.get(userId)!;
  }

  registerAccount(email: string, password: string): AccountRecord {
    return this.transact(() => {
      const normalizedEmail = this.normaliseEmail(email);
      if (typeof password !== 'string' || password.length < 10 || password.length > 256) throw new DomainError('WEAK_PASSWORD', 'Password must be between 10 and 256 characters');
      if ([...this.accounts.values()].some(account => account.email === normalizedEmail)) throw new DomainError('ACCOUNT_EXISTS', 'An account with that email already exists', 409);
      const salt = randomBytes(16);
      const account: AccountRecord = {
        id: randomUUID(),
        email: normalizedEmail,
        passwordSalt: salt.toString('base64'),
        passwordHash: scryptSync(password, salt, 64).toString('base64'),
        createdAt: this.clock()
      };
      this.accounts.set(account.id, account);
      this.ensureAccount(account.id);
      return account;
    });
  }

  authenticateAccount(email: string, password: string): AccountRecord {
    const normalizedEmail = this.normaliseEmail(email);
    const account = [...this.accounts.values()].find(candidate => candidate.email === normalizedEmail);
    if (!account || typeof password !== 'string') throw new DomainError('INVALID_CREDENTIALS', 'Email or password is incorrect', 401);
    try {
      const expected = Buffer.from(account.passwordHash, 'base64');
      const actual = scryptSync(password, Buffer.from(account.passwordSalt, 'base64'), expected.length);
      if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new Error('mismatch');
    } catch {
      throw new DomainError('INVALID_CREDENTIALS', 'Email or password is incorrect', 401);
    }
    return account;
  }

  createSession(userId: string): string {
    return this.transact(() => {
      if (!this.accounts.has(userId)) throw new DomainError('ACCOUNT_NOT_FOUND', 'Account not found', 404);
      const token = randomBytes(32).toString('base64url');
      const tokenHash = createHash('sha256').update(token).digest('hex');
      this.sessions.set(tokenHash, { tokenHash, userId, expiresAt: new Date(Date.now() + this.sessionTtlMs).toISOString() });
      return token;
    });
  }

  resolveSession(token: string | undefined): string | undefined {
    if (!token || token.length > 256) return undefined;
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const session = this.sessions.get(tokenHash);
    if (!session || Date.parse(session.expiresAt) <= Date.now()) return undefined;
    return this.accounts.has(session.userId) ? session.userId : undefined;
  }

  revokeSession(token: string | undefined): void {
    if (!token) return;
    this.transact(() => {
      const tokenHash = createHash('sha256').update(token).digest('hex');
      this.sessions.delete(tokenHash);
    });
  }

  accountView(userId: string): { id: string; email: string; createdAt: string } | undefined {
    const account = this.accounts.get(userId);
    return account ? { id: account.id, email: account.email, createdAt: account.createdAt } : undefined;
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

  upload(userId: string, name: string, data: Buffer, requestedMimeType = 'application/octet-stream') {
    return this.transact(() => {
      const quota = this.ensureAccount(userId);
      const filename = this.validFilename(name);
      const fileType = this.fileType(filename, requestedMimeType);
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
        mimeType: fileType.mimeType,
        category: fileType.category,
        createdAt: this.clock(),
        modifiedAt: this.clock(),
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

  fileFor(userId: string, fileId: string): FileRecord {
    const file = this.files.get(fileId);
    if (!file || file.userId !== userId) throw new DomainError('FILE_NOT_FOUND', 'File not found', 404);
    return file;
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
      mimeType: file.mimeType,
      category: file.category,
      createdAt: file.createdAt,
      modifiedAt: file.modifiedAt,
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
      version: 2,
      nodes: [...this.nodes.values()].map(node => ({ ...node })),
      files: [...this.files.values()].map(file => ({ ...file, chunks: file.chunks.map(chunk => ({ ...chunk, replicas: [...chunk.replicas] })) })),
      chunks: [...this.chunks.entries()].map(([key, data]) => ({ key, data: data.toString('base64') })),
      ledger: this.ledger.map(entry => ({ ...entry })),
      quotas: [...this.quotas.entries()].map(([userId, quota]) => ({ userId, ...quota })),
      accounts: [...this.accounts.values()].map(account => ({ ...account })),
      sessions: [...this.sessions.values()].map(session => ({ ...session }))
    };
  }

  private hydrate(state: PersistedState): void {
    this.nodes.clear();
    this.files.clear();
    this.chunks.clear();
    this.ledger.splice(0, this.ledger.length);
    this.quotas.clear();
    this.accounts.clear();
    this.sessions.clear();
    for (const node of state.nodes) this.nodes.set(node.id, { ...node });
    for (const rawFile of state.files) {
      const file = rawFile as FileRecord & { mimeType?: string; category?: FileCategory; modifiedAt?: string };
      const inferredType = this.fileType(file.name, file.mimeType || 'application/octet-stream');
      const encryption = file.encryption || { algorithm: 'AES-256-GCM' as const, wrappedKey: '', nonce: '', tag: '' };
      this.files.set(file.id, {
        ...file,
        mimeType: file.mimeType || inferredType.mimeType,
        category: file.category || inferredType.category,
        modifiedAt: file.modifiedAt || file.createdAt,
        encryption,
        chunks: file.chunks.map(chunk => ({ ...chunk, storageHash: chunk.storageHash || chunk.hash, nonce: chunk.nonce || '', tag: chunk.tag || '', replicas: [...chunk.replicas] }))
      });
    }
    for (const chunk of state.chunks) this.chunks.set(chunk.key, Buffer.from(chunk.data, 'base64'));
    this.ledger.push(...state.ledger.map(entry => ({ ...entry })));
    for (const quota of state.quotas) this.quotas.set(quota.userId, { quotaBytes: quota.quotaBytes, usedBytes: quota.usedBytes });
    for (const account of state.accounts || []) this.accounts.set(account.id, { ...account });
    for (const session of state.sessions || []) this.sessions.set(session.tokenHash, { ...session });
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

  private normaliseEmail(value: unknown): string {
    if (typeof value !== 'string') throw new DomainError('INVALID_EMAIL', 'Enter a valid email address');
    const email = value.trim().toLowerCase();
    if (email.length > 254 || !emailPattern.test(email)) throw new DomainError('INVALID_EMAIL', 'Enter a valid email address');
    return email;
  }

  private fileType(filename: string, requestedMimeType: string): { mimeType: string; category: FileCategory } {
    const extension = extname(filename).toLowerCase();
    const inferred = extensionTypes[extension];
    const candidate = typeof requestedMimeType === 'string' && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(requestedMimeType) ? requestedMimeType.toLowerCase() : '';
    if (!candidate || candidate === 'application/octet-stream') return inferred || { mimeType: 'application/octet-stream', category: 'other' };
    const category: FileCategory = candidate.startsWith('image/') ? 'image' : candidate.startsWith('video/') ? 'video' : candidate.startsWith('audio/') ? 'audio' : candidate.startsWith('text/') ? 'text' : candidate === 'application/pdf' || candidate.includes('word') || candidate.includes('excel') || candidate.includes('spreadsheet') || candidate.includes('presentation') ? 'document' : candidate.includes('zip') || candidate.includes('tar') || candidate.includes('gzip') || candidate.includes('compressed') || candidate.includes('rar') ? 'archive' : 'other';
    return { mimeType: candidate, category };
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
