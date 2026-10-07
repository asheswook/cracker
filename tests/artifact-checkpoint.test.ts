import {test,expect} from "bun:test";
import {mkdtemp,rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import ky from "ky";
import {TaskArtifacts} from "../services/daemon/artifacts.ts";
import type {Message} from "../packages/protocol/index.ts";

test("attachment delivered after checkpoint is safely reapplied after restart before input ACK",async()=>{
  // Given an older artifact checkpoint and a downloaded attachment not yet in that checkpoint.
  const root=await mkdtemp(join(tmpdir(),"artifact-checkpoint-")),bytes=Buffer.from("fixture attachment"),id=crypto.randomUUID();
  const server=Bun.serve({port:0,fetch(){return new Response(bytes);}});
  const scope={http:ky.create({prefixUrl:server.url.href}),runId:crypto.randomUUID(),conversationId:crypto.randomUUID(),root};
  const message:Message={id:crypto.randomUUID(),conversation_id:scope.conversationId,role:"user",content:"",sequence:2,created_at:new Date().toISOString(),client_message_id:null,attachments:[{id,state:"ready",name:"fixture.txt",media_type:"text/plain",bytes:bytes.length,sha256:new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),created_at:new Date().toISOString()}]};
  try{
    const original=await TaskArtifacts.create(scope),checkpoint=original.checkpoint();
    const first=await original.input(message,AbortSignal.timeout(1000));
    // When restarting from the checkpoint before attachment application was committed.
    const resumed=await TaskArtifacts.resume(scope,checkpoint),second=await resumed.input(message,AbortSignal.timeout(1000));
    // Then the exact trusted bytes and local provenance are retained without duplicate file failure.
    expect(second).toEqual(first);expect(resumed.checkpoint().seen).toEqual([id]);
  }finally{await server.stop(true);await rm(root,{recursive:true});}
});
