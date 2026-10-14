import { useEffect, useRef, useState } from 'react';
import type { Id, Message, ReplyComposing, ReplyHandoff, Task } from './types';
import './message-motion.css';

type VisibleReply = {
  key: string;
  sourceKey: string;
  conversation: Id;
  task: Id;
  input: Id | null;
  previousReply: Id | null;
};
const handoffLimit = 400;
function replySourceKey(selected: Id | null, reply: ReplyComposing | ReplyHandoff) {
  return JSON.stringify([
    selected, reply.task_id, reply.run_id, reply.inference_id, reply.generation,
    reply.response_id, reply.input_message_ids,
  ]);
}
function replyKey(selected: Id | null, reply: ReplyComposing | ReplyHandoff) {
  return JSON.stringify([replySourceKey(selected, reply), reply.item_id]);
}

export function WorkingBubble({
  composing,
  replyHandoff,
  task,
  selected,
  connected,
  name,
  latestUser,
  pending,
  arrivedReply,
  latestReply,
}: {
  readonly composing: ReplyComposing | null;
  readonly replyHandoff?: ReplyHandoff | null | undefined;
  readonly task: Task | undefined;
  readonly selected: Id | null;
  readonly connected: boolean;
  readonly name: string;
  readonly latestUser: Message | undefined;
  readonly pending: boolean;
  readonly arrivedReply: boolean;
  readonly latestReply: Id | null;
}) {
  const [now, setNow] = useState(Date.now);
  const [visible, setVisible] = useState<VisibleReply | null>(null);
  const [exiting, setExiting] = useState<VisibleReply | null>(null);
  const latestReplyRef = useRef(latestReply);
  const taskId = task?.id;
  const inputId = latestUser?.id ?? null;
  useEffect(() => {
    latestReplyRef.current = latestReply;
  }, [latestReply]);
  useEffect(() => {
    setNow(Date.now());
    if (!composing) return;
    const timer = setTimeout(
      () => setNow(Date.now()),
      Math.max(0, Date.parse(composing.expires_at) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [composing]);
  useEffect(() => {
    if (!replyHandoff) return;
    const timer = setTimeout(
      () => setNow(Date.now()),
      Math.max(0, Date.parse(replyHandoff.expires_at) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [replyHandoff]);
  // A message sent while the assistant is mid-task steers that task; it is read at the next step, so the
  // assistant keeps working and the indicator must stay instead of vanishing until the message is read.
  const steering = Boolean(
    latestUser && task?.state === 'running' && composing && composing.task_id === task.id &&
      !composing.input_message_ids.includes(latestUser.id),
  );
  const contextValid =
    connected &&
    !pending &&
    task?.conversation_id === selected &&
    (task.state === 'running' || task.state === 'succeeded') &&
    (!latestUser || (latestUser.conversation_id === selected && (Boolean(latestUser.read_at) || steering)));
  const active = Boolean(
    contextValid &&
      task?.state === 'running' &&
      composing &&
      task.id === composing.task_id &&
      (!latestUser || steering || composing.input_message_ids.includes(latestUser.id)) &&
      Date.parse(composing.expires_at) > Math.max(now, Date.now()),
  );
  const key =
    active && composing
      ? replyKey(selected, composing)
      : null;
  const sourceKey = active && composing ? replySourceKey(selected, composing) : null;
  useEffect(() => {
    if (!key || !sourceKey || !selected || !taskId) return;
    if (visible?.sourceKey === sourceKey) {
      if (visible.key !== key) setVisible({ ...visible, key, previousReply: latestReplyRef.current });
      return;
    }
    const previousReply = latestReplyRef.current;
    const timer = setTimeout(
      () =>
        setVisible({
          key,
          sourceKey,
          conversation: selected,
          task: taskId,
          input: inputId,
          previousReply,
        }),
      120,
    );
    return () => clearTimeout(timer);
  }, [key, sourceKey, selected, taskId, inputId, visible?.sourceKey]);
  const sameContext = (reply: VisibleReply | null) =>
    Boolean(
      reply &&
        contextValid &&
        reply.conversation === selected &&
        reply.task === task?.id &&
        (reply.input === (latestUser?.id ?? null) || steering),
    );
  const live = active && visible?.sourceKey === sourceKey;
  const replaced = Boolean(
    visible &&
      sameContext(visible) &&
      (arrivedReply || (latestReply !== null && latestReply !== visible.previousReply)),
  );
  const holding = Boolean(
    visible &&
      sameContext(visible) &&
      !live &&
      !replaced &&
      (replyHandoff === undefined || (
        replyHandoff !== null &&
        Date.parse(replyHandoff.expires_at) > Math.max(now, Date.now()) &&
        visible.key === replyKey(selected, replyHandoff) &&
        (!active || key === visible.key)
      )) &&
      (!composing ||
        (composing.task_id === visible.task &&
          (!latestUser || composing.input_message_ids.includes(latestUser.id)))),
  );
  const handoff = !live && replaced ? visible : null;
  useEffect(() => {
    if (!visible) return;
    if (!sameContext(visible) || (!live && !holding && !handoff)) {
      setVisible(null);
      return;
    }
    if (handoff) {
      setExiting(handoff);
      setVisible(null);
      return;
    }
    if (!holding || replyHandoff !== undefined) return;
    const timer = setTimeout(
      () => setVisible((current) => (current === visible ? null : current)),
      handoffLimit,
    );
    return () => clearTimeout(timer);
  }, [visible, contextValid, selected, task?.id, latestUser?.id, live, holding, handoff, replyHandoff]);
  useEffect(() => {
    if (!exiting) return;
    if (!sameContext(exiting) || active) {
      setExiting(null);
      return;
    }
    const timer = setTimeout(() => setExiting(null), 180);
    return () => clearTimeout(timer);
  }, [exiting, contextValid, selected, task?.id, latestUser?.id, active]);
  const visualExit = !active && sameContext(handoff ?? exiting);
  return (
    <div
      className="working-message"
      data-active={live}
      data-holding={holding}
      data-exiting={visualExit}
      data-cleared={!live && !holding && !visualExit}
      aria-hidden={!live}
    >
      <div className="working-line">
        <div
          className="typing-bubble"
          role={live ? 'status' : undefined}
          aria-label={live ? `${name} 답변 작성 중` : undefined}
        >
          {live && (
            <>
              <i />
              <i />
              <i />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
