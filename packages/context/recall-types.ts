import { z } from 'zod';
export const CONTEXT_EMBEDDING_MODEL = '@cf/baai/bge-m3';
export const ContextVector = z.array(z.number().finite()).length(1024);
export const SearchDocument = z.object({
  id:z.string().length(64), context_id:z.uuid(), kind:z.enum(['source','note']), reference_id:z.uuid(),
  source_sequence:z.coerce.number().int(), input_hash:z.string(), start_offset:z.number().int(), end_offset:z.number().int(),
  vector:ContextVector,
});
export type ContextEmbed = (texts: readonly string[], signal: AbortSignal) => Promise<unknown>;
export type SearchScope = Readonly<{workspace:string;conversation:string}>;
export type SearchVector = Readonly<{id:string;values:number[];namespace:string;metadata:Readonly<{sequence:number}>}>;
export interface ContextVectorIndex {
  upsert(vectors: SearchVector[]): Promise<unknown>;
  deleteByIds(ids:string[]): Promise<unknown>;
  query(vector:number[], options:{namespace:string;topK:number;filter:{sequence:{$lte:number}};returnValues:false;returnMetadata:'none'}): Promise<unknown>;
}
export class ContextRecallError extends Error {
  constructor(readonly code:'invalid_embeddings'|'index_pending') {super(code);this.name='ContextRecallError';}
}
export async function encodeContext(embed:ContextEmbed,texts:readonly string[]) {
  const parsed=z.object({data:z.array(ContextVector)}).safeParse(await embed(texts,AbortSignal.timeout(10000)));
  if(!parsed.success||parsed.data.data.length!==texts.length)throw new ContextRecallError('invalid_embeddings');
  return parsed.data.data;
}
export function contextCosine(left:readonly number[],right:readonly number[]):number {
  if(left.length!==right.length||left.length===0)throw new ContextRecallError('invalid_embeddings');
  const leftNorm=Math.sqrt(left.reduce((sum,value)=>sum+value*value,0));
  const rightNorm=Math.sqrt(right.reduce((sum,value)=>sum+value*value,0));
  if(!leftNorm||!rightNorm)throw new ContextRecallError('invalid_embeddings');
  return left.reduce((sum,value,index)=>sum+value*(right[index]??0),0)/(leftNorm*rightNorm);
}
