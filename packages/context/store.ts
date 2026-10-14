import { z } from "zod";
import type { Principal } from "../../services/control/auth";
import type { Query } from "../../services/control/db";
import { DomainError } from "../protocol";
import { pendingRetention } from "./store-retention";
import { type SourceWindow, PrepareRequest, PrepareResult } from "./schema";
import { contextSnapshot, linked, ownedScope, rawSource, sourceList, sourceView } from "./store-read";
import { messageReply } from './store-reply';
export { retainedContextSources } from "./store-read";
export { retainedContextNotes } from "./store-notes-read";
export { assessSemanticRetention } from "./store-retention";
export { linkContext, writeContextNotes, linkAssistantContext } from "./store-write";

export async function prepareSemanticContext(sql: Query, principal: Principal, run: string, input: z.input<typeof PrepareRequest>) {
  const request=PrepareRequest.parse(input),owned=await ownedScope(sql,principal,run,false,request.mode);
  const scope={workspace:principal.workspace_id,conversation:owned.conversation_id};
  const raw=await rawSource(sql,scope,request.message_id);
  if(request.mode==='live' && (raw.task_id!==owned.task_id || raw.role!=='user')) throw new DomainError('invalid_source','Live preparation requires this run task user input',409);
  const [current,reply]=await Promise.all([linked(sql,scope,raw.message_id),messageReply(sql,scope,raw.message_id)]);
  if(reply&&!current)return PrepareResult.parse({source:await sourceView(sql,scope,raw,8000),reply,retention_context:await pendingRetention(sql,scope,raw),neighbors:[],candidates:reply.context?[reply.context]:[],linked:null,history:{messages:[],has_more:false,next_after_sequence:null},...(reply.context?{decision:{context_id:reply.context.context_id,outcome:'existing',scores:[],model:'explicit-reply'}}:{})});
  const terms=[...new Set((raw.content+' '+raw.attachments.map(file=>file.name).join(' ')).toLowerCase().match(/[\p{L}\p{N}_-]{3,}/gu)??[])].filter(term=>!['the','and','with','this','that','please','context','continue','about','what','from','have','would','could','should'].includes(term)).slice(0,24);
  const [lexical,recentRows,neighborRows,historyRows,source,retention]=await Promise.all([sql`SELECT c.id,(SELECT count(*) FROM unnest(${sql.array(terms)}::text[]) word WHERE position(word IN lower(c.title||' '||c.scope||' '||COALESCE((SELECT string_agg(n.text,' ') FROM assistant.semantic_context_notes n WHERE n.workspace_id=c.workspace_id AND n.context_id=c.id AND n.superseded_by IS NULL AND n.source_sequence<=${raw.sequence}),'')))>0) AS matches FROM assistant.semantic_contexts c WHERE c.workspace_id=${scope.workspace} AND EXISTS(SELECT 1 FROM assistant.semantic_context_links l WHERE l.workspace_id=c.workspace_id AND l.context_id=c.id AND l.source_sequence<=${raw.sequence}) AND EXISTS(SELECT 1 FROM assistant.messages m WHERE m.id=c.initiating_message_id AND m.sequence<=${raw.sequence}) ORDER BY matches DESC,c.source_sequence DESC,c.id LIMIT 12`,
    sql`SELECT id FROM assistant.semantic_contexts c WHERE workspace_id=${scope.workspace} AND EXISTS(SELECT 1 FROM assistant.semantic_context_links l WHERE l.workspace_id=c.workspace_id AND l.context_id=c.id AND l.source_sequence<=${raw.sequence}) AND initiating_message_id IN (SELECT id FROM assistant.messages WHERE workspace_id=${scope.workspace} AND sequence<=${raw.sequence}) ORDER BY source_sequence DESC,id LIMIT 8`,
    sql`SELECT id FROM assistant.messages WHERE workspace_id=${scope.workspace} AND conversation_id=${scope.conversation} AND sequence<${raw.sequence} ORDER BY sequence DESC LIMIT 8`,
    request.history_after_sequence===undefined?Promise.resolve([]):sql`SELECT id FROM assistant.messages WHERE workspace_id=${scope.workspace} AND conversation_id=${scope.conversation} AND sequence>${request.history_after_sequence} AND sequence<=${raw.sequence} ORDER BY sequence LIMIT 33`,
    sourceView(sql,scope,raw,8000),
    pendingRetention(sql,scope,raw),
  ]);
  const matches=z.array(z.object({id:z.uuid(),matches:z.coerce.number()})).parse(lexical).filter(item=>item.matches>0);
  const recent=z.array(z.object({id:z.uuid()})).parse(recentRows);
  const ids=[...new Set([...(current?[current.context_id]:[]),...matches.map(item=>item.id),...recent.map(item=>item.id)])];
  const neighbors=z.array(z.object({id:z.uuid()})).parse(neighborRows);
  const history=z.array(z.object({id:z.uuid()})).parse(historyRows);
  const [page,neighborSources,candidates]=await Promise.all([sourceList(sql,scope,history.slice(0,32).map(row=>row.id)),sourceList(sql,scope,neighbors.map(row=>row.id)),Promise.all(ids.map(id=>contextSnapshot(sql,scope,id,raw.sequence)))]);
  return PrepareResult.parse({source,retention_context:retention,neighbors:neighborSources.reverse(),candidates,linked:current,history:{messages:page,has_more:history.length>32,next_after_sequence:history.length>32?(page.at(-1)?.sequence??null):null}});
}
export async function snapshotSemanticContext(sql: Query, principal: Principal, run: string, contextId: string, mode: "live" | "backfill" = "live", noteIds:readonly string[] = [], sourceIds:readonly string[] = [], windows:readonly z.infer<typeof SourceWindow>[] = []) {
  const owned=await ownedScope(sql,principal,run,false,mode);
  return {context:await contextSnapshot(sql,{workspace:principal.workspace_id,conversation:owned.conversation_id},contextId,Number.MAX_SAFE_INTEGER,noteIds,sourceIds,windows)};
}
