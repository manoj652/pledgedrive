import type { StorageNode } from '../../types/src/index.js';

export function choosePlacement(nodes: StorageNode[], bytes:number, replicas=3): StorageNode[] {
  const eligible=nodes.filter(n=>n.status==='ONLINE' && n.availableBytes>=bytes && n.reliabilityScore>=0.7)
    .sort((a,b)=> score(b)-score(a) || a.id.localeCompare(b.id));
  const picked:StorageNode[]=[]; const owners=new Set<string>();
  for (const node of eligible) { if (!owners.has(node.userId) || eligible.filter(n=>!owners.has(n.userId)).length===0) { picked.push(node); owners.add(node.userId); if(picked.length===replicas) break; } }
  return picked;
}
function score(n:StorageNode) { return n.reliabilityScore * 1000 + Math.min(n.availableBytes / 1024 ** 3, 100) + (n.reliabilityClass==='A'?25:0); }
