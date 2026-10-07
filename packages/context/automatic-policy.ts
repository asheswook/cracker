import type { z } from 'zod';
import type { ReorganizeRequest } from './reorganize-schema';
import type { SemanticLink } from './schema';
import type { BatchedSource } from './source-batch';

export function automaticCorrectionAllowed(request:z.infer<typeof ReorganizeRequest>,links:readonly z.infer<typeof SemanticLink>[],evidence:ReadonlyMap<string,BatchedSource>) {
 const review=request.automatic_review;
 if(!review||review.confidence<0.98||review.margin<0.2||links.length>8||links.some(link=>link.status!=='provisional'))return false;
 const targets=new Set(request.moves.flatMap(move=>move.to.kind==='existing'?[move.to.context_id]:[]));
 if(targets.size!==1||request.moves.some(move=>move.to.kind!=='existing'))return false;
 if(links.some(link=>!review.evidence.some(item=>item.message_id===link.message_id)))return false;
 return review.evidence.some(item=>{const record=evidence.get(item.message_id);return record?.link&&targets.has(record.link.context_id)&&!links.some(link=>link.message_id===item.message_id)});
}
