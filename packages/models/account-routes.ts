import { Hono } from "hono";
import { z } from "zod";
import type { Database, Query } from "../../services/control/db";
import type { AppEnv } from "../../services/control/auth";
import { DomainError } from "../protocol";
import { ownModelVm } from "./repository";
import { AccountStatus, AccountRequest, AccountObservation, ClaimedAccountRequest, LocalCallback } from "./account-schema";
import { seal, unseal } from "../extensions/secrets";

async function status(sql: Query, workspace: string, vm: string) {
  await sql`UPDATE assistant.chatgpt_accounts SET request_status='failed',state=CASE WHEN state='connecting' THEN 'requires_login' ELSE state END,error_code='login_interrupted',authorization_url=NULL,callback_cipher=NULL,updated_at=now() WHERE workspace_id=${workspace} AND vm_id=${vm} AND request_status IN ('pending','running') AND lease_until<=now()`;
  const row=(await sql`SELECT state,request_id,action,request_status,error_code,updated_at,login_location FROM assistant.chatgpt_accounts WHERE workspace_id=${workspace} AND vm_id=${vm}`)[0];
  return AccountStatus.parse(row??{state:"unknown",request_id:null,action:null,request_status:null,error_code:null,updated_at:null});
}
const LocalRequest = z.object({ vm_id: z.uuid(), request_id: z.uuid() }).strict();
async function localRequest(sql: Query, workspace: string, vm: string, request: string) {
  await ownModelVm(sql,{workspace,vm});
  const row=(await sql`SELECT redirect_uri,authorization_url,callback_cipher FROM assistant.chatgpt_accounts WHERE workspace_id=${workspace} AND vm_id=${vm} AND request_id=${request} AND action='connect' AND login_location='local' AND request_status IN ('pending','running') AND lease_until>now()`)[0];
  if(!row)throw new DomainError("stale_configuration","로그인 요청이 만료되었어요. 다시 시작해 주세요.",409);
  return z.object({redirect_uri:z.string(),authorization_url:z.string().nullable(),callback_cipher:z.string().nullable()}).parse(row);
}
export function accountClientRoutes(sql: Database, encryptionKey?: string) {
  const app=new Hono<AppEnv>();
  app.use("*",async(c,next)=>{c.header("Cache-Control","no-store");await next();});
  app.get("/",async c=>{const workspace=c.get("principal").workspace_id,vm=z.uuid().parse(c.req.query("vm_id"));return c.json(await sql.begin(async tx=>{await ownModelVm(tx,{workspace,vm});return status(tx,workspace,vm);}));});
  app.post("/",async c=>{
    const input=AccountRequest.parse(await c.req.json()),workspace=c.get("principal").workspace_id;
    return c.json(await sql.begin(async tx=>{
      await ownModelVm(tx,{workspace,vm:input.vm_id});
      const previous=await status(tx,workspace,input.vm_id);
      if(previous.request_id===input.request_id){
        const stored=(await tx`SELECT redirect_uri FROM assistant.chatgpt_accounts WHERE vm_id=${input.vm_id}`)[0];
        if(previous.action!==input.action||previous.login_location!==input.login_location||stored?.["redirect_uri"]!==(input.redirect_uri??null))throw new DomainError("idempotency_conflict","Account action differs",409);return previous;
      }
      if(input.login_location==="local"&&!encryptionKey)throw new DomainError("secret_storage_unavailable","로컬 로그인 연결이 준비되지 않았어요.",503);
      const active=await tx`SELECT id FROM assistant.runs WHERE workspace_id=${workspace} AND vm_id=${input.vm_id} AND state NOT IN ('unknown','cancelled','failed','succeeded') LIMIT 1`;
      if(active.length)throw new DomainError("run_busy","작업이 끝난 뒤 계정 연결을 변경해 주세요.",409);
      const pending=await tx`SELECT vm_id FROM assistant.chatgpt_accounts WHERE vm_id=${input.vm_id} AND request_status IN ('pending','running') AND lease_until>now()`;
      if(pending.length)throw new DomainError("command_pending","계정 연결 변경을 진행 중이에요.",409);
      await tx`INSERT INTO assistant.chatgpt_accounts(vm_id,workspace_id,request_id,action,request_status,lease_until,login_location,redirect_uri) VALUES(${input.vm_id},${workspace},${input.request_id},${input.action},'pending',now()+interval '7 minutes',${input.login_location},${input.redirect_uri??null}) ON CONFLICT(vm_id) DO UPDATE SET request_id=excluded.request_id,action=excluded.action,request_status='pending',error_code=NULL,lease_until=excluded.lease_until,login_location=excluded.login_location,redirect_uri=excluded.redirect_uri,authorization_url=NULL,callback_cipher=NULL,updated_at=now()`;
      return status(tx,workspace,input.vm_id);
    }));
  });
  app.get("/authorization",async c=>{
    const input=LocalRequest.parse({vm_id:c.req.query("vm_id"),request_id:c.req.query("request_id")}),workspace=c.get("principal").workspace_id;
    return c.json(await sql.begin(async tx=>{const row=await localRequest(tx,workspace,input.vm_id,input.request_id);return {authorization_url:row.authorization_url};}));
  });
  app.post("/callback",async c=>{
    const input=LocalRequest.extend({callback:LocalCallback}).parse(await c.req.json()),workspace=c.get("principal").workspace_id;
    await sql.begin(async tx=>{
      const row=await localRequest(tx,workspace,input.vm_id,input.request_id);
      if(!row.authorization_url||new URL(row.authorization_url).searchParams.get("state")!==input.callback.state)throw new DomainError("invalid_request","Login callback does not match",400);
      const payload=JSON.stringify(input.callback);
      if(row.callback_cipher){if((await unseal(row.callback_cipher,encryptionKey))["callback"]!==payload)throw new DomainError("idempotency_conflict","Login callback differs",409);return;}
      const cipher=await seal({callback:payload},encryptionKey);
      await tx`UPDATE assistant.chatgpt_accounts SET callback_cipher=${cipher},updated_at=now() WHERE vm_id=${input.vm_id} AND request_id=${input.request_id}`;
    });return c.json({accepted:true});
  });
  app.post("/cancel-local",async c=>{
    const input=LocalRequest.parse(await c.req.json()),workspace=c.get("principal").workspace_id;
    await sql.begin(async tx=>{await ownModelVm(tx,{workspace,vm:input.vm_id});await tx`UPDATE assistant.chatgpt_accounts SET request_status='failed',state=CASE WHEN state='connecting' THEN 'requires_login' ELSE state END,error_code='login_interrupted',authorization_url=NULL,callback_cipher=NULL,lease_until=NULL,updated_at=now() WHERE workspace_id=${workspace} AND vm_id=${input.vm_id} AND request_id=${input.request_id} AND login_location='local' AND request_status IN ('pending','running')`;});return c.json({accepted:true});
  });return app;
}
export function accountDaemonRoutes(sql: Database, encryptionKey?: string) {
  const app=new Hono<AppEnv>();
  app.post("/claim",async c=>{
    const p=c.get("principal"),vm=z.uuid().parse(p.vm_id);
    return c.json(await sql.begin(async tx=>{
      await ownModelVm(tx,{workspace:p.workspace_id,vm});
      await tx`UPDATE assistant.chatgpt_accounts SET request_status='failed',state=CASE WHEN state='connecting' THEN 'requires_login' ELSE state END,error_code='login_interrupted',authorization_url=NULL,callback_cipher=NULL,updated_at=now() WHERE vm_id=${vm} AND request_status IN ('pending','running') AND lease_until<=now()`;
      if((await tx`SELECT id FROM assistant.runs WHERE workspace_id=${p.workspace_id} AND vm_id=${vm} AND state NOT IN ('unknown','cancelled','failed','succeeded') LIMIT 1`).length)return {request:null};
      const rows=await tx`UPDATE assistant.chatgpt_accounts SET request_status='running',state=CASE WHEN action='connect' THEN 'connecting' ELSE state END,updated_at=now() WHERE vm_id=${vm} AND workspace_id=${p.workspace_id} AND request_status='pending' AND lease_until>now() RETURNING request_id,action,login_location,redirect_uri`;
      return {request:rows[0]?ClaimedAccountRequest.parse(rows[0]):null};
    }));
  });
  app.post("/observed",async c=>{
    const p=c.get("principal"),input=AccountObservation.parse(await c.req.json()),vm=z.uuid().parse(p.vm_id);
    await sql.begin(async tx=>{
      await ownModelVm(tx,{workspace:p.workspace_id,vm});
      if(input.request_id){
        const rows=await tx`UPDATE assistant.chatgpt_accounts SET state=${input.state},request_status=${input.error_code&&input.error_code!=="revocation_unconfirmed"?"failed":"completed"},error_code=${input.error_code},lease_until=NULL,authorization_url=NULL,callback_cipher=NULL,updated_at=now() WHERE vm_id=${vm} AND workspace_id=${p.workspace_id} AND request_id=${input.request_id} AND request_status IN ('running','completed','failed') RETURNING vm_id`;
        if(!rows.length)throw new DomainError("stale_configuration","Account request changed",409);
      }else{
        await tx`INSERT INTO assistant.chatgpt_accounts(vm_id,workspace_id,state,error_code) VALUES(${vm},${p.workspace_id},${input.state},${input.error_code}) ON CONFLICT(vm_id) DO UPDATE SET state=excluded.state,error_code=excluded.error_code,updated_at=now() WHERE assistant.chatgpt_accounts.request_status IS NULL OR assistant.chatgpt_accounts.request_status IN ('completed','failed')`;
      }
    });return c.json({accepted:true});
  });
  app.post("/authorization",async c=>{
    const p=c.get("principal"),vm=z.uuid().parse(p.vm_id),input=z.object({request_id:z.uuid(),authorization_url:z.url().max(8000)}).strict().parse(await c.req.json());
    await sql.begin(async tx=>{
      const row=await localRequest(tx,p.workspace_id,vm,input.request_id),url=new URL(input.authorization_url);
      if(url.origin!=="https://auth.openai.com"||url.pathname!=="/api/accounts/authorize"||url.username||url.password||url.hash||url.searchParams.get("redirect_uri")!==row.redirect_uri||url.searchParams.has("id_token_hint")||url.searchParams.get("code_challenge_method")!=="S256"||!url.searchParams.get("state")||!url.searchParams.get("nonce"))throw new DomainError("invalid_request","Invalid local authorization",400);
      if(row.authorization_url&&row.authorization_url!==input.authorization_url)throw new DomainError("idempotency_conflict","Login authorization differs",409);
      await tx`UPDATE assistant.chatgpt_accounts SET authorization_url=${input.authorization_url},updated_at=now() WHERE vm_id=${vm} AND request_id=${input.request_id}`;
    });return c.json({accepted:true});
  });
  app.get("/callback",async c=>{
    c.header("Cache-Control","no-store");
    const p=c.get("principal"),vm=z.uuid().parse(p.vm_id),request=z.uuid().parse(c.req.query("request_id"));
    return c.json(await sql.begin(async tx=>{const row=await localRequest(tx,p.workspace_id,vm,request);return {callback:row.callback_cipher?LocalCallback.parse(JSON.parse((await unseal(row.callback_cipher,encryptionKey))["callback"]??"null")):null};}));
  });return app;
}
