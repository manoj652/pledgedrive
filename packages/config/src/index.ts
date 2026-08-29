import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

export const product = {
  name: 'PledgeDrive',
  tagline: "Your cloud. Powered by everyone's spare storage.",
  defaultQuotaBytes: 5 * 1024 ** 3,
  replicationFactor: 3,
  chunkSizeBytes: 4 * 1024 * 1024,
  maxUploadBytes: 100 * 1024 * 1024,
  minNodeVersion: '0.1.0',
  creditRates: { utilizedGbMonth: 1, servedGb: 0.05 },
  storagePolicy: { mobileReliabilityClass: 'C', desktopReliabilityClass: 'A', reductionGraceHours: 72 }
} as const;

export interface AppConfig {
  environment: 'development' | 'test' | 'production';
  port: number;
  host: string;
  userId: string;
  dataDir: string;
  stateFile: string;
  webRoot: string;
  maxUploadBytes: number;
  apiToken?: string;
  allowedOrigin?: string;
  masterKey: Buffer;
  exposeErrors: boolean;
}

const developmentMasterKey = createHash('sha256').update('pledgedrive-local-development-key').digest();

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function masterKeyFrom(value: string | undefined, environment: AppConfig['environment']): Buffer {
  if (!value) {
    if (environment === 'production') throw new Error('PLEDGEDRIVE_MASTER_KEY is required in production');
    return developmentMasterKey;
  }
  const trimmed = value.trim();
  const key = /^[0-9a-f]{64}$/i.test(trimmed) ? Buffer.from(trimmed, 'hex') : Buffer.from(trimmed, 'base64');
  if (key.length !== 32) throw new Error('PLEDGEDRIVE_MASTER_KEY must decode to exactly 32 bytes');
  return key;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const requestedEnvironment = env.NODE_ENV || 'development';
  if (!['development', 'test', 'production'].includes(requestedEnvironment)) throw new Error('NODE_ENV must be development, test, or production');
  const environment = requestedEnvironment as AppConfig['environment'];
  const dataDir = resolve(env.PLEDGEDRIVE_DATA_DIR || './data');
  const stateFile = resolve(env.PLEDGEDRIVE_STATE_FILE || `${dataDir}/state.json`);
  const webRoot = resolve(env.PLEDGEDRIVE_WEB_ROOT || './dist/apps/web/public');
  const apiToken = env.PLEDGEDRIVE_API_TOKEN?.trim() || undefined;
  if (environment === 'production' && (!apiToken || apiToken.length < 32)) throw new Error('PLEDGEDRIVE_API_TOKEN must be at least 32 characters in production');
  const allowedOrigin = env.PLEDGEDRIVE_ALLOWED_ORIGIN?.trim() || undefined;
  if (allowedOrigin && allowedOrigin === '*') throw new Error('Wildcard CORS origins are not allowed');
  return {
    environment,
    port: positiveInteger(env.PLEDGEDRIVE_PORT, 8787, 'PLEDGEDRIVE_PORT'),
    host: env.PLEDGEDRIVE_HOST || (environment === 'production' ? '127.0.0.1' : '::'),
    userId: env.PLEDGEDRIVE_USER_ID || 'demo-user',
    dataDir,
    stateFile,
    webRoot,
    maxUploadBytes: positiveInteger(env.PLEDGEDRIVE_MAX_UPLOAD_BYTES, product.maxUploadBytes, 'PLEDGEDRIVE_MAX_UPLOAD_BYTES'),
    apiToken,
    allowedOrigin,
    masterKey: masterKeyFrom(env.PLEDGEDRIVE_MASTER_KEY, environment),
    exposeErrors: environment !== 'production'
  };
}
