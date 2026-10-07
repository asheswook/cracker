import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../auth";
import type { Database } from "../db";
import { LinkRequest, NotesRequest, PrepareRequest, PrepareResult, SemanticDecision, type SemanticClassifier, type SemanticRetriever, SemanticSnapshotRequest, SemanticRetentionRequest, SemanticRetrievedContext } from "../../../packages/context/schema";
import { assessSemanticRetention, linkContext, prepareSemanticContext, snapshotSemanticContext, writeContextNotes } from "../../../packages/context/store";
import { contextSnapshot, ownedScope } from "../../../packages/context/store-read";
import { ReorganizeRequest, UndoReorganizationRequest } from "../../../packages/context/reorganize-schema";
import { reorganizeContexts, undoContextReorganization, contextProposals } from "../../../packages/context/store-reorganize";
import { DomainError } from "../../../packages/protocol";

export function semanticContextRoutes(sql:Database,options:Readonly<{classify?:SemanticClassifier;retrieve?:SemanticRetriever}>={}) {
  const app=new Hono<AppEnv>();
  app.post('/context/:run/semantic/prepare',async c=>{
    const request=PrepareRequest.parse(await c.req.json());
    let prepared=await prepareSemanticContext(sql,c.get('principal'),z.uuid().parse(c.req.param('run')),request);
    if(prepared.retention_context.sources.length||!prepared.source.retention_allowed||prepared.linked||prepared.reply)return c.json(prepared);
    if(options.retrieve) {
      const owned=await ownedScope(sql,c.get('principal'),z.uuid().parse(c.req.param('run')),false,request.mode);
      const scope={workspace:c.get('principal').workspace_id,conversation:owned.conversation_id};
      let recalled:Awaited<ReturnType<SemanticRetriever>>;
      try { recalled=await options.retrieve(prepared,scope); }
      catch(error) {
        if(!(error instanceof Error))throw error;
        return c.json(PrepareResult.parse({...prepared,decision:{context_id:null,outcome:'uncertain',scores:[],model:'retrieval-unavailable'}}));
      }
      const retrieved=z.array(SemanticRetrievedContext).max(12).parse(recalled);
      const ids=[...new Set([...retrieved.map(item=>item.context_id),...prepared.candidates.map(item=>item.context_id)])].slice(0,24);
      prepared=PrepareResult.parse({...prepared,candidates:await Promise.all(ids.map(id=>contextSnapshot(sql,scope,id,prepared.source.sequence,retrieved.find(item=>item.context_id===id)?.note_ids??[],retrieved.find(item=>item.context_id===id)?.source_ids??[],retrieved.find(item=>item.context_id===id)?.source_windows??[])))});
    }
    if(!options.classify)return c.json(prepared);
    let classified:Awaited<ReturnType<SemanticClassifier>>;
    try { classified=await options.classify(prepared); }
    catch(error) {
      if(!(error instanceof Error))throw error;
      return c.json(PrepareResult.parse({...prepared,decision:{context_id:null,outcome:'uncertain',scores:[],model:'classifier-unavailable'}}));
    }
    const decision=SemanticDecision.parse(classified);
    if(decision.outcome==='existing'&&(!decision.context_id||!prepared.candidates.some(item=>item.context_id===decision.context_id)))throw new DomainError('invalid_context_decision','Classifier selected an unavailable context',503);
    return c.json(PrepareResult.parse({...prepared,decision}));
  });
  app.post('/context/:run/semantic/reorganize',async c=>c.json(await reorganizeContexts(sql,{principal:c.get('principal'),run:z.uuid().parse(c.req.param('run'))},ReorganizeRequest.parse(await c.req.json()))));
  app.post('/context/:run/semantic/undo',async c=>c.json(await undoContextReorganization(sql,{principal:c.get('principal'),run:z.uuid().parse(c.req.param('run'))},UndoReorganizationRequest.parse(await c.req.json()))));
  app.post('/context/:run/semantic/retention',async c=>c.json(await assessSemanticRetention(sql,c.get('principal'),z.uuid().parse(c.req.param('run')),SemanticRetentionRequest.parse(await c.req.json()))));
  app.post('/context/:run/semantic/link',async c=>c.json(await linkContext(sql,c.get('principal'),z.uuid().parse(c.req.param('run')),LinkRequest.parse(await c.req.json()))));
  app.post('/context/:run/semantic/notes',async c=>c.json(await writeContextNotes(sql,c.get('principal'),z.uuid().parse(c.req.param('run')),NotesRequest.parse(await c.req.json()))));
  app.post('/context/:run/semantic/snapshot',async c=>{
    const body=SemanticSnapshotRequest.parse(await c.req.json());
    return c.json(await snapshotSemanticContext(sql,c.get('principal'),z.uuid().parse(c.req.param('run')),body.context_id,body.mode,body.note_ids,body.source_ids,body.source_windows));
  });
  return app;
}

export function semanticContextClientRoutes(sql:Database) {
 const app=new Hono<AppEnv>();
 app.use('/contexts/*',async(c,next)=>{if(c.get('principal').role!=='client')throw new DomainError('forbidden','Client authentication required',403);await next()});
 app.post('/contexts/reorganize',async c=>c.json(await reorganizeContexts(sql,{principal:c.get('principal')},ReorganizeRequest.parse(await c.req.json()))));
 app.post('/contexts/undo',async c=>c.json(await undoContextReorganization(sql,{principal:c.get('principal')},UndoReorganizationRequest.parse(await c.req.json()))));
 app.get('/contexts/proposals',async c=>c.json(await contextProposals(sql,c.get('principal'),z.object({conversation_id:z.uuid(),after_id:z.uuid().optional()}).strict().parse(c.req.query()))));
 return app;
}
