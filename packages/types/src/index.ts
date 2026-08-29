export type NodeStatus = 'REGISTERING'|'ONLINE'|'DEGRADED'|'PAUSED'|'OFFLINE'|'SUSPENDED'|'RETIRED';
export type Platform = 'windows'|'macos'|'linux'|'android'|'ios'|'nas'|'server';
export interface StorageNode { id:string; userId:string; deviceId:string; publicKey:string; region:string; platform:Platform; version:string; capacityBytes:number; pledgedBytes:number; availableBytes:number; usedBytes:number; bandwidthMbps:number; reliabilityScore:number; status:NodeStatus; lastSeen:string; reliabilityClass:'A'|'C'; }
export interface ChunkReplica { chunkId:string; nodeId:string; hash:string; bytes:number; verified:boolean; }
export interface LedgerEntry { id:string; accountId:string; amount:number; type:'STORAGE_CONTRIBUTION'|'BANDWIDTH_CONTRIBUTION'|'STORAGE_USAGE'|'ADJUSTMENT'; createdAt:string; reference:string; }
export interface FileRecord { id:string; userId:string; name:string; size:number; createdAt:string; chunks: {id:string; hash:string; bytes:number; replicas:string[]}[]; }
