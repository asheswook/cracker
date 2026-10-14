import { z } from 'zod';
import type { Database } from '../db';

export const DrainReport=z.array(z.object({
  vm_id:z.uuid(),workspace_id:z.uuid(),name:z.string(),admission_paused:z.boolean(),
  active_runs:z.array(z.object({id:z.uuid(),task_id:z.uuid(),lane:z.enum(['foreground','background']),state:z.string(),offered_at:z.string().nullable(),accepted_at:z.string().nullable()})),
  pending_commands:z.array(z.object({id:z.uuid(),kind:z.string(),task_id:z.uuid().nullable(),run_id:z.uuid().nullable()})),
}));
export async function reportDraining(sql:Database,vm?:string){
  return DrainReport.parse(await sql`
    SELECT v.id AS vm_id,v.workspace_id,v.name,COALESCE((to_jsonb(v)->>'admission_paused')::boolean,false) AS admission_paused,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('id',r.id,'task_id',r.task_id,'lane',COALESCE(to_jsonb(r)->>'lane','foreground'),
        'state',r.state,'offered_at',to_jsonb(r)->>'offered_at','accepted_at',to_jsonb(r)->>'accepted_at') ORDER BY r.created_at,r.id)
        FROM assistant.runs r WHERE r.vm_id=v.id AND r.state NOT IN ('cancelled','succeeded','failed','unknown')),'[]'::jsonb) AS active_runs,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('id',c.id,'kind',c.kind,'task_id',c.task_id,'run_id',c.run_id) ORDER BY c.created_at,c.id)
        FROM assistant.commands c WHERE c.vm_id=v.id AND c.status='pending'),'[]'::jsonb) AS pending_commands
    FROM assistant.vms v WHERE (${vm??null}::uuid IS NULL OR v.id=${vm??null}) ORDER BY v.id`);
}
export async function pauseAdmission(sql:Database,paused:boolean,vm?:string){
  // Schema bootstrap takes relation locks but never waits for workspace/VM rows.
  // Commit it before the ordered row-locking transaction below.
  await sql.begin(async tx=>{
    // Coordinate the pre-059 bootstrap with the migration runner, without changing its files.
    await tx`SELECT pg_advisory_xact_lock(619083002)`;
    const column=await tx`SELECT 1 FROM information_schema.columns WHERE table_schema='assistant' AND table_name='vms' AND column_name='admission_paused'`;
    if(!column.length)await tx`ALTER TABLE assistant.vms ADD COLUMN admission_paused boolean NOT NULL DEFAULT false`;
    const guard=await tx`SELECT 1 FROM pg_trigger WHERE tgrelid='assistant.runs'::regclass AND tgname='a_run_admission_pause' AND NOT tgisinternal`;
    if(!guard.length){
      await tx.unsafe(`CREATE OR REPLACE FUNCTION assistant.enforce_admission_pause() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF (SELECT admission_paused FROM assistant.vms WHERE id=NEW.vm_id) THEN
            RAISE EXCEPTION 'VM admission is paused' USING ERRCODE='55000';
          END IF;
          RETURN NEW;
        END;
        $$`);
      await tx`CREATE TRIGGER a_run_admission_pause BEFORE INSERT ON assistant.runs FOR EACH ROW EXECUTE FUNCTION assistant.enforce_admission_pause()`;
    }
  });
  return sql.begin(async tx=>{
    const workspaces=z.array(z.object({id:z.uuid()})).parse(await tx`SELECT w.id FROM assistant.workspaces w WHERE EXISTS(
      SELECT 1 FROM assistant.vms v WHERE v.workspace_id=w.id AND (${vm??null}::uuid IS NULL OR v.id=${vm??null})) ORDER BY w.id FOR KEY SHARE OF w`);
    const vms=z.array(z.object({id:z.uuid()})).parse(await tx`SELECT id FROM assistant.vms WHERE workspace_id=ANY(${tx.array(workspaces.map(workspace=>workspace.id))}::uuid[])
      AND (${vm??null}::uuid IS NULL OR id=${vm??null}) ORDER BY id FOR UPDATE`);
    const rows=z.array(z.object({id:z.uuid()})).parse(await tx`UPDATE assistant.vms SET admission_paused=${paused} WHERE id=ANY(${tx.array(vms.map(row=>row.id))}::uuid[]) RETURNING id`);
    if(vm&&!rows.length)throw new Error('VM not found');
    return rows.map(row=>row.id);
  });
}
