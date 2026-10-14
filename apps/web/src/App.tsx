import { ScreenSessionProvider } from './ScreenSessionProvider';
import { useTaskErrorToasts } from './useTaskErrorToasts';
import { panelTransition } from './panel-transition';
import { useMenuPresentation } from './useMenuPresentation';
import { useIndependentHeader } from './useIndependentHeader';
import { HeaderTimeContext } from './header-time-context';
import './independent-header.css';
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { LoadingSkeleton } from './LoadingSkeleton';
import { AnimatePresence } from 'motion/react';
import { ArchiveBanner } from './ArchiveBanner';
import { client, useClient } from './store';
import { currentTask } from './currentTask';
import { Connect } from './Connect';
import { Chat } from './Chat';
import { AssistantNav } from './AssistantNav';
import type { Panel } from './AssistantNav';
import { InspectorHost } from './InspectorHost';
import { InspectorHeader } from './InspectorHeader';
import { PanelErrorBoundary } from './PanelErrorBoundary';
import { Mark, ErrorNotice, type Presence } from './primitives';
import { conversationLabel } from './feed-labels';
import { ConversationHeader } from './ConversationHeader';
import { errorMessage } from './api';
import { parseResultLink } from './result-link';
import { useNativeApp } from './useNativeApp';
import { useNotificationAttention } from './useNotificationAttention';
import type { Id } from './types';
import { createWorkSession } from './work-session';
import { useWorkNavigation } from './useWorkNavigation';
import { useAssistantWorking } from './useAssistantWorking';
import './assistant.css';
import './messenger.css';
import './inspector-motion.css';
import './inspector-loading.css';
const Inspector = lazy(() => import('./Inspector').then((module) => ({ default: module.Inspector })));
const refreshAfterNotification = () => { void client.refresh(); };
export function App() {
  const state = useClient();
  useTaskErrorToasts(state.workspace, state.phase === 'ready' && state.connected, state.tasks);
  useNotificationAttention(state.phase === 'ready' && state.connected && state.syncedCursor !== null, refreshAfterNotification, state.selected);
  const assistantWorking = useAssistantWorking(state);
  const [panel, setPanel] = useState<Panel | null>(null);
  const [reserved, setReserved] = useState(false);
  const [wideInspector, setWideInspector] = useState(false);
  const [menu, setMenu] = useState(false);
  const [actionError, setActionError] = useState('');
  const [focusTask, setFocusTask] = useState<string | null>(null);
  const [focusMessage, setFocusMessage] = useState<string | null>(null);
  const [timeControlRoot, setTimeControlRoot] = useState<HTMLDivElement | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const navigation = useRef(0);
  const workSession = useMemo(createWorkSession, [state.workspace, state.phase]);
  const resultLinkHandled = useRef<string | null>(null);
  const [resultTarget, setResultTarget] = useState(() => ({ href: window.location.href, revision: 0 }));
  const nativeRefreshError = useNativeApp(state.phase === 'ready' && state.connected, setResultTarget, setActionError);
  const replaceResultAddress = (conversation?: Id, message?: Id) => {
    const address = new URL(window.location.href);
    address.searchParams.delete('conversation');
    address.searchParams.delete('message');
    if (conversation) address.searchParams.set('conversation', conversation);
    if (message) address.searchParams.set('message', message);
    window.history.replaceState(window.history.state, '', address);
    resultLinkHandled.current = `${state.workspace}:${resultTarget.revision}:${address.search}`;
    setResultTarget(current => ({ ...current, href: address.href }));
  };
  useEffect(() => {
    const restoreAddress = () => {
      navigation.current++;
      setResultTarget(current => ({ href: window.location.href, revision: current.revision + 1 }));
    };
    window.addEventListener('popstate', restoreAddress);
    return () => window.removeEventListener('popstate', restoreAddress);
  }, []);
  useEffect(() => {
    void client.init();
    const reconnect = () => { if (document.visibilityState === 'visible') client.reconnect(); };
    window.addEventListener('online', reconnect);
    window.addEventListener('pageshow', reconnect);
    document.addEventListener('visibilitychange', reconnect);
    return () => {
      window.removeEventListener('online', reconnect);
      window.removeEventListener('pageshow', reconnect);
      document.removeEventListener('visibilitychange', reconnect);
    };
  }, []);
  useMenuPresentation(menu, dialog);
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    const receive = (event: MessageEvent) => {
      const value: unknown = event.data;
      if (value === null || typeof value !== 'object' || !('type' in value) || value.type !== 'assistant-result' || !('url' in value) || typeof value.url !== 'string') return;
      try {
        const url = new URL(value.url, window.location.origin);
        if (url.origin === window.location.origin && url.pathname === '/')
          setResultTarget(current => ({ href: url.href, revision: current.revision + 1 }));
      } catch { return; }
    };
    navigator.serviceWorker.addEventListener('message', receive);
    return () => navigator.serviceWorker.removeEventListener('message', receive);
  }, []);
  useEffect(() => {
    if (state.phase !== 'ready') resultLinkHandled.current = null;
    if (state.phase !== 'ready' || !state.connected || !state.assistantId || !state.workspace) return;
    const url = new URL(resultTarget.href);
    const key = `${state.workspace}:${resultTarget.revision}:${url.search}`;
    if (resultLinkHandled.current === key) return;
    resultLinkHandled.current = key;
    const link = parseResultLink(url);
    if (link.kind === 'none') {
      if (resultTarget.revision > 0) {
        navigation.current++;
        setFocusTask(null);
        setFocusMessage(null);
        setPanel(null);
        setMenu(false);
        setActionError('');
        void client.create().catch(error => setActionError(errorMessage(error)));
      }
      return;
    }
    if (link.kind === 'invalid' || !state.conversations.some(item => item.id === link.conversation)) {
      setActionError('이 결과 링크를 열 수 없어요. 연결한 계정과 링크를 확인해 주세요.');
      return;
    }
    const version = ++navigation.current;
    replaceResultAddress(link.conversation, link.message);
    setActionError('');
    setFocusTask(null);
    setFocusMessage(null);
    setPanel(null);
    setMenu(false);
    void client.select(link.conversation, link.message).then(() => {
      const current = client.snapshot();
      if (navigation.current !== version || current.workspace !== state.workspace || current.selected !== link.conversation) return;
      if (link.message && !current.messages.some(message => message.id === link.message)) {
        setActionError('결과의 원문을 불러오지 못했어요. 페이지를 다시 열어 주세요.');
        return;
      }
      setFocusTask(null);
      setFocusMessage(link.message ?? null);
    });
  }, [state.phase, state.connected, state.assistantId, state.workspace, state.conversations, resultTarget]);
  const run = (action: () => Promise<unknown>) => {
    setActionError('');
    void action().catch((e) => setActionError(errorMessage(e)));
  };
  const openMenu = () => {
    const transition = panelTransition();
    if (transition) void transition.request('menu', () => setMenu(true));
    else setMenu(true);
  };
  const closeMenu = () => {
    panelTransition()?.cancel();
    setMenu(false);
  };
  const closePanel = () => {
    const transition = panelTransition();
    if (transition) void transition.request('chat', () => setPanel(null));
    else setPanel(null);
  };
  const selectPanel = (value: Panel) => {
    const commit = () => {
    navigation.current++;
    setReserved(true);
    setWideInspector(value === 'computer');
    setPanel((p) => (p === value ? null : value));
    setMenu(false);
    };
    const transition = panelTransition();
    if (transition && !panel) void transition.request('panel', commit, menu ? 'menu' : 'chat');
    else if (transition && panel === value) void transition.request('chat', commit);
    else commit();
  };
  const side = (
    <AssistantNav
      name={state.persona.name}
      panel={panel}
      onHome={() => {
        navigation.current++;
        replaceResultAddress();
        run(() => client.create());
        setMenu(false);
        setPanel(null);
        setFocusTask(null);
        setFocusMessage(null);
      }}
      onPanel={selectPanel}
      onClose={closeMenu}
      onLogout={() => run(() => client.logout())}
    />
  );
  const { openTask, openSource } = useWorkNavigation({
    workspace: state.workspace, phase: state.phase, panel, generation: navigation,
    onOpened: (conversation, message) => {
      replaceResultAddress(conversation, message);
      setActionError('');
      setFocusTask(null);
      setFocusMessage(message);
      setPanel(null);
    },
  });
  const returnToAssistant = () => {
    setFocusTask(null); setFocusMessage(null); navigation.current++;
    replaceResultAddress(); run(() => client.create());
  };
  const selectedConversation = state.conversations.find(conversation => conversation.id === state.selected);
  const archiveLabel = selectedConversation ? conversationLabel(selectedConversation).title : '이전 대화';
  const presence: Presence = !state.connected ? 'offline' : state.vms.length && !state.vms.some(vm => vm.online) ? 'computer-offline' : 'online';
  const independentHeader = useIndependentHeader({
    scope: `${state.workspace ?? 'none'}:${state.selected ?? 'none'}`,
    visible: state.phase === 'ready' && !menu && !panel && !reserved,
    props: { name: state.persona.name, appearance: state.appearance, connected: state.connected, presence,
      working: assistantWorking, computerOpen: panel === 'computer',
      archiveTitle: state.selected && state.selected !== state.assistantId ? archiveLabel : null },
  }, { menu: openMenu, settings: () => selectPanel('settings'), computer: () => selectPanel('computer'), 'archive-return': returnToAssistant });
  useEffect(() => () => panelTransition()?.cancel(), [state.workspace, state.selected]);
  const headerError = actionError || nativeRefreshError || independentHeader.error;
  if (state.phase === 'loading')
    return (
      <main className="boot">
        <Mark />
        <LoadingSkeleton label={state.error ? '연결을 복구하는 중…' : '어시스턴트를 불러오는 중…'} />
      </main>
    );
  if (state.phase === 'login') return <Connect />;
  const archive = !!state.selected && state.selected !== state.assistantId;
  const title = archiveLabel;

  return (
    <HeaderTimeContext.Provider value={independentHeader.registerTime}>
    <ScreenSessionProvider workspace={state.workspace} vmId={state.vms[0]?.id} connected={state.connected}
      visible={panel === 'computer' && !menu} controlAllowed={state.vms[0]?.control_state === 'user' && !state.control[state.vms[0].id]}>
    <div
      className={`app-shell assistant-shell ${independentHeader.active ? 'independent-header-active' : ''} ${reserved ? 'has-inspector' : ''} ${panel ? 'inspector-visible' : ''} ${reserved && wideInspector ? 'computer-open' : ''}`}
    >
      <div className="desktop-sidebar">{side}</div>
      <dialog
        ref={dialog}
        aria-label="어시스턴트 메뉴"
        className="menu-dialog"
        onCancel={closeMenu}
        onClick={(e) => {
          if (e.target === e.currentTarget) closeMenu();
        }}
      >
        {side}
      </dialog>
      <main className="main-surface">
        {!independentHeader.active && <ConversationHeader name={state.persona.name} archiveTitle={archive ? title : undefined}
          appearance={state.appearance} working={assistantWorking}
          presence={presence} computerOpen={panel === 'computer'} onMenu={openMenu}
          onSettings={() => selectPanel('settings')} onComputer={() => selectPanel('computer')}
          onTimeControlMount={setTimeControlRoot} />}
        {archive && <ArchiveBanner onReturn={returnToAssistant} placeholder={independentHeader.active} />}
        {headerError && (
          <div className="header-error">
            <ErrorNotice>{headerError}</ErrorNotice>
          </div>
        )}
        <Chat
          replyComposing={state.composing}
          replyHandoff={state.replyHandoff}
          messages={state.messages}
          syncedCursor={state.syncedCursor}
          outbox={state.outbox}
          selected={state.selected}
          error={state.error}
          task={currentTask(state.tasks, state.selected)}
          vm={state.vms[0]}
          connected={state.connected}
          assistantName={state.persona.name}
          readOnly={archive}
          composerObscured={menu || Boolean(panel) || reserved}
          focusTask={focusTask}
          focusMessage={focusMessage}
          timeControlRoot={timeControlRoot}
        />
      </main>
      <AnimatePresence onExitComplete={() => setReserved(false)}>
        {panel && (
          <InspectorHost computer={panel === 'computer'} key="inspector" onClose={closePanel} onPresented={() => panelTransition()?.complete('panel')}>
            <PanelErrorBoundary onClose={closePanel}>
            <Suspense
              fallback={
                <>
                  <InspectorHeader panel={panel} onClose={closePanel} />
                  <div className="inspector-body">
                    <LoadingSkeleton label="불러오는 중…" />
                  </div>
                </>
              }
            >
              <Inspector
                panel={panel}
                onComputer={() => selectPanel('computer')}
                state={state}
                onClose={closePanel}
                workSession={workSession}
                onTask={openTask}
                onSource={openSource}
                onArchive={(id) => {
                  navigation.current++;
                  replaceResultAddress(id);
                  setFocusTask(null);
                  setFocusMessage(null);
                  run(() => client.select(id));
                  setPanel(null);
                }}
              />
            </Suspense>
            </PanelErrorBoundary>
          </InspectorHost>
        )}
      </AnimatePresence>
    </div>
    </ScreenSessionProvider>
    </HeaderTimeContext.Provider>
  );
}
