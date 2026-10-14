import {afterAll,test,expect} from "bun:test";
import {z} from "zod";
import {createDatabase} from "../services/control/db.ts";
import {createApp} from "../services/control/app.ts";
import {hashToken} from "../services/control/auth.ts";
import {DaemonPoll,Message} from "../packages/protocol/index.ts";
import {Skill} from "../packages/extensions/schema.ts";
import {Version} from "../packages/extensions/versions.ts";

const sql=createDatabase(process.env["TEST_DATABASE_URL"]??"postgres://assistant:assistant@127.0.0.1:55439/assistant_dev");
afterAll(()=>sql.end());
async function fixture(){
  const workspace=crypto.randomUUID(),vm=crypto.randomUUID(),client=crypto.randomUUID(),machine=crypto.randomUUID();
  await sql`INSERT INTO assistant.workspaces(id,name) VALUES(${workspace},'playbooks')`;
  await sql`INSERT INTO assistant.vms(id,workspace_id,name) VALUES(${vm},${workspace},'playbooks')`;
  await sql`INSERT INTO assistant.credentials(token_hash,workspace_id,role,vm_id) VALUES(${await hashToken(client)},${workspace},'client',NULL),(${await hashToken(machine)},${workspace},'vm',${vm})`;
  const app=createApp(sql);
  const request=(path:string,body?:unknown,token=machine,method=body?'POST':'GET')=>app.request(path,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  const conversation=z.object({conversation:z.object({id:z.uuid()})}).parse(await(await request('/v1/conversations',{title:'Meeting preferences'},client)).json()).conversation;
  const content='When booking company meetings, also add Google Calendar and book a room near floor 17 first.';
  const source=z.object({message:Message}).parse(await(await request(`/v1/conversations/${conversation.id}/messages`,{client_message_id:crypto.randomUUID(),content},client)).json()).message;
  const run=DaemonPoll.parse(await(await request('/v1/daemon/poll?view=work')).json()).assignment;
  if(!run)throw new Error('Expected active run');
  const body={run_id:run.run_id,name:'Company meetings',description:'When booking a company meeting',content:'# Company meetings\n\n1. Add Google Calendar.\n2. Book a meeting room, starting near floor 17.',source_message_id:source.id};
  return {workspace,vm,client,machine,request,conversation,source,run,body};
}
test('daemon creates an enabled playbook, records user provenance and versions updates',async()=>{
  const f=await fixture();
  const response=await f.request('/v1/daemon/extensions/skills',f.body);
  expect(response.status).toBe(201);
  const first=z.object({skill:Skill}).parse(await response.json()).skill;
  expect(first.enabled).toBe(true);expect(first.revision).toBe(1);
  const update=await f.request('/v1/daemon/extensions/skills',{...f.body,skill_id:first.id,content:f.body.content+'\n3. Confirm attendees.'});
  expect(update.status).toBe(201);
  expect(z.object({skill:Skill}).parse(await update.json()).skill.revision).toBe(2);
  const versions=z.object({versions:z.array(Version)}).parse(await(await f.request(`/v1/extensions/skills/${first.id}/versions`,undefined,f.client)).json()).versions;
  expect(versions.map(v=>[v.revision,v.origin_message_id,v.agent_authored])).toEqual([[2,f.source.id,true],[1,f.source.id,true]]);
  expect(versions[1]?.content).toBe(f.body.content);
  const listed=z.object({skills:z.array(Skill)}).parse(await(await f.request(`/v1/extensions?vm_id=${f.vm}`,undefined,f.client)).json()).skills;
  expect(listed[0]).toMatchObject({agent_authored:true,source_excerpt:f.source.content});
  expect((await f.request(`/v1/daemon/extensions/skills/${first.id}`)).status).toBe(200);
  expect((await f.request('/v1/daemon/extensions/skills',{...f.body,skill_id:first.id,expected_revision:1})).status).toBe(409);
  expect((await f.request('/v1/extensions/skills',{vm_id:f.vm,id:first.id,expected_revision:2,name:first.name,description:first.description,content:first.content,enabled:false},f.client)).status).toBe(201);
  const edited=z.object({skills:z.array(Skill)}).parse(await(await f.request(`/v1/extensions?vm_id=${f.vm}`,undefined,f.client)).json()).skills;
  expect(edited[0]).toMatchObject({enabled:false,agent_authored:true,source_excerpt:f.source.content});
  expect((await f.request(`/v1/daemon/extensions/skills/${first.id}`)).status).toBe(404);
  expect((await f.request(`/v1/extensions/skills/${first.id}`,undefined,f.client,'DELETE')).status).toBe(200);
  expect((await f.request('/v1/daemon/extensions/skills',{...f.body,skill_id:first.id})).status).toBe(404);
});
test('daemon rejects missing, non-user, foreign-conversation sources and unowned or stale runs',async()=>{
  const f=await fixture(),other=await fixture();
  for(const role of ['assistant','system']){
    const id=crypto.randomUUID();
    await sql`INSERT INTO assistant.messages(id,workspace_id,conversation_id,role,content) VALUES(${id},${f.workspace},${f.conversation.id},${role},${f.source.content})`;
    expect((await f.request('/v1/daemon/extensions/skills',{...f.body,source_message_id:id})).status).toBe(409);
  }
  const conversation=z.object({conversation:z.object({id:z.uuid()})}).parse(await(await f.request('/v1/conversations',{title:'Other'},f.client)).json()).conversation;
  const id=crypto.randomUUID();
  await sql`INSERT INTO assistant.messages(id,workspace_id,conversation_id,role,content) VALUES(${id},${f.workspace},${conversation.id},'user',${f.source.content})`;
  for(const source of [id,other.source.id,crypto.randomUUID()])expect((await f.request('/v1/daemon/extensions/skills',{...f.body,source_message_id:source})).status).toBe(409);
  const {source_message_id,...missing}=f.body;
  expect(source_message_id).toBe(f.source.id);
  expect((await f.request('/v1/daemon/extensions/skills',missing)).status).toBe(400);
  expect((await f.request('/v1/daemon/extensions/skills',f.body,other.machine)).status).toBe(404);
  expect((await f.request('/v1/daemon/extensions/skills',f.body,f.client)).status).toBe(403);
  await sql`UPDATE assistant.runs SET state='succeeded' WHERE id=${f.run.run_id}`;
  expect((await f.request('/v1/daemon/extensions/skills',f.body)).status).toBe(409);
  expect((await sql`SELECT id FROM assistant.extension_skills WHERE workspace_id=${f.workspace}`)).toHaveLength(0);
});
