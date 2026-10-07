import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createDatabase } from "../services/control/db.ts";
import { createApp } from "../services/control/app.ts";
import { dispatchDueSchedules } from "../services/control/repository/schedules.ts";
import { hashToken } from "../services/control/auth.ts";
import { OpenAIProvider } from "../packages/provider/index.ts";
import { Runtime } from "../services/daemon/runtime.ts";
import { Journal } from "../services/daemon/journal.ts";
import { ToolExecutor } from "../services/daemon/tools.ts";
const wakeProbe = process.env['PROBE_WAKE'] === '1';
const mode = z.enum(['api','chatgpt']).parse(process.env['PROBE_MODE'] ?? 'api');
const sql = createDatabase(process.env['TEST_DATABASE_URL'] ?? 'postgres://assistant:assistant@127.0.0.1:55439/assistant_dev');
const workspace = crypto.randomUUID(), vm = crypto.randomUUID(), conversation = crypto.randomUUID(), task = crypto.randomUUID(), source = crypto.randomUUID(), token = crypto.randomUUID()+crypto.randomUUID();
const dir = await mkdtemp(join(tmpdir(),'enrollment-live-')), journal = new Journal(join(dir,'journal.sqlite'));
const app = createApp(sql), server = Bun.serve({ port:0, fetch:app.fetch });
const provider = new OpenAIProvider({ mode, model:'gpt-5.6-luna', ...(mode==='api' ? { apiKey:z.string().min(1).parse(process.env['OPENAI_API_KEY']) } : { tokenFile:'.local/chatgpt.json' }) });
const runtime = new Runtime({ controlUrl:server.url.href, token, journal, provider, tools:new ToolExecutor(), artifactRoot:join(dir,'artifacts') });
try {
  await sql`INSERT INTO assistant.workspaces(id,name) VALUES(${workspace},'enrollment-live')`;
  await sql`INSERT INTO assistant.vms(id,workspace_id,name) VALUES(${vm},${workspace},'vm')`;
  await sql`INSERT INTO assistant.credentials(token_hash,workspace_id,role,vm_id) VALUES(${await hashToken(token)},${workspace},'vm',${vm})`;
  await sql`INSERT INTO assistant.conversations(id,workspace_id,title) VALUES(${conversation},${workspace},'enrollment')`;
  const due = new Date(Date.now()+(wakeProbe ? 20000 : 3600000)).toISOString();
  const request = `Create a one-time reminder ${wakeProbe ? "twenty seconds from now" : `at ${due} UTC`} to send the marker REMINDER-ENROLLED. Also create an ongoing responsibility to monitor this conversation every ten minutes and notify me only of meaningful task failures. Use the durable enrollment tools for both now. Do not run shell or create files.`;
  await sql`INSERT INTO assistant.tasks(id,workspace_id,conversation_id,objective) VALUES(${task},${workspace},${conversation},${request})`;
  await sql`INSERT INTO assistant.messages(id,workspace_id,conversation_id,task_id,role,content) VALUES(${source},${workspace},${conversation},${task},'user',${request})`;
  const started = Date.now(); let state = 'queued';
  while (Date.now()-started<120000) {
    await runtime.tick();
    state = z.object({state:z.string()}).parse((await sql`SELECT state FROM assistant.tasks WHERE id=${task}`)[0]).state;
    if (['succeeded','failed','unknown'].includes(state)) break;
    await Bun.sleep(250);
  }
  const schedules = z.array(z.object({source_message_id:z.uuid(),status:z.string(),due_at:z.string()})).parse(await sql`SELECT source_message_id,status,due_at FROM assistant.schedules WHERE conversation_id=${conversation}`);
  const responsibilities = z.array(z.object({source_message_id:z.uuid(),state:z.string()})).parse(await sql`SELECT source_message_id,state FROM assistant.responsibilities WHERE conversation_id=${conversation}`);
  if (state!=='succeeded' || schedules.length!==1 || responsibilities.length!==1 || schedules[0]?.source_message_id!==source || responsibilities[0]?.source_message_id!==source) throw new TypeError('Enrollment persistence invariant failed');
  let wakeVerified = false;
  if (wakeProbe) {
    const scheduled = schedules[0];
    if (!scheduled || Date.parse(scheduled.due_at)-started<15000 || Date.parse(scheduled.due_at)-started>45000) throw new TypeError('Relative schedule outside expected clock window');
    await Bun.sleep(Math.max(0,Date.parse(scheduled.due_at)-Date.now()+100));
    const unrelated = z.object({count:z.coerce.number()}).parse((await sql`SELECT count(*) count FROM assistant.schedules WHERE status='pending' AND due_at<=now() AND workspace_id<>${workspace}`)[0]).count;
    if (unrelated !== 0) throw new TypeError('Other due schedules prevent isolated dispatch');
    await dispatchDueSchedules(sql); await dispatchDueSchedules(sql);
    const wakes = z.array(z.object({id:z.uuid(),task_id:z.uuid(),role:z.string()})).parse(await sql`SELECT id,task_id,role FROM assistant.messages WHERE conversation_id=${conversation} AND role='system'`);
    const wake = wakes[0];
    if (wakes.length!==1 || !wake || wake.task_id===task) throw new TypeError('One-shot wake identity mismatch');
    const deadline = Date.now()+90000;
    while (Date.now()<deadline) {
      await runtime.tick();
      const next = z.object({state:z.string()}).parse((await sql`SELECT state FROM assistant.tasks WHERE id=${wake.task_id}`)[0]).state;
      if (next==='succeeded') break;
      if (next==='unknown' || next==='failed') throw new TypeError('Wake task failed');
      await Bun.sleep(250);
    }
    const replies = z.array(z.object({content:z.string()})).parse(await sql`SELECT content FROM assistant.messages WHERE task_id=${wake.task_id} AND role='assistant'`);
    const result = z.object({state:z.string()}).parse((await sql`SELECT state FROM assistant.tasks WHERE id=${wake.task_id}`)[0]);
    wakeVerified = result.state==='succeeded' && replies.some(reply=>reply.content.includes('REMINDER-ENROLLED'));
    if (!wakeVerified) throw new TypeError('Actual model follow-up missing marker');
    const counts = z.object({schedules:z.coerce.number(),responsibilities:z.coerce.number()}).parse((await sql`SELECT (SELECT count(*) FROM assistant.schedules WHERE conversation_id=${conversation}) schedules,(SELECT count(*) FROM assistant.responsibilities WHERE conversation_id=${conversation}) responsibilities`)[0]);
    if (counts.schedules!==1 || counts.responsibilities!==1) throw new TypeError('Wake duplicated enrollment');
  }
  console.log(JSON.stringify({ due_dispatch_followup_verified:wakeVerified, duplicate_dispatch_created_one_wake:wakeVerified, verified_at:new Date().toISOString(), mode,model:'gpt-5.6-luna',surface:'actual model + runtime + HTTP + PostgreSQL',task_succeeded:true,schedule_count:1,responsibility_count:1,both_bound_to_current_user_source:true,elapsed_ms:Date.now()-started }));
} catch (error) { console.error(JSON.stringify({failed:true,type:error instanceof Error?error.name:'unknown'})); process.exitCode=1; }
finally { await runtime.stop(); journal.close(); await server.stop(true); await sql`UPDATE assistant.schedules SET status='cancelled' WHERE workspace_id=${workspace} AND status='pending'`; await sql`UPDATE assistant.responsibilities SET state='cancelled' WHERE workspace_id=${workspace}`; await sql`UPDATE assistant.credentials SET revoked_at=now() WHERE workspace_id=${workspace}`; await sql.end(); }
