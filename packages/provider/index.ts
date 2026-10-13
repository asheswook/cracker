import OpenAI from "openai";
import { retryProvider, type ProviderRetryObserver } from "./retry.ts";
import type { ResponseInputItem, Tool, Response } from "openai/resources/responses/responses";
import { compactedInput } from "./compaction.ts";
import { readCredential } from "./credentials.ts";
import type { NativeContext } from "./native-context.ts";

import {ProviderError} from "./errors.ts";
import {consumeResponse} from "./stream.ts";
import type {ProviderResponseObserver} from "./stream.ts";
export type {ProviderResponseObserver,ProviderResponseEvent} from "./stream.ts";
import {ResponseSocketPool} from "./websocket.ts";
export {ProviderError} from "./errors.ts";
export {consumeResponse} from "./stream.ts";
export type ProviderConfig = { readonly onRetry?: ProviderRetryObserver; readonly mode: "api" | "chatgpt"; readonly transport?:"http"|"websocket"; readonly serviceTier?:"default"; readonly model: string; readonly apiKey?: string; readonly tokenFile?: string; readonly reasoningEffort?: "low" | "medium" | "high" | "xhigh" | "max" };
export interface Provider {
  readonly nativeContext?: NativeContext;
  close?():void|Promise<void>;
  readonly standaloneCompaction?:boolean;
  compact?(input: ResponseInputItem[], signal: AbortSignal): Promise<ResponseInputItem[]>;
  respond(input: ResponseInputItem[], tools: Tool[], signal: AbortSignal, observer?:ProviderResponseObserver): Promise<Response>;
}
export class OpenAIProvider implements Provider {
  get standaloneCompaction():boolean{return this.config.mode==="api";}
  private sockets:{readonly token:string;readonly pool:ResponseSocketPool}|undefined;
  private readonly retiredPools=new Set<ResponseSocketPool>();
  private websocketFlights=0;
  private credentialIdentity:string|undefined;
  private closed=false;
  close():void{this.closed=true;this.sockets?.pool.close();for(const pool of this.retiredPools)pool.close();this.retiredPools.clear();}
  constructor(private readonly config: ProviderConfig, private readonly client?: OpenAI) {
    if (!config.model.trim()) throw new ProviderError("configuration", "OPENAI_MODEL is required");
  }
  async respond(input: ResponseInputItem[], tools: Tool[], signal: AbortSignal,observer?:ProviderResponseObserver): Promise<Response> {
    if(this.closed)throw new ProviderError("configuration","Provider is closed");
    if(this.config.transport!=="websocket")return retryProvider(() => this.respondOnce(input,tools,signal,observer), {signal,onRetry:this.config.onRetry});
    if(this.websocketFlights>=8)throw new ProviderError("configuration","WebSocket concurrent request limit reached");
    this.websocketFlights++;
    try{return await retryProvider(() => this.respondOnce(input,tools,signal,observer), {signal,onRetry:this.config.onRetry});}
    finally{this.websocketFlights--;for(const pool of this.retiredPools)if(pool.drained)this.retiredPools.delete(pool);}
  }
  private async credentialToken():Promise<string>{
    let token: string;
    switch (this.config.mode) {
      case "api": {
        if (!this.config.apiKey) throw new ProviderError("configuration", "API mode requires OPENAI_API_KEY");
        token = this.config.apiKey; break;
      }
      case "chatgpt": {
        if (!this.config.tokenFile) throw new ProviderError("configuration", "ChatGPT mode requires CHATGPT_TOKEN_FILE");
        const credential=await readCredential(this.config.tokenFile);
        const identity=JSON.stringify([credential.issuer,credential.subject,credential.client_id,credential.ext_agent_host_id]);
        if(this.credentialIdentity&&this.credentialIdentity!==identity)throw new ProviderError("oauth","Credential identity changed; restart provider explicitly");
        this.credentialIdentity=identity;token=credential.access_token;break;
      }
      default: return assertNever(this.config.mode);
    }
    return token;
  }
  async compact(input:ResponseInputItem[],signal:AbortSignal):Promise<ResponseInputItem[]>{
    return retryProvider(async () => {
      const token=await this.credentialToken();
      signal.throwIfAborted();
      if(this.closed)throw new ProviderError("configuration","Provider is closed");
      const client=this.client?.withOptions({maxRetries:0}) ?? new OpenAI({apiKey:token,maxRetries:0,timeout:120000});
      return compactedInput(await client.responses.compact({model:this.config.model,input,service_tier:"default"},{signal}));
    }, {signal,onRetry:this.config.onRetry});
  }
  private async respondOnce(input:ResponseInputItem[],tools:Tool[],signal:AbortSignal,observer?:ProviderResponseObserver):Promise<Response>{
    const token=await this.credentialToken();
    signal.throwIfAborted();
    if(this.closed)throw new ProviderError("configuration","Provider is closed");
    const client = this.client?.withOptions({maxRetries:0}) ?? new OpenAI({ apiKey: token, maxRetries: 0, timeout: 120000 });
    const body = { model: this.config.model, context_management:[{type:"compaction",compact_threshold:64000}], ...(this.config.serviceTier?{service_tier:this.config.serviceTier}:{}), ...(this.config.reasoningEffort ? { reasoning: { effort: this.config.reasoningEffort } } : {}), input, tools, parallel_tool_calls: true, store: false, stream: true, include: ["reasoning.encrypted_content"] } satisfies Parameters<typeof client.responses.create>[0];
    if(this.config.transport==="websocket"){
      if(!this.sockets||this.sockets.token!==token){
        if(this.sockets){this.sockets.pool.retire();if(!this.sockets.pool.drained)this.retiredPools.add(this.sockets.pool);}
        this.sockets={token,pool:new ResponseSocketPool(client,{lane:this.config.mode==="chatgpt"?"implicit":"named"})};
      }
      return this.sockets.pool.respond(body,signal,observer);
    }
    const stream=await client.responses.create(body,{signal});
    return consumeResponse(stream,observer);

  }
}
function assertNever(value: never): never { throw new ProviderError("configuration", `Unsupported mode: ${String(value)}`); }
export type { ResponseInputItem, Tool };
