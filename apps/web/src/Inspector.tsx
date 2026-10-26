import { AnimatePresence, m as Motion } from 'motion/react';
import type { Panel } from './AssistantNav';
import { useClient } from './store';
import { InspectorHeader } from './InspectorHeader';
import { SchedulesPanel } from './SchedulesPanel';
import { Computer } from './Computer';
import { Settings } from './settings/Settings';
import { Id } from './types';
import type { Task } from './types';
import { WorkPanel } from './WorkPanel';
import { HistoryPanel } from './HistoryPanel';
import { MemoryPanel } from './MemoryPanel';
import { AttentionPanel } from './AttentionPanel';
import type { WorkSession } from './work-session';
import type { TaskDestination } from './useWorkNavigation';
export function Inspector({
  panel,
  state,
  onClose,
  onComputer,
  onTask,
  onArchive,
  onSource,
  workSession,
  embedded = false,
}: {
  panel: Panel;
  state: ReturnType<typeof useClient>;
  onClose: () => void;
  onComputer?: (() => void) | undefined;
  onTask: (task: Task, sourceMessageId?: Id, destination?: TaskDestination) => Promise<void>;
  onSource: (conversation: Id, message: Id) => Promise<void>;
  workSession: WorkSession;
  onArchive: (id: Id) => void;
  embedded?: boolean;
}) {
  return (
    <>
      {!embedded && <InspectorHeader panel={panel} onClose={onClose} />}
      <div className="inspector-body">
        <AnimatePresence mode="wait" initial={false}>
          <Motion.div
            key={panel}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15, ease: [0.23, 1, 0.32, 1] }}
          >
            {panel === 'settings' && <Settings vms={state.vms} connected={state.connected} onComputer={onComputer} />}
            {panel === 'computer' && <Computer vms={state.vms} connected={state.connected} />}{' '}
            {panel === 'tasks' && (
              <WorkPanel
                key={state.workspace}
                tasks={state.tasks}
                session={workSession}
                onOpen={onTask}
                onSource={onSource}
              />
            )}
            {panel === 'history' && (
              <HistoryPanel
                conversations={state.conversations}
                assistantId={state.assistantId}
                onOpen={onArchive}
              />
            )}
            {panel === 'schedules' && <SchedulesPanel state={state} onSource={onSource} />}
            {panel === 'memory' && <MemoryPanel />}
            {panel === 'attention' && <AttentionPanel onOpen={(conversation, message, task) => {
              // A task row opens through its navigation (a run that failed before writing anything opens at its ask).
              if (task) void onTask({ id: Id.parse(task), conversation_id: Id.parse(conversation) } as Task, undefined, 'reply');
              else if (message) void onSource(Id.parse(conversation), Id.parse(message));
            }} />}
          </Motion.div>
        </AnimatePresence>
      </div>
    </>
  );
}
