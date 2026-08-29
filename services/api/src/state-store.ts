import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AccountRecord, FileRecord, LedgerEntry, SessionRecord, StorageNode } from '../../../packages/types/src/index.js';

export interface PersistedState {
  version: 1 | 2;
  nodes: StorageNode[];
  files: FileRecord[];
  chunks: Array<{ key: string; data: string }>;
  ledger: LedgerEntry[];
  quotas: Array<{ userId: string; quotaBytes: number; usedBytes: number }>;
  accounts?: AccountRecord[];
  sessions?: SessionRecord[];
}

/**
 * Small, atomic local store for the development/single-process deployment.
 * The domain is deliberately written against a store interface so this can be
 * replaced by the PostgreSQL repository without changing API behavior.
 */
export class JsonStateStore {
  constructor(readonly filePath: string) {}

  load(): PersistedState | undefined {
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as PersistedState;
      if ((parsed?.version !== 1 && parsed?.version !== 2) || !Array.isArray(parsed.nodes) || !Array.isArray(parsed.files) || !Array.isArray(parsed.chunks) || !Array.isArray(parsed.ledger) || !Array.isArray(parsed.quotas)) {
        throw new Error('Unsupported persisted state format');
      }
      return { ...parsed, version: 2, accounts: Array.isArray(parsed.accounts) ? parsed.accounts : [], sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [] };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw new Error(`Unable to load persisted state: ${error instanceof Error ? error.message : 'invalid state'}`);
    }
  }

  save(state: PersistedState): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify(state)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(temporaryPath, this.filePath);
  }
}
