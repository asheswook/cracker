import { SystemEvent } from './SystemEvent';
import type { Vm } from './types';
type Props = {
  readonly task: Readonly<{ id: string; state: string; reason: string | null }> | undefined;
  readonly vm?: Vm | undefined;
  readonly connected?: boolean;
};
export function TaskStatus({ task }: Props) {
  if (!task || (task.state !== 'failed' && task.state !== 'unknown')) return null;
  const reason = task.reason?.trim();
  return reason ? <SystemEvent>{reason}</SystemEvent> : null;
}
