import { useLayoutEffect, useState } from 'react';
import { AnimatePresence, m as Motion } from 'motion/react';
import type { Panel } from './AssistantNav';
import { useClient } from './store';
import { ErrorNotice } from './primitives';
import { InspectorHeader } from './InspectorHeader';
import { SchedulesPanel } from './SchedulesPanel';
import { Computer } from './Computer';
import { Settings } from './settings/Settings';
import { errorMessage } from './api';
import type { Id, Task } from './types';
import { WorkPanel } from './WorkPanel';
import { HistoryPanel } from './HistoryPanel';
import { MemoryPanel } from './MemoryPanel';
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
}: {
  panel: Panel;
  state: ReturnType<typeof useClient>;
  onClose: () => void;
  onComputer?: (() => void) | undefined;
  onTask: (task: Task, sourceMessageId?: Id, destination?: TaskDestination) => Promise<void>;
  onSource: (conversation: Id, message: Id) => Promise<void>;
  workSession: WorkSession;
  onArchive: (id: Id) => void;
}) {
  const [error, setError] = useState('');
  useLayoutEffect(() => {
    setError('');
  }, [panel]);
  return (
    <>
      <InspectorHeader panel={panel} onClose={onClose} />
      <div className="inspector-body">
        <AnimatePresence mode="wait" initial={false}>
          <Motion.div
            key={panel}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15, ease: [0.23, 1, 0.32, 1] }}
          >
            {error && <ErrorNotice>{error}</ErrorNotice>}
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
            {panel === 'schedules' && <SchedulesPanel state={state} onTask={task => { void onTask(task).catch(error => setError(errorMessage(error))); }} />}
            {panel === 'memory' && <MemoryPanel />}
          </Motion.div>
        </AnimatePresence>
      </div>
    </>
  );
}
