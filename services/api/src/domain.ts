import { randomUUID } from 'node:crypto';
import { product } from '../../../packages/config/src/index.js';
import { sha256 } from '../../../packages/crypto/src/index.js';
import { choosePlacement } from '../../../packages/storage-orchestrator/src/index.js';
import type { FileRecord, LedgerEntry, StorageNode } from '../../../packages/types/src/index.js';

export class PledgeDriveService {
  readonly nodes = new Map<string, StorageNode>();
  readonly files = new Map<string, FileRecord>();
  readonly chunks = new Map<string, Buffer>();
  readonly ledger: LedgerEntry[] = [];
  readonly quotas = new Map<string, { quotaBytes:number; usedBytes:number }>();

  ensureAccount(userId:string) { if(!this.quotas.has(userId)) this.quotas.set(userId,{quotaBytes:product.defaultQuotaBytes,usedBytes:0}); return this.quotas.get(userId)!; }
  registerNode(input: Omit<StorageNode,'id'|'availableBytes'|'usedBytes'|'status'|'lastSeen'|'reliabilityScore'|'reliabilityClass'>) {
    if(input.pledgedBytes>input.capacityBytes) throw new Error('Pledged capacity cannot exceed physical capacity');
    const id=randomUUID(); const mobile=['android','ios'].includes(input.platform);
    const node:StorageNode={...input,id,availableBytes:input.pledgedBytes,usedBytes:0,status:'ONLINE',lastSeen:new Date().toISOString(),reliabilityScore:mobile?.75:.99,reliabilityClass:mobile?'C':'A'};
    this.nodes.set(id,node); return node;
  }
  upload(userId:string,name:string,data:Buffer) {
    const quota=this.ensureAccount(userId); if(quota.usedBytes+data.length>quota.quotaBytes) throw new Error('Storage quota exceeded');
    const chunks=[] as FileRecord['chunks'];
    for(let offset=0;offset<data.length;offset+=product.chunkSizeBytes) {
      const part=data.subarray(offset,offset+product.chunkSizeBytes); const id=randomUUID(); const hash=sha256(part); const placements=choosePlacement([...this.nodes.values()],part.length,product.replicationFactor);
      if(placements.length<product.replicationFactor) throw new Error('Insufficient healthy, diverse node capacity for replication policy');
      for(const node of placements){node.availableBytes-=part.length;node.usedBytes+=part.length;this.chunks.set(`${node.id}:${id}`,Buffer.from(part));}
      chunks.push({id,hash,bytes:part.length,replicas:placements.map(n=>n.id)});
    }
    const file:FileRecord={id:randomUUID(),userId,name,size:data.length,createdAt:new Date().toISOString(),chunks};this.files.set(file.id,file);quota.usedBytes+=data.length;return file;
  }
  download(userId:string,fileId:string) { const file=this.files.get(fileId); if(!file||file.userId!==userId) throw new Error('File not found'); return Buffer.concat(file.chunks.map(c=>{const replica=c.replicas.find(n=>this.nodes.get(n)?.status==='ONLINE');if(!replica)throw new Error('No online replica');const data=this.chunks.get(`${replica}:${c.id}`)!;if(sha256(data)!==c.hash)throw new Error('Replica integrity check failed');return data;})); }
  setNodeStatus(id:string,status:StorageNode['status']) { const node=this.nodes.get(id);if(!node)throw new Error('Node not found');node.status=status;node.lastSeen=new Date().toISOString();return node; }
  repair() { let repaired=0; for(const file of this.files.values())for(const chunk of file.chunks){const healthy=chunk.replicas.filter(id=>this.nodes.get(id)?.status==='ONLINE'&&this.chunks.has(`${id}:${chunk.id}`));if(healthy.length>=product.replicationFactor)continue;const source=this.chunks.get(`${healthy[0]}:${chunk.id}`);if(!source)continue;const candidates=choosePlacement([...this.nodes.values()].filter(n=>!chunk.replicas.includes(n.id)),chunk.bytes,product.replicationFactor-healthy.length);for(const n of candidates){this.chunks.set(`${n.id}:${chunk.id}`,Buffer.from(source));n.availableBytes-=chunk.bytes;n.usedBytes+=chunk.bytes;chunk.replicas.push(n.id);repaired++;}} return repaired; }
  credit(accountId:string,amount:number,type:LedgerEntry['type'],reference:string) { if(!Number.isFinite(amount)||amount===0) throw new Error('Invalid ledger amount'); const entry={id:randomUUID(),accountId,amount,type,reference,createdAt:new Date().toISOString()} satisfies LedgerEntry;this.ledger.push(entry);return entry; }
  balance(accountId:string){return this.ledger.filter(e=>e.accountId===accountId).reduce((n,e)=>n+e.amount,0);}
  dashboard(userId:string){const q=this.ensureAccount(userId);return {quota:q,nodes:[...this.nodes.values()].filter(n=>n.userId===userId),files:[...this.files.values()].filter(f=>f.userId===userId),credits:this.balance(userId),network:{nodes:this.nodes.size,pledgedBytes:[...this.nodes.values()].reduce((n,x)=>n+x.pledgedBytes,0),onlineBytes:[...this.nodes.values()].filter(n=>n.status==='ONLINE').reduce((n,x)=>n+x.availableBytes,0)}};}
}
