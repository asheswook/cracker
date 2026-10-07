/** @jsxImportSource ../../../apps/web/node_modules/react */
import { useState } from '../../../apps/web/node_modules/react';
import { createRoot } from '../../../apps/web/node_modules/react-dom/client';
import { LazyMotion, domAnimation } from '../../../apps/web/node_modules/motion/react';
import { TaskStatus } from '../../../apps/web/src/TaskStatus';
import { WorkPanel } from '../../../apps/web/src/WorkPanel';
import { Task, Vm } from '../../../apps/web/src/types';
import '../../../apps/web/src/styles.css';

const first = Task.parse({ id: '11111111-1111-4111-8111-111111111111', conversation_id: '33333333-3333-4333-8333-333333333333', objective: 'Synthetic task A', state: 'running', reason: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
const second = Task.parse({ ...first, id: '22222222-2222-4222-8222-222222222222', objective: 'Synthetic task B' });
const reason = '첨부 파일을 확인하지 못해 작업을 멈췄어요.\n파일을 다시 첨부한 뒤 요청을 보내 주세요.';
const unknown = Task.parse({ ...first, state: 'unknown', reason });
const vm = Vm.parse({ id: '44444444-4444-4444-8444-444444444444', name: 'Synthetic VM', last_seen_at: new Date().toISOString(), control_state: 'agent' });

function Harness() {
  const [task, setTask] = useState<Task | undefined>(first);
  const [mounted, setMounted] = useState(true);
  return <LazyMotion features={domAnimation}><main>
    <h1>Synthetic task status states</h1>
    <p id="selected">{task?.objective ?? 'No task'}</p>
    <nav><button id="task-a" onClick={() => setTask(first)}>Task A</button><button id="task-b" onClick={() => setTask(second)}>Task B</button><button id="no-task" onClick={() => setTask(undefined)}>No task</button><button id="done-task" onClick={() => setTask({ ...first, state: 'succeeded' })}>Completed A</button><button id="queued-task" onClick={() => setTask({ ...first, state: 'queued' })}>Queued A</button><button id="waiting-task" onClick={() => setTask({ ...first, state: 'waiting' })}>Waiting A</button><button id="mount" onClick={() => setMounted(value => !value)}>Toggle mounted</button></nav>
    <nav><button id="unknown-task" onClick={() => setTask(unknown)}>Unknown with reason</button><button id="failed-task" onClick={() => setTask({ ...unknown, state: 'failed' })}>Failed with reason</button><button id="blank-reason" onClick={() => setTask({ ...unknown, reason: '   ' })}>Blank reason</button><button id="refresh-reason" onClick={() => setTask({ ...unknown, reason: '연결을 다시 확인해 주세요.' })}>Refresh reason</button><button id="long-reason" onClick={() => setTask({ ...unknown, reason: reason.repeat(12) + '\nhttps://example.com/' + 'a'.repeat(180) + '\n마지막 안내: 작업 내용을 확인하세요.' })}>Long reason</button></nav>
    <section id="status">{mounted && <TaskStatus task={task} vm={vm} connected />}</section>
    <section id="work"><WorkPanel tasks={['running','queued','waiting','succeeded','unknown','failed'].map((state,index)=>Task.parse({...first,id:`55555555-5555-4555-8555-${String(index+1).padStart(12,'0')}`,state,objective:`Synthetic ${state}`}))} onOpen={()=>{}} onSource={()=>{}} /></section>
    <p>Real TaskStatus and WorkPanel; task data is synthetic.</p>
  </main></LazyMotion>;
}
const root = document.getElementById('root');
if (root) createRoot(root).render(<Harness />);
