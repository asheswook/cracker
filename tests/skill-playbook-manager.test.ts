import {test,expect} from "bun:test";
import ky from "ky";
import {SaveSkillInput,Skill} from "../packages/extensions/schema.ts";
import {ExtensionManager,saveSkillTool} from "../services/daemon/extensions.ts";
import {ToolExecutor} from "../services/daemon/tools.ts";
import type {Assignment} from "../packages/protocol/index.ts";

test('save_skill bounds input and requires an explicit source',()=>{
  const input={name:'Meeting',description:'When booking company meetings',content:'Book calendar and room.',source_message_id:crypto.randomUUID()};
  expect(SaveSkillInput.safeParse(input).success).toBe(true);
  for(const patch of [{name:'x'.repeat(81)},{description:'x'.repeat(301)},{content:'x'.repeat(20001)},{source_message_id:undefined},{content:'  '}])expect(SaveSkillInput.safeParse({...input,...patch}).success).toBe(false);
  expect(saveSkillTool).toMatchObject({name:'save_skill',strict:true});
});
test('saving refreshes local catalogue and loading immediately, updates carry revision and run scope',async()=>{
  const now=new Date().toISOString(),vm=crypto.randomUUID(),id=crypto.randomUUID(),source=crypto.randomUUID();
  const assignment:Assignment={run_id:crypto.randomUUID(),task:{id:crypto.randomUUID(),conversation_id:crypto.randomUUID(),objective:'Book a meeting',state:'running',reason:null,created_at:now,updated_at:now},messages:[],instructions:'',memory:[]};
  let saved:ReturnType<typeof Skill.parse>|undefined;
  const bodies:Record<string,unknown>[]=[];
  const server=Bun.serve({port:0,async fetch(request){
    const path=new URL(request.url).pathname;
    if(path==='/v1/daemon/extensions/skills'&&request.method==='POST'){
      const body=await request.json() as Record<string,unknown>;bodies.push(body);
      saved=Skill.parse({...body,id,vm_id:vm,enabled:true,revision:(saved?.revision??0)+1,observed_revision:null,state:'pending',tool_count:0,error_code:null,observed_at:null,updated_at:now});
      return Response.json({skill:saved},{status:201});
    }
    if(path===`/v1/daemon/extensions/skills/${id}`)return Response.json(saved);
    if(path==='/v1/daemon/extensions')return Response.json({skills:saved?[saved]:[],servers:[]});
    return Response.json({accepted:true});
  }});
  const tools=new ToolExecutor(),manager=new ExtensionManager(ky.create({prefixUrl:server.url.href,retry:0}),tools),signal=AbortSignal.timeout(5000);
  try{
    const input={name:'Meeting',description:'When booking company meetings',content:'Book calendar and room near floor 17.',source_message_id:source};
    const result=JSON.parse(await manager.save(JSON.stringify(input),signal,assignment));
    expect(result).toMatchObject({saved:true,skill_id:id,enabled:true,revision:1});
    expect(manager.catalog()).toEqual([{id,name:input.name,description:input.description,revision:1}]);
    expect(await manager.load(JSON.stringify({skill_id:id}),signal)).toContain(input.content);
    await manager.save(JSON.stringify({...input,skill_id:id,content:'Updated procedure'}),signal,assignment);
    expect(bodies[1]).toMatchObject({run_id:assignment.run_id,source_message_id:source,expected_revision:1});
    expect(manager.catalog()[0]?.revision).toBe(2);
    expect(await manager.load(JSON.stringify({skill_id:id}),signal)).toContain('Updated procedure');
    if(!saved)throw new Error('Missing saved skill');
    saved={...saved,enabled:false};await manager.reconcile(true);
    expect(manager.catalog()).toEqual([]);
    expect(JSON.parse(await manager.save(JSON.stringify({...input,skill_id:id}),signal,assignment))).toMatchObject({error:'skill_not_enabled'});
    expect(bodies).toHaveLength(2);
  }finally{await tools.close();await server.stop(true);}
});
