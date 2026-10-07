import { ownedVersion } from "./versions.ts";
import { workflowRoutes } from "./workflow-routes.ts";
import { hashToken } from "../../services/control/auth.ts";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../../services/control/auth.ts";
import type { Database, Transaction } from "../../services/control/db.ts";
import { DomainError } from "../protocol/index.ts";
import { SkillInput, ServerInput, Skill, SkillMetadata, Observation } from "./schema.ts";
import { seal } from "./secrets.ts";
import { restoredServer, storedConfiguration } from "./url-storage.ts";
async function ownVm(tx:Transaction,scope:{readonly workspace:string;readonly vm:string}) {
  await tx`SELECT id FROM assistant.workspaces WHERE id=${scope.workspace} FOR UPDATE`;
  if (!(await tx`SELECT id FROM assistant.vms WHERE workspace_id=${scope.workspace} AND id=${scope.vm}`)[0]) throw new DomainError("not_found","VM not found",404);
}
export function extensionClientRoutes(sql:Database,encryptionKey?:string):Hono<AppEnv> {
  const app=new Hono<AppEnv>();
  app.get("/",async c=>{
    const vm=z.uuid().parse(c.req.query("vm_id")),workspace=c.get("principal").workspace_id;
    const includeArchived=z.enum(["true","false"]).default("false").parse(c.req.query("include_archived"))==="true";
    c.header("Cache-Control","no-store");
    return c.json({skills:z.array(Skill).parse(await sql`SELECT * FROM assistant.extension_skills WHERE workspace_id=${workspace} AND vm_id=${vm} AND (${includeArchived} OR archived_at IS NULL) ORDER BY name`),servers:await Promise.all((await sql`SELECT * FROM assistant.extension_servers WHERE workspace_id=${workspace} AND vm_id=${vm} ORDER BY name`).map(async row=>(await restoredServer(row,encryptionKey)).server))});
  });
  app.route("/skills",workflowRoutes(sql));
  app.post("/skills",async c=>{
    const input=SkillInput.parse(await c.req.json()),workspace=c.get("principal").workspace_id;
    const skill=await sql.begin(async tx=>{
      await ownVm(tx,{workspace,vm:input.vm_id});
      if(input.origin_message_id&&!(await tx`SELECT id FROM assistant.messages WHERE workspace_id=${workspace} AND id=${input.origin_message_id}`)[0])throw new DomainError("not_found","Origin message not found",404);
      const saveVersion=async(skill:z.infer<typeof Skill>)=>{
        await tx`INSERT INTO assistant.skill_versions(workspace_id,skill_id,revision,name,description,content,content_hash,origin_message_id) VALUES(${workspace},${skill.id},${skill.revision},${skill.name},${skill.description},${skill.content},${await hashToken(skill.content)},COALESCE(${input.origin_message_id??null}::uuid,(SELECT origin_message_id FROM assistant.skill_versions WHERE workspace_id=${workspace} AND skill_id=${skill.id} AND revision=${skill.revision-1})))`;
        return skill;
      };
      if(input.id){
        const current=await tx`SELECT revision FROM assistant.extension_skills WHERE id=${input.id} AND workspace_id=${workspace} AND vm_id=${input.vm_id} AND archived_at IS NULL FOR UPDATE`;
        if(!current[0])throw new DomainError("not_found","Skill not found",404);
        if(input.expected_revision!==current[0]['revision'])throw new DomainError("stale_revision","Reload skill before editing",409);
        const rows=await tx`UPDATE assistant.extension_skills SET name=${input.name},description=${input.description},content=${input.content},enabled=${input.enabled},revision=revision+1,state='pending',updated_at=now() WHERE id=${input.id} AND workspace_id=${workspace} AND vm_id=${input.vm_id} RETURNING *`;
        if(!rows[0])throw new DomainError("not_found","Skill not found",404);return saveVersion(Skill.parse(rows[0]));
      }
      const total=z.object({count:z.coerce.number()}).parse((await tx`SELECT count(*) count FROM assistant.extension_skills WHERE workspace_id=${workspace} AND vm_id=${input.vm_id} AND archived_at IS NULL`)[0]).count;
      if(total>=30)throw new DomainError("extension_limit","Skill limit reached",409);
      return saveVersion(Skill.parse((await tx`INSERT INTO assistant.extension_skills(workspace_id,vm_id,name,description,content,enabled) VALUES(${workspace},${input.vm_id},${input.name},${input.description},${input.content},${input.enabled}) RETURNING *`)[0]));
    });return c.json({skill},201);
  });
  app.post("/servers",async c=>{
    const input=ServerInput.parse(await c.req.json()),workspace=c.get("principal").workspace_id;
    const server=await sql.begin(async tx=>{
      await ownVm(tx,{workspace,vm:input.vm_id});
      const previous=input.id?(await tx`SELECT * FROM assistant.extension_servers WHERE id=${input.id} AND workspace_id=${workspace} AND vm_id=${input.vm_id} FOR UPDATE`)[0]:undefined;
      if(input.id&&!previous)throw new DomainError("not_found","Server not found",404);
      const headers=input.secrets??(previous?(await restoredServer(previous,encryptionKey)).secrets:{});
      const stored=storedConfiguration(input.config,headers);
      const cipher=await seal(stored.secrets,encryptionKey);
      if(input.id){
        const rows=await tx`UPDATE assistant.extension_servers SET name=${input.name},config=${JSON.stringify(stored.config)}::text::jsonb,enabled=${input.enabled},revision=revision+1,state='pending',updated_at=now() WHERE id=${input.id} AND workspace_id=${workspace} AND vm_id=${input.vm_id} RETURNING *`;
        if(!rows[0])throw new DomainError("not_found","Server not found",404);
        await tx`UPDATE assistant.extension_servers SET secret_cipher=${cipher},secret_keys=${JSON.stringify(Object.keys(headers))}::text::jsonb WHERE id=${input.id} AND workspace_id=${workspace}`;
        return (await restoredServer((await tx`SELECT * FROM assistant.extension_servers WHERE id=${input.id} AND workspace_id=${workspace}`)[0],encryptionKey)).server;
      }
      const total=z.object({count:z.coerce.number()}).parse((await tx`SELECT count(*) count FROM assistant.extension_servers WHERE workspace_id=${workspace} AND vm_id=${input.vm_id}`)[0]).count;
      if(total>=12)throw new DomainError("extension_limit","MCP server limit reached",409);
      return (await restoredServer((await tx`INSERT INTO assistant.extension_servers(workspace_id,vm_id,name,config,enabled,secret_cipher,secret_keys) VALUES(${workspace},${input.vm_id},${input.name},${JSON.stringify(stored.config)}::text::jsonb,${input.enabled},${cipher},${JSON.stringify(Object.keys(headers))}::text::jsonb) RETURNING *`)[0],encryptionKey)).server;
    });c.header("Cache-Control","no-store");return c.json({server},201);
  });
  app.post("/servers/:id/retry",async c=>{
    const rows=await sql`UPDATE assistant.extension_servers SET revision=revision+1,state='pending',updated_at=now() WHERE id=${z.uuid().parse(c.req.param("id"))} AND workspace_id=${c.get("principal").workspace_id} RETURNING *`;
    if(!rows[0])throw new DomainError("not_found","Server not found",404);c.header("Cache-Control","no-store");return c.json({server:(await restoredServer(rows[0],encryptionKey)).server});
  });
  for(const kind of ["skills","servers"] as const)app.delete(`/${kind}/:id`,async c=>{
    const id=z.uuid().parse(c.req.param("id")),workspace=c.get("principal").workspace_id;
    const rows=kind==="skills"?await sql`UPDATE assistant.extension_skills SET archived_at=now(),enabled=false,state='disabled' WHERE id=${id} AND workspace_id=${workspace} RETURNING id`:await sql`DELETE FROM assistant.extension_servers WHERE id=${id} AND workspace_id=${workspace} RETURNING id`;
    if(!rows[0])throw new DomainError("not_found","Extension not found",404);return c.json({deleted:true});
  });
  return app;
}
export function extensionDaemonRoutes(sql:Database,encryptionKey?:string):Hono<AppEnv>{
  const app=new Hono<AppEnv>();
  app.get("/",async c=>{
    const p=c.get("principal");
    const skills=z.array(SkillMetadata).parse(await sql`SELECT id,vm_id,name,description,enabled,revision,observed_revision,state,tool_count,error_code,observed_at,updated_at FROM assistant.extension_skills WHERE workspace_id=${p.workspace_id} AND vm_id=${p.vm_id} AND archived_at IS NULL ORDER BY id`);
    const rows=await sql`SELECT * FROM assistant.extension_servers WHERE workspace_id=${p.workspace_id} AND vm_id=${p.vm_id} ORDER BY id`;
    const servers=await Promise.all(rows.map(async row=>{const {server,secrets}=await restoredServer(row,encryptionKey);return {...server,secrets:server.enabled?secrets:{}};}));
    c.header("Cache-Control","no-store");return c.json({skills,servers});
  });
  app.get("/bound/:run",async c=>{
    const p=c.get('principal'),run=z.uuid().parse(c.req.param('run'));
    const row=z.object({skill_id:z.uuid(),revision:z.number()}).optional().parse((await sql`SELECT e.skill_id,e.revision FROM assistant.skill_executions e JOIN assistant.runs r ON r.task_id=e.task_id WHERE r.id=${run} AND r.workspace_id=${p.workspace_id} AND r.vm_id=${p.vm_id} AND e.workspace_id=${p.workspace_id} AND e.vm_id=${p.vm_id} AND r.state IN ('running','waiting')`)[0]);
    if(!row)throw new DomainError('not_found','Active bound skill not found',404);
    c.header('Cache-Control','no-store');return c.json(await ownedVersion(sql,p.workspace_id,row.skill_id,row.revision,p.vm_id??undefined));
  });
  app.get("/skills/:id",async c=>{
    const p=c.get("principal");const rows=await sql`SELECT id,name,content,revision FROM assistant.extension_skills WHERE id=${z.uuid().parse(c.req.param("id"))} AND workspace_id=${p.workspace_id} AND vm_id=${p.vm_id} AND enabled AND archived_at IS NULL`;
    if(!rows[0])throw new DomainError("not_found","Enabled skill not found",404);return c.json(z.object({id:z.uuid(),name:z.string(),content:z.string(),revision:z.coerce.number()}).parse(rows[0]));
  });
  app.post("/observed",async c=>{
    const input=Observation.parse(await c.req.json()),p=c.get("principal");
    if((input.kind==="skill"&&input.state==="connected")||(input.kind==="server"&&input.state==="ready")||((input.state==="error")!==(input.error_code!==null)))throw new DomainError("invalid_observation","Invalid observed state",400);
    const rows=input.kind==="skill"?await sql`UPDATE assistant.extension_skills SET observed_revision=${input.revision},state=${input.state},tool_count=${input.tool_count},error_code=${input.error_code},observed_at=now() WHERE id=${input.id} AND workspace_id=${p.workspace_id} AND vm_id=${p.vm_id} AND revision=${input.revision} RETURNING id`:await sql`UPDATE assistant.extension_servers SET observed_revision=${input.revision},state=${input.state},tool_count=${input.tool_count},error_code=${input.error_code},observed_at=now() WHERE id=${input.id} AND workspace_id=${p.workspace_id} AND vm_id=${p.vm_id} AND revision=${input.revision} RETURNING id`;
    if(!rows[0])throw new DomainError("stale_configuration","Configuration changed",409);return c.json({accepted:true});
  });return app;
}
