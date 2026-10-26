import { useIndependentFooter } from './useIndependentFooter';
import { useNativeRootReader } from './useNativeRootReader';
import { MessageList } from './MessageList';
import { LoadingSkeleton } from './LoadingSkeleton';
import {WorkingBubble} from './WorkingBubble';
import { BackgroundWork } from './BackgroundWork';
import { PersonaOnboarding } from './settings/PersonaOnboarding';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentProps } from 'react';
import { useReducedMotion } from './useReducedMotion';
import { newTailMessageKeys } from './messageArrivals';
import type { MessageArrivalSnapshot } from './messageArrivals';
import { ArrowUp, Square } from 'lucide-react';
import { stoppable, useStopConfirm } from './task-stop';
import './composer-stop.css';
import { LatestButton } from './LatestButton';
import { useComposerPaste } from './useComposerPaste';
import { AttachmentPicker, DraftAttachments, draftAttachmentViews } from './Attachments';
import { useAttachmentDrafts, removeDrafts, uploadDraft } from './attachmentDrafts';
import { useComposerDraft } from './composerDrafts';
import { composerTheme, useNativeComposer } from './native-composer-hook';
import { COMPOSER_TEXT_LIMIT, type ComposerDraft } from './native-composer';
import { isNativeApp, nativeNotificationState, NativeBridgeError } from './native-bridge';
import type { Message, Pending, Id, Task, Vm,ReplyComposing, ReplyHandoff } from './types';
import { client } from './store';
import { IconButton, ErrorNotice, Button } from './primitives';
type ReadingPosition = Readonly<{
  top: number;
  message: string | null;
  offset: number;
  anchored: boolean;
  cursor: number | null;
  unread: boolean;
}>;
export const Chat = memo(function Chat({
  messages,
  syncedCursor,
  outbox,
  selected,
  error,
  task,
  tasks,
  connected,
  assistantName,
  replyComposing=null,
  replyHandoff,
  readOnly = false,
  composerObscured = false,
  focusTask = null,
  focusMessage = null,
  timeControlRoot = null,
  background,
  onOpenTasks,
  working = false,
}: {
  messages: Message[];
  syncedCursor: number | null;
  outbox: Pending[];
  selected: Id | null;
  error: string;
  task: Task | undefined;
  vm: Vm | undefined;
  connected: boolean;
  assistantName: string;
  replyComposing?:ReplyComposing|null;
  replyHandoff?: ReplyHandoff | null | undefined;
  readOnly?: boolean;
  composerObscured?: boolean;
  focusTask?: string | null;
  focusMessage?: string | null;
  timeControlRoot?: HTMLElement | null;
  background?: ComponentProps<typeof BackgroundWork>['background'];
  onOpenTasks?: () => void;
  tasks?: readonly Task[];
  /** The assistant is working on a request in this conversation: an empty composer offers 멈추기 instead of 보내기. */
  working?: boolean;
}) {
  const workspace = client.snapshot().workspace;
  const objectives = useMemo(() => new Map((tasks ?? []).map(item => [item.id, item.objective])), [tasks]);
  const files = useAttachmentDrafts(client.snapshot().workspace, selected);
  const [addingFiles, setAddingFiles] = useState(false);
  const [nativeMac, setNativeMac] = useState(false);
  const [finePointer] = useState(() => typeof matchMedia === 'function' && matchMedia('(hover: hover) and (pointer: fine)').matches);
  const enterSends = nativeMac || (finePointer && !isNativeApp());
  useEffect(() => {
    let alive = true;
    if (isNativeApp()) void nativeNotificationState()
      .then(state => { if (alive) setNativeMac(state.platform === 'macos'); })
      .catch((error: unknown) => {
        if (!(error instanceof NativeBridgeError)) throw error;
        if (alive) setNativeMac(false);
      });
    return () => { alive = false; };
  }, []);
  const filesReady = !addingFiles && !files.loading && files.drafts.every((d) => Boolean(d.artifact));
  const savedDraft = useComposerDraft(client.snapshot().workspace, selected);
  const draft = savedDraft.text;
  const setDraft = savedDraft.setText;
  const { paste, drop, dragging } = useComposerPaste(savedDraft.scope, !readOnly && Boolean(selected), addingFiles, setAddingFiles);
  const [sending, setSending] = useState<ReadonlySet<string>>(() => new Set());
  const busy = sending.has(savedDraft.scope);
  // The running request of this conversation, if there is one to stop (foreground work, not the assistant's own runs).
  const stopTarget = working && task && task.conversation_id === selected && task.lane !== 'background' && stoppable(task) ? task : null;
  const stop = useStopConfirm(stopTarget?.id ?? null);
  const sendingNow = useRef(new Set<string>());
  const attachmentInput = useRef<HTMLInputElement>(null);
  const [sendErrors, setSendErrors] = useState<Readonly<Record<string, string>>>({});
  const sendError = sendErrors[savedDraft.scope] ?? '';
  const setSendError = (message: string) =>
    setSendErrors((errors) => ({ ...errors, [savedDraft.scope]: message }));
  const [newContent, setNewContent] = useState(false);
  const feed = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const footer = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = footer.current;
    const section = node?.parentElement;
    if (!node || !section) return;
    const observer = new ResizeObserver(() => section.style.setProperty('--chat-footer-height', `${Math.ceil(node.offsetHeight)}px`));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const anchored = useRef(true);
  const returningToEnd = useRef(false);
  const lastUserScroll = useRef(0);
  const touchScroll = useRef<{ identifier: number; x: number; y: number; top: number; height: number; content: number; vertical: boolean } | null>(null);
  const feedGeometry = useRef({ width: 0, height: 0, content: 0 });
  const previousCount = useRef(0);
  const previousMessages = useRef<MessageArrivalSnapshot | null>(null);
  const previousSelected = useRef<Id | null>(null);
  const positions = useMemo(() => new Map<Id, ReadingPosition>(), [workspace]);
  const previousPositions = useRef(positions);
  const restoringPosition = useRef<ReadingPosition | null>(null);
  const focusedTask = useRef<string | null>(null);
  const focusedMessageElement = useRef<HTMLElement | null>(null);
  const holdSourcePosition = useRef(false);
  const composing = useRef(false);
  const resizedInput = useRef<HTMLTextAreaElement | null>(null);
  const resizeAnimation = useRef<Animation | null>(null);
  const reduced = useReducedMotion();
  const pending = useMemo(() => outbox.filter((m) => m.conversation_id === selected), [outbox, selected]);
  const count = messages.length + pending.length;
  const arrivals = newTailMessageKeys(previousMessages.current, { selected, syncedCursor, messages, pending });
  const replyContextMessages = useMemo(() => [...messages].reverse(), [messages]);
  const latestUser = useMemo(() => replyContextMessages.find(message => message.role === 'user'), [replyContextMessages]);
  const latestReply = useMemo(() => replyContextMessages.find(message => message.role === 'assistant' && message.task_id === task?.id && message.sequence > (latestUser?.sequence ?? 0))?.id ?? null,
    [messages, task?.id, latestUser?.sequence]);
  const historyUnresolved = count === 0 && syncedCursor === null;
  const reader = useNativeRootReader({ workspace, scope: savedDraft.scope, selected: Boolean(workspace && selected),
    hydrated: syncedCursor !== null, suspended: composerObscured, cursor: syncedCursor,
    sourceKey: focusMessage ? `message:${focusMessage}` : focusTask ? `task:${focusTask}` : '',
    sourceId: focusMessage ?? messages.find(message => message.task_id === focusTask)?.id ?? null, arrived: arrivals.size > 0,
  }, feed);
  const ROOT_SCROLL_TRIAL = reader.active;
  const composerError = sendError || savedDraft.error || files.error || (historyUnresolved ? '' : error);
  useLayoutEffect(() => {
    if (!reader.fallback) return;
    positions.clear(); restoringPosition.current = null; holdSourcePosition.current = false;
    touchScroll.current = null; returningToEnd.current = false; anchored.current = true;
    previousSelected.current = null;
    setNewContent(false);
    const node = feed.current;
    node?.scrollTo({ top: node.scrollHeight, behavior: 'instant' });
  }, [reader.fallback, positions]);
  const scrollEnd = useCallback(
    (smooth: boolean) => {
      if (ROOT_SCROLL_TRIAL) { void reader.latest(); return; }
      const node = feed.current;
      if (node && !touchScroll.current)
        node.scrollTo({ top: node.scrollHeight, behavior: (smooth || returningToEnd.current) && !reduced ? 'smooth' : 'instant' });
      setNewContent(false);
    },
    [reduced, ROOT_SCROLL_TRIAL, reader.latest],
  );
  const rememberPosition = useCallback(() => {
    if (ROOT_SCROLL_TRIAL) return;
    const node = feed.current;
    if (!node || !selected || historyUnresolved || restoringPosition.current || touchScroll.current) return;
    const top = node.getBoundingClientRect().top;
    const items = node.querySelectorAll<HTMLElement>('.message[id]');
    let start = 0, end = items.length;
    while (start < end) {
      const middle = Math.floor((start + end) / 2);
      const item = items.item(middle);
      if (item.getBoundingClientRect().bottom <= top) start = middle + 1;
      else end = middle;
    }
    const message = items.item(start);
    positions.delete(selected);
    positions.set(selected, {
      top: node.scrollTop, message: message?.id ?? null,
      offset: message ? message.getBoundingClientRect().top - top : 0,
      anchored: anchored.current, cursor: syncedCursor, unread: newContent,
    });
    const oldest = positions.keys().next().value;
    if (positions.size > 20 && oldest) positions.delete(oldest);
  }, [selected, historyUnresolved, positions, syncedCursor, newContent, ROOT_SCROLL_TRIAL]);
  const restorePosition = useCallback((position: ReadingPosition) => {
    if (ROOT_SCROLL_TRIAL) return;
    const node = feed.current;
    if (!node || touchScroll.current) return;
    const message = position.message ? document.getElementById(position.message) : null;
    node.scrollTo({
      top: message && node.contains(message)
        ? node.scrollTop + message.getBoundingClientRect().top - node.getBoundingClientRect().top - position.offset
        : position.top,
      behavior: 'instant',
    });
  }, [ROOT_SCROLL_TRIAL]);
  useLayoutEffect(() => {
    const current = { selected, syncedCursor, messages, pending };
    if (ROOT_SCROLL_TRIAL) {
      previousSelected.current = selected; previousPositions.current = positions;
      previousCount.current = count; previousMessages.current = current;
      return;
    }
    const arrived = newTailMessageKeys(previousMessages.current, current).size > 0;
    if (previousSelected.current !== selected || previousPositions.current !== positions) {
      previousPositions.current = positions;
      previousSelected.current = selected;
      touchScroll.current = null;
      returningToEnd.current = false;
      const saved = selected ? positions.get(selected) : undefined;
      restoringPosition.current = saved && !saved.anchored && !focusTask && !focusMessage ? saved : null;
      anchored.current = !restoringPosition.current && !focusTask && !focusMessage;
      setNewContent(false);
      if (anchored.current) scrollEnd(false);
    } else if (count > previousCount.current || arrived) {
      if (anchored.current) scrollEnd(false);
      else if (arrived) setNewContent(true);
    }
    if (focusTask || focusMessage) restoringPosition.current = null;
    const restoring = restoringPosition.current;
    if (restoring && syncedCursor !== null) {
      restorePosition(restoring);
      setNewContent(restoring.unread || (restoring.cursor !== null && syncedCursor > restoring.cursor));
      restoringPosition.current = null;
    } else if (!restoring && !anchored.current && !focusTask && !focusMessage && !historyUnresolved) {
      const saved = selected ? positions.get(selected) : undefined;
      if (saved) restorePosition(saved);
    }
    rememberPosition();
    previousCount.current = count;
    previousMessages.current = current;
  }, [count, selected, syncedCursor, messages, pending, scrollEnd, positions, focusTask, focusMessage, historyUnresolved, restorePosition, rememberPosition, ROOT_SCROLL_TRIAL]);
  useEffect(() => {
    const node = feed.current;
    const content = node?.firstElementChild;
    if (!node || !content) return;
    if (ROOT_SCROLL_TRIAL) return;
    const observer = new ResizeObserver(() => {
      // A programmatic scroll during momentum stops the fling; let the reader keep control while it is moving.
      if (touchScroll.current || (!anchored.current && performance.now() - lastUserScroll.current < 400)) {
        feedGeometry.current = { width: node.clientWidth, height: node.clientHeight, content: node.scrollHeight };
        return;
      }
      if (holdSourcePosition.current && focusedMessageElement.current?.isConnected)
        focusedMessageElement.current.scrollIntoView({ block: 'start', behavior: 'instant' });
      else if (anchored.current && count > 0) scrollEnd(false);
      else if (!restoringPosition.current && !focusTask && !focusMessage) {
        const saved = selected ? positions.get(selected) : undefined;
        if (saved) restorePosition(saved);
      }
      rememberPosition();
      feedGeometry.current = { width: node.clientWidth, height: node.clientHeight, content: node.scrollHeight };
    });
    observer.observe(content);
    observer.observe(node);
    return () => observer.disconnect();
  }, [count, selected, scrollEnd, positions, focusTask, focusMessage, restorePosition, rememberPosition, ROOT_SCROLL_TRIAL]);
  useLayoutEffect(() => {
    if (ROOT_SCROLL_TRIAL) return;
    if (!focusTask && !focusMessage) {
      focusedTask.current = null;
      focusedMessageElement.current = null;
      holdSourcePosition.current = false;
      return;
    }
    const target = `${selected}:${focusMessage ?? focusTask}`;
    const message = focusMessage
      ? messages.find((item) => item.id === focusMessage)
      : messages.find((item) => item.task_id === focusTask);
    const node = message ? document.getElementById(`message-${message.id}`) : null;
    if (!node) return;
    focusedMessageElement.current = node;
    if (focusedTask.current === target) {
      if (holdSourcePosition.current && !touchScroll.current) node.scrollIntoView({ block: 'start', behavior: 'instant' });
      return;
    }
    focusedTask.current = target;
    returningToEnd.current = false;
    holdSourcePosition.current = Boolean(focusMessage);
    anchored.current = false;
    node.scrollIntoView({ block: 'start', behavior: 'instant' });
    node.classList.add('task-highlight');
    const timer = setTimeout(() => node.classList.remove('task-highlight'), 2400);
    return () => {
      clearTimeout(timer);
      node.classList.remove('task-highlight');
    };
  }, [focusTask, focusMessage, selected, messages, ROOT_SCROLL_TRIAL]);
  useEffect(() => {
    const el = input.current;
    if (el) {
      const resize = () => {
        const previous = el.getBoundingClientRect().height;
        resizeAnimation.current?.cancel();
        el.style.height = 'auto';
        const height = Math.min(el.scrollHeight, 180);
        el.style.height = `${height}px`;
        if (!reduced && resizedInput.current === el && previous !== height)
          resizeAnimation.current = el.animate([{ height: `${previous}px` }, { height: `${height}px` }], {
            duration: 220,
            easing: 'cubic-bezier(0.2, 0, 0, 1)',
          });
        resizedInput.current = el;
      };
      resize();
      let width = el.clientWidth;
      const observer = new ResizeObserver(() => {
        if (width === el.clientWidth) return;
        width = el.clientWidth;
        resize();
      });
      observer.observe(el);
      return () => observer.disconnect();
    }
  }, [draft, reduced]);
  const send = async (snapshot: ComposerDraft = savedDraft.readCurrent()) => {
    if (
      readOnly ||
      !selected ||
      (!snapshot.text.trim() && !files.drafts.length) ||
      !filesReady ||
      sendingNow.current.has(savedDraft.scope) ||
      snapshot.text.length > COMPOSER_TEXT_LIMIT ||
      composing.current
    )
      return false;
    const content = snapshot.text;
    const version = snapshot.version;
    const scope = savedDraft.scope;
    sendingNow.current.add(scope);
    setSending((pending) => new Set([...pending, scope]));
    setSendError('');
    if (ROOT_SCROLL_TRIAL) void reader.latest();
    anchored.current = true;
    restoringPosition.current = null;
    holdSourcePosition.current = false;
    try {
      await client.send(
        content,
        files.drafts.flatMap((d) => (d.artifact ? [d.artifact] : [])),
      );
      savedDraft.clearIfUnchanged(version);
      await removeDrafts(files.drafts.map((d) => d.id)).catch(() =>
        setSendError('메시지를 전송 목록에 저장했지만 첨부 초안을 정리하지 못했어요.'),
      );
      if (client.snapshot().selected === selected && !nativeComposer.active) input.current?.focus();
      return true;
    } catch (e) {
      setSendError(
        e instanceof Error ? '메시지를 저장하지 못했어요. 다시 시도해 주세요.' : '전송 오류가 발생했어요.',
      );
      return false;
    } finally {
      sendingNow.current.delete(scope);
      setSending((pending) => new Set([...pending].filter((value) => value !== scope)));
    }
  };
  const nativeComposer = useNativeComposer(workspace, {
    scope: savedDraft.scope, read: savedDraft.readCurrent, write: savedDraft.setText, send,
    attach: () => attachmentInput.current?.click(),
    state: () => ({
      visible: !readOnly && !composerObscured && Boolean(selected), editable: !readOnly && Boolean(selected),
      sendEnabled: !readOnly && Boolean(selected) && filesReady && !sendingNow.current.has(savedDraft.scope)
        && Boolean(savedDraft.readCurrent().text.trim() || files.drafts.length),
      attachEnabled: !readOnly && Boolean(selected) && !sendingNow.current.has(savedDraft.scope) && !addingFiles && files.drafts.length < 8,
      placeholder: `${assistantName}에게 메시지 보내기`, error: '',
      theme: composerTheme(feed.current?.closest('.main-surface') ?? null),
    }),
  });

  const focusEditor = () => { if (!nativeComposer.focus()) input.current?.focus(); };
  const independentFooter = useIndependentFooter({ scope: savedDraft.scope,
    visible: ROOT_SCROLL_TRIAL && !composerObscured && Boolean(selected),
    props: { readOnly, latest: ROOT_SCROLL_TRIAL ? reader.awayFromLatest || reader.unread : newContent, error: '',
      storage: { failed: files.storageFailed, retrying: files.retrying }, task: null,
      drafts: draftAttachmentViews(files.drafts, files.progress) },
  }, async (action, draftId) => {
    if (action === 'latest') return await reader.latest() ? { ok: true } : { ok: false, error: 'reader_busy' };
    if (action === 'task-details') {
      return { ok: false, error: 'action_unavailable' };
    }
    if (readOnly) return { ok: false, error: 'read_only' };
    if (action === 'retry-storage') {
      if (!files.storageFailed || files.retrying) return { ok: false, error: 'action_unavailable' };
      files.retry(); return { ok: true };
    }
    const target = files.drafts.find(item => item.id === draftId);
    if (!target || files.progress(target.id) !== undefined || (action === 'retry-upload' && target.artifact)) return { ok: false, error: 'action_unavailable' };
    try {
      if (action === 'retry-upload') await uploadDraft(target); else await removeDrafts([target.id]);
      return { ok: true };
    } catch {
      setSendError(action === 'retry-upload' ? '파일 상태를 저장하지 못했어요.' : '첨부 제거를 저장하지 못했어요.');
      return { ok: false, error: 'action_failed' };
    }
  });
  const finishTouchScroll = () => {
    if (ROOT_SCROLL_TRIAL) return;
    const gesture = touchScroll.current;
    touchScroll.current = null;
    const node = feed.current;
    if (gesture && node && (gesture.vertical || Math.abs(node.scrollTop - gesture.top) > 1)) {
      returningToEnd.current = false;
      anchored.current = node.scrollHeight - node.scrollTop - node.clientHeight <= 1;
    }
    if (
      gesture && node && !gesture.vertical && anchored.current && !holdSourcePosition.current &&
      (returningToEnd.current || gesture.content !== node.scrollHeight || gesture.height !== node.clientHeight) &&
      node.scrollHeight - node.scrollTop - node.clientHeight > 1
    ) scrollEnd(false);
    rememberPosition();
  };
  return (
    <section className={`chat${nativeComposer.active ? ' native-composer' : ''}`} aria-label="대화" data-dropping={dragging || undefined} {...drop}>
      <div
        className="message-feed"
        ref={feed}
        onWheel={(event) => {
          if (ROOT_SCROLL_TRIAL) return;
          holdSourcePosition.current = false;
          restoringPosition.current = null;
          if (event.deltaY && returningToEnd.current) {
            returningToEnd.current = false;
            anchored.current = false;
            event.currentTarget.scrollTo({ top: event.currentTarget.scrollTop, behavior: 'instant' });
          }
          if (event.deltaY < 0) anchored.current = false;
        }}
        onPointerDown={(event) => {
          if (ROOT_SCROLL_TRIAL) return;
          if (event.pointerType === 'touch') return;
          holdSourcePosition.current = false;
          const node = event.currentTarget;
          if (event.clientX >= node.getBoundingClientRect().left + node.clientWidth) {
            returningToEnd.current = false;
            anchored.current = false;
          }
        }}
        onTouchStart={(event) => {
          if (ROOT_SCROLL_TRIAL) return;
          const touch = event.touches[0];
          if (touch && !touchScroll.current) {
            if (returningToEnd.current) event.currentTarget.scrollTo({ top: event.currentTarget.scrollTop, behavior: 'instant' });
            touchScroll.current = {
              identifier: touch.identifier, x: touch.clientX, y: touch.clientY,
              top: event.currentTarget.scrollTop, height: event.currentTarget.clientHeight,
              content: event.currentTarget.scrollHeight, vertical: false,
            };
          }
        }}
        onTouchMove={(event) => {
          if (ROOT_SCROLL_TRIAL) return;
          const gesture = touchScroll.current;
          if (!gesture || gesture.vertical || event.defaultPrevented) return;
          const touch = Array.from(event.touches).find(item => item.identifier === gesture.identifier);
          if (!touch) return;
          const dx = Math.abs(touch.clientX - gesture.x);
          const dy = Math.abs(touch.clientY - gesture.y);
          if (dy >= 10 && dy >= dx) {
            gesture.vertical = true;
            restoringPosition.current = null;
            returningToEnd.current = false;
            holdSourcePosition.current = false;
            anchored.current = false;
          }
        }}
        onTouchEnd={(event) => {
          if (ROOT_SCROLL_TRIAL) return;
          if (event.touches.length) return;
          finishTouchScroll();
        }}
        onTouchCancel={finishTouchScroll}
        onKeyDown={(event) => {
          if (ROOT_SCROLL_TRIAL) return;
          holdSourcePosition.current = false;
          restoringPosition.current = null;
          if (['ArrowUp', 'PageUp', 'Home'].includes(event.key)) {
            returningToEnd.current = false;
            anchored.current = false;
            event.currentTarget.scrollTo({ top: event.currentTarget.scrollTop, behavior: 'instant' });
          }
        }}
        onScroll={() => {
          if (ROOT_SCROLL_TRIAL) return;
          const el = feed.current;
          if (!el) return;
          lastUserScroll.current = performance.now();
          if (touchScroll.current) return;
          if (returningToEnd.current) {
            if (el.scrollHeight - el.scrollTop - el.clientHeight <= 1) returningToEnd.current = false;
            return;
          }
          const previous = feedGeometry.current;
          const resized = previous.width !== el.clientWidth || previous.height !== el.clientHeight || previous.content !== el.scrollHeight;
          if (restoringPosition.current) return;
          if (!anchored.current || !resized) anchored.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
          if (!resized) { rememberPosition(); }
        }}
      >
        <div className="feed-motion-clip">
        <div className="feed-content">
          {count === 0 && !historyUnresolved && !readOnly && connected && workspace && (
            <div className="onboarding-container">
              <PersonaOnboarding workspace={workspace} />
            </div>
          )}
          {historyUnresolved ? (
            <div className="message-column">
                {error ? (
                  <div className="empty-state">
                    <ErrorNotice>{error}</ErrorNotice>
                    <Button onClick={() => void client.refresh()}>다시 시도</Button>
                  </div>
                ) : (
                  <LoadingSkeleton layout="conversation" label="대화를 불러오는 중…" />
                )}
            </div>
          ) : count === 0 ? (
            <div className="welcome">
              <h1>{readOnly ? '이 대화에는 메시지가 없어요' : `${assistantName}에게 무엇이든 맡겨 보세요`}</h1>
              {!readOnly && <p>조사, 정리, 반복 업무까지. 하던 일은 맡긴 일에서 이어서 볼 수 있어요.</p>}
            </div>
          ) : (
            <MessageList
              messages={messages}
              pending={pending}
              reduced={reduced}
              arrivals={arrivals}
              assistantName={assistantName}
              timeControlRoot={timeControlRoot}
              keep={focusMessage ?? focusTask ?? null}
              objectives={objectives}
            />
          )}
          {!readOnly && <WorkingBubble
            selected={selected}
            latestReply={latestReply}
            arrivedReply={messages.some(message => message.role === 'assistant' && message.task_id === task?.id && arrivals.has(message.client_message_id ?? message.id))}
            composing={replyComposing}
            replyHandoff={replyHandoff}
            task={task}
            connected={connected}
            name={assistantName}
            latestUser={latestUser}
            pending={pending.length > 0}
          />}
        </div>
        </div>
      </div>
      <div ref={footer} className={`chat-footer${independentFooter.active ? ' independent-footer-active' : ''}`}>
        {independentFooter.error && <ErrorNotice>{independentFooter.error}</ErrorNotice>}
        {(ROOT_SCROLL_TRIAL ? reader.awayFromLatest || reader.unread : newContent) && (
          <LatestButton onLatest={() => {
            holdSourcePosition.current = false;
            restoringPosition.current = null;
            returningToEnd.current = true;
            anchored.current = true;
            scrollEnd(true);
          }} />
        )}
        {!readOnly && onOpenTasks && <BackgroundWork background={background} onOpenTasks={onOpenTasks} />}
        {readOnly ? (
          <p className="archive-footnote">
            보관된 대화예요. 이어서 말하려면 지금 대화로 돌아가세요.
          </p>
        ) : (
          <div className="composer-region">
            {composerError && <ErrorNotice>{composerError}</ErrorNotice>}
            {files.storageFailed && (
              <div className="attachment-store-recovery" role="status">
                <span>보관된 첨부 파일을 확인하지 못했어요.</span>
                <Button type="button" busy={files.retrying} onClick={() => {
                  files.retry();
                  focusEditor();
                }}>첨부 다시 확인</Button>
              </div>
            )}
            <form
              className="composer messenger-composer"
              onSubmit={(e) => {
                e.preventDefault();
                void send();
              }}
            >
              <DraftAttachments drafts={files.drafts} progress={files.progress} onError={setSendError} />
              <div className="composer-input-row">
                <AttachmentPicker
                  inputRef={attachmentInput}
                  disabled={!selected || busy || addingFiles || files.drafts.length >= 8}
                  onError={setSendError}
                  onBusy={setAddingFiles}
                />
                <textarea
                  ref={input}
                  disabled={!selected}
                  aria-label="메시지"
                  aria-description={enterSends
                    ? 'Enter로 보내고 Shift+Enter로 줄을 바꿔요. 작업 중에도 보낼 수 있어요.'
                    : '전송 버튼으로 보내요. 작업 중에도 보낼 수 있어요.'}
                  enterKeyHint={enterSends ? 'send' : 'enter'}
                  placeholder={`${assistantName}에게 메시지 보내기`}
                  value={draft}
                  rows={1}
                  onChange={(e) => setDraft(e.target.value)}
                  onPaste={paste}
                  onKeyDown={(event) => {
                    if (!enterSends || event.defaultPrevented || event.key !== 'Enter' || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey
                      || composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
                    event.preventDefault();
                    if (!event.repeat) void send();
                  }}
                  onCompositionStart={() => {
                    composing.current = true;
                  }}
                  onCompositionEnd={() => {
                    composing.current = false;
                  }}
                />
                {stopTarget && !draft.trim() && !files.drafts.length && !stop.stopping ? (
                  // Empty composer while working: the send button becomes 멈추기 (tap once to ask, again to stop).
                  <IconButton
                    type="button"
                    label={stop.asking ? '정말 멈추기' : '멈추기'}
                    className="send-button stop-button"
                    data-asking={stop.asking || undefined}
                    aria-describedby={stop.asking ? 'composer-stop-ask' : undefined}
                    disabled={stop.busy}
                    onClick={() => { if (stop.asking) void stop.confirm(); else stop.ask(); }}
                  >
                    <Square size={14} fill="currentColor" aria-hidden="true" />
                  </IconButton>
                ) : (
                  <IconButton
                    type="submit"
                    label="메시지 보내기"
                    className="send-button"
                    disabled={!selected || busy || !filesReady || draft.length > COMPOSER_TEXT_LIMIT || (!draft.trim() && !files.drafts.length)}
                  >
                    <ArrowUp size={20} />
                  </IconButton>
                )}
              </div>
            </form>
            {stopTarget && (
              <p className="composer-working-note" role={stop.asking || stop.error ? 'status' : undefined} id={stop.asking ? 'composer-stop-ask' : undefined}>
                {stop.error ? stop.error
                  : stop.stopping || stopTarget.state === 'cancelling' ? '멈추는 중이에요.'
                  : stop.asking ? <>멈출까요? 한 번 더 누르면 멈춰요. <button type="button" className="composer-stop-cancel" onClick={stop.cancel}>취소</button></>
                  : draft.trim() || files.drafts.length ? '지금 보내면 하던 일에 덧붙여요.'
                  : '지금 보내면 하던 일에 덧붙여요. 멈추려면 ■ 버튼을 누르세요.'}
              </p>
            )}
          </div>
        )}
      </div>
    </section>
  );
});
