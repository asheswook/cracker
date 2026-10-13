import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../auth";
import type { Database } from "../db";
import { ExchangeRequest, MemberRequest, EdgeRequest, UndoEdgeRequest, StructureReadRequest } from "../../../packages/context/structure-schema";
import { ensureExchange, attributeMember, writeEdge, undoEdge, readStructure } from "../../../packages/context/structure-store";
import { readStructureCorpus } from '../../../packages/context/structure-corpus-store';
import { createClaims, readClaims, readClaimMetadata, transitionClaim } from '../../../packages/context/claims-store';
import { ClaimsRequest, ClaimsReadRequest } from '../../../packages/context/claims-schema';

export function semanticStructureRoutes(sql:Database) {
 const app=new Hono<AppEnv>();
 app.post('/context/:run/claims',async c=>c.json(await createClaims(sql,c.get('principal'),z.uuid().parse(c.req.param('run')),ClaimsRequest.parse(await c.req.json()))));
 app.post('/context/:run/claims/transition',async c=>c.json(await transitionClaim(sql,c.get('principal'),z.uuid().parse(c.req.param('run')),ClaimsRequest.parse(await c.req.json()))));
 app.post('/context/:run/claims/read',async c=>{const request=ClaimsReadRequest.parse(await c.req.json()),run=z.uuid().parse(c.req.param('run'));return c.json(request.metadata_only?await readClaimMetadata(sql,c.get('principal'),run,request.message_id):await readClaims(sql,c.get('principal'),run,request));});
 app.post('/context/:run/structure/corpus',async c=>c.json(await readStructureCorpus(sql,c.get('principal'),z.uuid().parse(c.req.param('run')),ExchangeRequest.parse(await c.req.json()).user_message_id)));
 app.post('/context/:run/structure/backfill/exchange',async c=>c.json(await ensureExchange(sql,{principal:c.get('principal'),run:z.uuid().parse(c.req.param('run')),backfill:true},ExchangeRequest.parse(await c.req.json()).user_message_id)));
 app.post('/context/:run/structure/backfill/member',async c=>c.json(await attributeMember(sql,{principal:c.get('principal'),run:z.uuid().parse(c.req.param('run')),backfill:true},MemberRequest.parse(await c.req.json()))));
 app.post('/context/:run/structure/backfill/edge',async c=>c.json(await writeEdge(sql,{principal:c.get('principal'),run:z.uuid().parse(c.req.param('run')),backfill:true},EdgeRequest.parse(await c.req.json()))));
 app.post('/context/:run/structure/exchange',async c=>c.json(await ensureExchange(sql,{principal:c.get('principal'),run:z.uuid().parse(c.req.param('run'))},ExchangeRequest.parse(await c.req.json()).user_message_id)));
 app.post('/context/:run/structure/member',async c=>c.json(await attributeMember(sql,{principal:c.get('principal'),run:z.uuid().parse(c.req.param('run'))},MemberRequest.parse(await c.req.json()))));
 app.post('/context/:run/structure/edge',async c=>c.json(await writeEdge(sql,{principal:c.get('principal'),run:z.uuid().parse(c.req.param('run'))},EdgeRequest.parse(await c.req.json()))));
 app.post('/context/:run/structure/edge/undo',async c=>c.json(await undoEdge(sql,{principal:c.get('principal'),run:z.uuid().parse(c.req.param('run'))},UndoEdgeRequest.parse(await c.req.json()))));
 app.post('/context/:run/structure/read',async c=>c.json(await readStructure(sql,{principal:c.get('principal'),run:z.uuid().parse(c.req.param('run'))},StructureReadRequest.parse(await c.req.json()))));
 return app;
}
