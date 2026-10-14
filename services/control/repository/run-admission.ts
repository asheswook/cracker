import { z } from 'zod';
import { BACKGROUND_SLOTS } from '../../../packages/protocol/parallel-runs';
import type { Principal } from '../auth';
import type { Query } from '../db';

// Call only while holding the VM row lock; offers count exactly like accepted runs.
export async function admission(sql:Query,principal:Principal,exclude?:string){
  const vm=z.object({daemon_session_id:z.uuid().nullable(),admission_paused:z.boolean()}).parse((await sql`SELECT daemon_session_id,admission_paused FROM assistant.vms WHERE id=${principal.vm_id}`)[0]);
  if(vm.admission_paused){
    const reserved=exclude?await sql`SELECT id FROM assistant.runs WHERE id=${exclude} AND vm_id=${principal.vm_id} AND state NOT IN ('cancelled','succeeded','failed','unknown')`:[];
    if(!reserved.length)return {foreground:false,background:false};
  }
  const active=z.array(z.object({lane:z.enum(['foreground','background'])})).parse(await sql`
    SELECT lane FROM assistant.runs WHERE vm_id=${principal.vm_id} AND (${exclude??null}::uuid IS NULL OR id<>${exclude??null})
    AND state NOT IN ('cancelled','succeeded','failed','unknown')`);
  if(!vm.daemon_session_id||BACKGROUND_SLOTS===0)return {foreground:active.length===0,background:active.length===0};
  return {foreground:!active.some(run=>run.lane==='foreground'),background:active.filter(run=>run.lane==='background').length<BACKGROUND_SLOTS};
}
