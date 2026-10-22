import type { Assignment } from "../../packages/protocol/index.ts";
import { HTTPError, type KyInstance } from "ky";
import { z } from "zod";
import { Manifest, SaveSkillInput, Skill, type SkillMetadata, type Observation } from "../../packages/extensions/schema.ts";
import type { Tool } from "../../packages/provider/index.ts";
import type { ToolExecutor } from "./tools.ts";
import { mcpConnectionFailure } from "./mcp-failure.ts";
export const loadSkillTool:Tool={type:"function",name:"load_skill",description:"Load the complete SKILL.md of an enabled user-configured skill when relevant. The catalog only contains metadata; do not claim to have read the skill before this tool succeeds.",strict:true,parameters:{type:"object",properties:{skill_id:{type:"string"}},required:["skill_id"],additionalProperties:false}};
export const saveSkillTool:Tool={type:"function",name:"save_skill",description:"Save a reusable procedure or standing preference explicitly stated by the user. Describe WHEN to use it in description and HOW in Markdown content. Load and update a matching skill rather than duplicating it. source_message_id must identify the user's instruction in this conversation. Never save one-off facts, secrets or credentials. Use null skill_id to create; saved skills are enabled immediately.",strict:true,parameters:{type:"object",properties:{name:{type:"string",maxLength:80},description:{type:"string",maxLength:300},content:{type:"string",maxLength:20000},skill_id:{type:["string","null"]},source_message_id:{type:"string"}},required:["name","description","content","skill_id","source_message_id"],additionalProperties:false}};
export class ExtensionManager {
  private skills:readonly z.infer<typeof SkillMetadata>[]=[];
  private readonly servers=new Map<string,{revision:number;failures:number;retryAt:number;errorCode?:NonNullable<z.infer<typeof Observation>["error_code"]>}>();
  private nextSync=0;
  constructor(private readonly http:KyInstance,private readonly tools:ToolExecutor){}
  async loadBound(assignment:Assignment,signal:AbortSignal){
    const binding=assignment.skill_binding;
    if(!binding)return null;
    const skill=z.object({skill_id:z.uuid(),revision:z.number(),content_hash:z.string(),name:z.string(),content:z.string().max(65536)}).parse(await this.http.get(`v1/daemon/extensions/bound/${assignment.run_id}`,{signal}).json());
    const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(skill.content))),byte=>byte.toString(16).padStart(2,'0')).join('');
    if(skill.skill_id!==binding.skill_id||skill.revision!==binding.revision||skill.content_hash!==binding.content_hash||hash!==binding.content_hash)throw new Error('Pinned skill version mismatch');
    return {kind:'pinned_skill_version' as const,...skill};
  }
  catalog():readonly {id:string;name:string;description:string;revision:number}[]{return this.skills.filter(skill=>skill.enabled).map(({id,name,description,revision})=>({id,name,description,revision}));}
  async save(args:string,signal:AbortSignal,assignment:Assignment):Promise<string>{
    const input=SaveSkillInput.parse(JSON.parse(args));
    const known=input.skill_id?this.skills.find(skill=>skill.id===input.skill_id):undefined;
    if(input.skill_id&&!known)return JSON.stringify({error:"skill_configuration_changed"});
    if(known&&!known.enabled)return JSON.stringify({error:"skill_not_enabled",instruction:"The user disabled this skill; do not re-enable it implicitly."});
    const {skill}=z.object({skill:Skill}).parse(await this.http.post("v1/daemon/extensions/skills",{json:{...input,run_id:assignment.run_id,...(known?{expected_revision:known.revision}:{})},signal}).json());
    this.skills=[...this.skills.filter(item=>item.id!==skill.id),skill];
    return JSON.stringify({saved:true,skill_id:skill.id,name:skill.name,description:skill.description,revision:skill.revision,enabled:skill.enabled});
  }
  async load(args:string,signal:AbortSignal,assignment?:Assignment):Promise<string>{
    const {skill_id}=z.object({skill_id:z.uuid()}).parse(JSON.parse(args));
    if(assignment?.skill_binding?.skill_id===skill_id)return JSON.stringify(await this.loadBound(assignment,signal));
    const known=this.skills.find(skill=>skill.id===skill_id&&skill.enabled);
    if(!known)return JSON.stringify({error:"skill_not_enabled"});
    try{
      const skill=z.object({id:z.uuid(),name:z.string(),content:z.string().max(65536),revision:z.number()}).parse(await this.http.get(`v1/daemon/extensions/skills/${skill_id}`,{signal}).json());
      if(skill.revision!==known.revision)return JSON.stringify({error:"skill_configuration_changed"});
      return JSON.stringify({kind:"user_configured_skill",...skill});
    }catch(error){if(error instanceof HTTPError&&error.response.status===404)return JSON.stringify({error:"skill_not_enabled"});throw error;}
  }
  private namespace(id:string):string{return `cfg_${Bun.hash(id).toString(16)}`;}
  async reconcile(force=false):Promise<void>{
    if(!force&&Date.now()<this.nextSync)return;
    this.nextSync=Date.now()+15000;
    const manifest=Manifest.parse(await this.http.get("v1/daemon/extensions").json());
    this.skills=manifest.skills;
    for(const id of this.servers.keys())if(!manifest.servers.some(server=>server.id===id)){await this.tools.removeMcp(this.namespace(id));this.servers.delete(id);}
    await Promise.all(this.skills.map(skill=>this.observe({kind:"skill",id:skill.id,revision:skill.revision,state:skill.enabled?"ready":"disabled",tool_count:0,error_code:null})));
    const reconciled = await Promise.allSettled(manifest.servers.map(async server=>{
      const name=this.namespace(server.id),prior=this.servers.get(server.id);
      if(!server.enabled){await this.tools.removeMcp(name);this.servers.set(server.id,{revision:server.revision,failures:0,retryAt:0});await this.observe({kind:"server",id:server.id,revision:server.revision,state:"disabled",tool_count:0,error_code:null});return;}
      if(prior?.revision===server.revision&&prior.retryAt>Date.now()){await this.observe({kind:"server",id:server.id,revision:server.revision,state:"error",tool_count:0,error_code:prior.errorCode??"connect_failed"});return;}
      let observation:z.infer<typeof Observation>;
      try{
        if(prior?.revision!==server.revision||!this.tools.mcpStatus(name).connected)await this.tools.addMcp(name,server.config,server.secrets,server.category,server.disabled_tools);
        else await this.tools.pingMcp(name);
        const status=this.tools.mcpStatus(name);
        if(!status.connected)throw new TypeError("MCP disconnected");
        this.servers.set(server.id,{revision:server.revision,failures:0,retryAt:0});
        observation={kind:"server",id:server.id,revision:server.revision,state:"connected",tool_count:status.tool_count,error_code:null,tools:this.tools.mcpTools(name).slice(0,200)};
      }catch(error){
        if(!(error instanceof Error))throw error;
        await this.tools.removeMcp(name);
        const failures=(prior?.failures??0)+1;
        const errorCode=mcpConnectionFailure(error);
        this.servers.set(server.id,{revision:server.revision,failures,retryAt:Date.now()+Math.min(300000,15000*2**Math.min(failures,5)),errorCode});
        observation={kind:"server",id:server.id,revision:server.revision,state:"error",tool_count:0,error_code:errorCode};
      }
      await this.observe(observation);
    }));
    for(const result of reconciled)if(result.status==="rejected")throw result.reason;
  }
  private async observe(value:z.infer<typeof Observation>):Promise<void>{
    try{await this.http.post("v1/daemon/extensions/observed",{json:value});}
    catch(error){if(error instanceof HTTPError&&error.response.status===409)return;throw error;}
  }
}
