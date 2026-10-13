import { z } from 'zod';
import { Exchange, Edge } from './structure-schema.ts';

export const StructureSource=z.object({message_id:z.uuid(),exchange_id:z.uuid(),sequence:z.number(),content:z.string(),sha256:z.string(),kind:z.enum(['user','answer','progress']),created_at:z.string()});
export const StructureCorpus=z.object({workspace_id:z.uuid(),conversation_id:z.uuid(),version:z.string(),child:Exchange,current:StructureSource,sources:z.array(StructureSource).max(256),exchanges:z.array(Exchange).max(64),edges:z.array(Edge).max(256)});
export type StructureCorpus=z.infer<typeof StructureCorpus>;
export type StructureSource=z.infer<typeof StructureSource>;
