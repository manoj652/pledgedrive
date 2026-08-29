export type NodeStatus = 'REGISTERING'|'ONLINE'|'DEGRADED'|'PAUSED'|'OFFLINE'|'SUSPENDED'|'RETIRED';
export type Platform = 'windows'|'macos'|'linux'|'android'|'ios'|'nas'|'server';
export type FileCategory = 'image'|'video'|'audio'|'document'|'archive'|'text'|'other';
export interface StorageNode { id:string; userId:string; deviceId:string; publicKey:string; region:string; platform:Platform; version:string; capacityBytes:number; pledgedBytes:number; availableBytes:number; usedBytes:number; bandwidthMbps:number; reliabilityScore:number; status:NodeStatus; lastSeen:string; reliabilityClass:'A'|'C'; }
export interface ChunkReplica { chunkId:string; nodeId:string; hash:string; bytes:number; verified:boolean; }
export interface LedgerEntry { id:string; accountId:string; amount:number; type:'STORAGE_CONTRIBUTION'|'BANDWIDTH_CONTRIBUTION'|'STORAGE_USAGE'|'ADJUSTMENT'; createdAt:string; reference:string; }
export interface EncryptedEnvelope { algorithm:'AES-256-GCM'; wrappedKey:string; nonce:string; tag:string; }
export interface FileChunk { id:string; hash:string; storageHash:string; bytes:number; replicas:string[]; nonce:string; tag:string; }
export interface FileRecord { id:string; userId:string; name:string; size:number; mimeType:string; category:FileCategory; createdAt:string; modifiedAt:string; encryption:EncryptedEnvelope; chunks:FileChunk[]; }
export interface AccountRecord { id:string; email:string; passwordSalt:string; passwordHash:string; createdAt:string; }
export interface SessionRecord { tokenHash:string; userId:string; expiresAt:string; }
