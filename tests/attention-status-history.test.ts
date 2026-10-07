import {afterAll,expect,test} from 'bun:test';
import {createNotificationFixtures} from './native-notifications-fixture.ts';
import {preserveAttentionReason,publishAttentionMessage} from '../packages/notifications/attention.ts';
import {messages} from '../services/control/repository/common.ts';

const {sql,fixture,cleanup}=createNotificationFixtures();
afterAll(cleanup);
const reason='Invalid provider response: invalid_tool_arguments; no calls from that response were executed';
const legacy='작업 상태를 확인할 수 없어요. 다시 진행하기 전에 확인이 필요해요.';

test('new failure event carries actual reason in visible history and keeps its notification anchor',async()=>{
 const f=await fixture();await f.register();
 const event={kind:'state',event_id:crypto.randomUUID(),run_id:f.run,state:'unknown',reason};
 expect((await f.post(event)).status).toBe(200);
 expect((await f.post(event)).status).toBe(200);
 const history=await messages(sql,f.workspace,f.conversation);
 expect(history).toHaveLength(1);
 expect(history[0]).toMatchObject({role:'system',task_id:null,content:reason,task_status:{task_id:f.task,run_id:f.run,state:'unknown',reason}});
 expect(await f.deliveries()).toHaveLength(1);
 const linked=await sql`SELECT message_id,run_id FROM notification_intents WHERE workspace_id=${f.workspace}`;
 expect(linked[0]).toMatchObject({message_id:history[0]?.id,run_id:f.run});
});

test('legacy error is represented at its original message and retained after resume clears task reason',async()=>{
 const f=await fixture();await f.register();
 await sql`UPDATE tasks SET state='unknown',reason=${reason} WHERE id=${f.task}`;
 await sql.begin(tx=>publishAttentionMessage(tx,f.workspace,{id:f.run,state:'unknown'}));
 await sql`UPDATE messages SET content=${legacy} WHERE workspace_id=${f.workspace}`;
 const before=await messages(sql,f.workspace,f.conversation);
 expect(before[0]).toMatchObject({content:legacy,task_status:{reason}});
 const deliveryCount=(await f.deliveries()).length;
 await sql.begin(tx=>preserveAttentionReason(tx,f.workspace,f.run));
 await sql`UPDATE tasks SET state='running',reason=NULL WHERE id=${f.task}`;
 const after=await messages(sql,f.workspace,f.conversation);
 expect(after[0]).toMatchObject({id:before[0]?.id,sequence:before[0]?.sequence,content:reason,task_id:null,task_status:{state:'unknown',reason}});
 expect(await f.deliveries()).toHaveLength(deliveryCount);
 await sql.begin(tx=>preserveAttentionReason(tx,f.workspace,f.run));
 expect(await messages(sql,f.workspace,f.conversation)).toEqual(after);
});

test('ordinary text and a different workspace cannot become or modify an attention message',async()=>{
 const f=await fixture(),other=await fixture();
 await sql`UPDATE tasks SET reason=${reason} WHERE id=${f.task}`;
 await sql.begin(tx=>publishAttentionMessage(tx,f.workspace,{id:f.run,state:'unknown'}));
 await sql`UPDATE messages SET content=${legacy} WHERE workspace_id=${f.workspace}`;
 await sql`INSERT INTO messages(workspace_id,conversation_id,role,content) VALUES(${f.workspace},${f.conversation},'user',${legacy})`;
 await sql.begin(tx=>preserveAttentionReason(tx,other.workspace,f.run));
 const history=await messages(sql,f.workspace,f.conversation);
 expect(history[0]?.content).toBe(legacy);
 expect(history[1]).toMatchObject({role:'user',content:legacy});
 expect(history[1]?.task_status).toBeUndefined();
 expect(await messages(sql,other.workspace,f.conversation)).toEqual([]);
 await sql.begin(tx=>preserveAttentionReason(tx,f.workspace,f.run));
 expect((await messages(sql,f.workspace,f.conversation))[1]?.content).toBe(legacy);
});
