import { useCallback, useEffect, useLayoutEffect, useId, useRef, useState, type MouseEvent } from 'react';
import {
  Monitor,
  Maximize2,
  Minimize2,
  RotateCcw,
  MousePointer2,
  Eye,
  Keyboard,
  Hand,
  Move,
  ZoomIn,
  ZoomOut,
  X,
} from 'lucide-react';
import type { Vm } from './types';
import { useScreen } from './useScreen';
import { Button, Empty, IconButton, ErrorNotice } from './primitives';
import { client, useClient } from './store';
import { useComputerInput } from './useComputerInput';
import { useComputerKeyboard } from './useComputerKeyboard';
import type { ComputerPointerMode } from './computerPointer';
import './Computer.css';
export function Computer({ vms, connected }: { vms: Vm[]; connected: boolean }) {
  const vm = vms[0];
  const screen = useScreen();
  const { control: controls } = useClient();
  const receipt = vm ? controls[vm.id] : undefined;
  const busy = receipt?.phase === 'pending';
  const ownership = receipt ? (busy ? 'switching' : 'unknown') : vm?.control_state;
  useEffect(
    () => () => {
      if (vm) client.cancelControl(vm.id);
    },
    [vm?.id],
  );
  const [error, setError] = useState('');
  const [mode, setMode] = useState<ComputerPointerMode>(() =>
    matchMedia('(pointer: coarse)').matches ? 'trackpad' : 'direct',
  );
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  const [panning, setPanning] = useState(false);
  const frame = useRef<HTMLDivElement>(null);
  const restoreExpansionFocus = useRef(false);
  const takeoverFocus = useRef<HTMLButtonElement | null>(null);
  const takeoverIntent = useRef<{ applied: boolean } | null>(null);
  const [claimReady, setClaimReady] = useState(0);
  useLayoutEffect(() => {
    const cancel = () => { takeoverIntent.current = null; takeoverFocus.current = null; };
    const visibility = () => { if (document.visibilityState !== 'visible') cancel(); };
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('pagehide', cancel);
    return () => {
      cancel();
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('pagehide', cancel);
    };
  }, [vm?.id, screen.claim]);
  useEffect(() => {
    if (!connected || !screen.live || !screen.open || !screen.visible || receipt?.phase === 'failed' || receipt?.phase === 'unknown') {
      takeoverIntent.current = null;
      return;
    }
    if (!takeoverIntent.current?.applied || ownership !== 'user') return;
    takeoverIntent.current = null;
    screen.claim();
  }, [claimReady, connected, screen.live, screen.open, screen.visible, screen.claim, ownership, receipt?.phase]);
  const keyboardHelp = useId();
  useEffect(() => {
    const changed = () => setFullscreen(Boolean(frame.current) && document.fullscreenElement === frame.current);
    document.addEventListener('fullscreenchange', changed);
    return () => document.removeEventListener('fullscreenchange', changed);
  }, []);
  const enabled = ownership === 'user' && connected && screen.live && screen.open && screen.held && screen.visible;
  useEffect(() => {
    const moved = (event: FocusEvent) => {
      if (event.target !== takeoverFocus.current && event.target !== document.body)
        takeoverFocus.current = null;
    };
    document.addEventListener('focusin', moved);
    return () => document.removeEventListener('focusin', moved);
  }, []);
  useEffect(() => {
    if (receipt?.phase === 'failed' || receipt?.phase === 'unknown') {
      takeoverFocus.current = null;
      return;
    }
    if (!enabled || !takeoverFocus.current) return;
    const trigger = takeoverFocus.current;
    takeoverFocus.current = null;
    if (document.activeElement === trigger || document.activeElement === document.body)
      screen.video.current?.focus({ preventScroll: true });
  }, [enabled, receipt?.phase, screen.video]);
  const input = useComputerInput(screen.video, enabled && !panning, screen.send, mode);
  const keyboard = useComputerKeyboard(enabled && keyboardOpen, screen.send);
  const compactKeyboard = keyboardOpen && (expanded || fullscreen);
  useEffect(() => {
    if ((!expanded && !fullscreen) || !screen.live) { setZoomed(false); setPanning(false); }
  }, [expanded, fullscreen, screen.live]);
  useLayoutEffect(() => {
    if (!expanded && !fullscreen && restoreExpansionFocus.current) {
      frame.current?.querySelector<HTMLButtonElement>('[data-computer-expand]')?.focus({ preventScroll: true });
      restoreExpansionFocus.current = false;
    }
  }, [expanded, fullscreen]);
  useLayoutEffect(() => screen.onRevoke(reason => {
    const pendingAuthorization = reason === 'authorization' && takeoverIntent.current && !takeoverIntent.current.applied;
    if (!pendingAuthorization) { takeoverIntent.current = null; takeoverFocus.current = null; }
    keyboard.discard(); input.release(); setKeyboardOpen(false);
  }), [screen.onRevoke, keyboard.discard, input.release]);
  useEffect(() => {
    if (!expanded && !fullscreen) return;
    const header = frame.current?.closest('.inspector-shell')?.querySelector<HTMLElement>('.inspector-header');
    if (!header) return;
    const previous = header.inert;
    header.inert = true;
    return () => { header.inert = previous; };
  }, [expanded, fullscreen]);
  useEffect(() => {
    if (!enabled) setKeyboardOpen(false);
  }, [enabled]);
  const attachFrame = useCallback((element: HTMLDivElement | null) => {
    frame.current = element;
    if (!element) return;
    const toggled = () => setExpanded(element.matches(':popover-open'));
    toggled();
    setFullscreen(document.fullscreenElement === element);
    element.addEventListener('toggle', toggled);
    const viewport = window.visualViewport;
    const resized = () => {
      element.style.setProperty('--computer-viewport-height', `${viewport?.height ?? innerHeight}px`);
      element.style.setProperty('--computer-viewport-top', `${viewport?.offsetTop ?? 0}px`);
    };
    resized();
    viewport?.addEventListener('resize', resized);
    viewport?.addEventListener('scroll', resized);
    return () => {
      element.removeEventListener('toggle', toggled);
      viewport?.removeEventListener('resize', resized);
      viewport?.removeEventListener('scroll', resized);
      frame.current = null;
    };
  }, []);
  const closeExpanded = () => {
    keyboard.flush(); keyboard.field.current?.blur(); setKeyboardOpen(false);
    input.release();
    restoreExpansionFocus.current = true;
    if (fullscreen) {
      void document.exitFullscreen().catch(error => {
        if (!(error instanceof Error)) throw error;
        restoreExpansionFocus.current = false; setError('전체 화면을 닫지 못했어요.');
      });
      return;
    }
    frame.current?.hidePopover();
  };
  const toggleExpanded = () => {
    input.release();
    if (fullscreen || expanded) { closeExpanded(); return; }
    const fallback = () => {
      try {
        frame.current?.showPopover();
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        setError('전체 화면을 열 수 없어요.');
      }
    };
    if (matchMedia('(max-width: 999px), (pointer: coarse)').matches) fallback();
    else if (document.fullscreenEnabled) void frame.current?.requestFullscreen().catch(fallback);
    else fallback();
  };
  const canRequest = connected && Boolean(vm?.last_seen_at) && !busy && ownership !== 'switching';
  const canTakeover = canRequest && screen.live && screen.open && ownership === 'agent';
  const requestControl = (event: MouseEvent<HTMLButtonElement>) => {
    if (!vm || !canRequest) return;
    takeoverIntent.current = null;
    if (ownership === 'user' && !screen.held) {
      takeoverFocus.current = event.currentTarget; screen.claim(); return;
    }
    keyboard.flush();
    input.release();
    const kind = receipt?.kind ?? (ownership === 'user' ? 'return_control' : 'takeover');
    takeoverFocus.current = kind === 'takeover' ? event.currentTarget : null;
    if (kind === 'return_control') screen.release();
    const intent = kind === 'takeover' && screen.live && screen.open && screen.visible ? { applied: false } : null;
    takeoverIntent.current = intent;
    void client.control(vm.id, kind).then(applied => {
      if (!intent || takeoverIntent.current !== intent) return;
      if (!applied) { takeoverIntent.current = null; return; }
      intent.applied = true;
      setClaimReady(value => value + 1);
    });
  };
  const controlLabel = screen.claiming ? '이 기기 제어 연결 중…' : ownership === 'user' && !screen.held ? '이 기기에서 제어' : busy
    ? receipt?.kind === 'return_control'
      ? '반환 중…'
      : '가져오는 중…'
    : receipt?.phase === 'unknown'
      ? '적용 상태 다시 확인'
      : receipt?.phase === 'failed'
        ? '제어권 다시 요청'
        : ownership === 'user'
          ? '제어권 반환'
          : '제어권 가져오기';
  const ownershipLabel = !connected
    ? '서버 연결이 끊겼어요'
    : busy
      ? receipt?.kind === 'return_control'
        ? '제어권을 반환하는 중…'
        : '제어권을 가져오는 중…'
      : receipt?.phase === 'failed'
        ? '제어권 요청을 적용하지 못했어요'
        : receipt?.phase === 'unknown'
          ? '제어권 적용 여부를 확인해 주세요'
          : ownership === 'user'
            ? enabled
              ? '직접 조작 중'
              : screen.live ? '이 기기에서는 화면을 보고 있어요' : '제어권이 있어요 · 화면 연결 대기'
            : ownership === 'agent'
              ? '어시스턴트가 조작 중'
              : '제어 상태를 확인하고 있어요';
  const closeKeyboard = () => {
    keyboard.flush(); keyboard.field.current?.blur(); setKeyboardOpen(false);
  };
  const controlAction = <Button className="computer-control-action" busy={busy || screen.claiming}
    onPointerDown={event => { if (keyboardOpen) event.preventDefault(); }}
    disabled={!canRequest || (ownership === 'user' && !screen.held && (!screen.live || !screen.open || !screen.visible))}
    onClick={requestControl}>{controlLabel}</Button>;
  const keyboardKeys = ([['Esc', 'Escape'], ['Tab', 'Tab'], ['←', 'Left'], ['→', 'Right'], ['⌫', 'BackSpace'], ['Enter', 'Enter']] as const)
    .map(([label, key]) => <button key={key} type="button" aria-label={`원격 ${key}`}
      onPointerDown={event => event.preventDefault()} onClick={() => keyboard.key(key)}>{label}</button>);
  const viewControls = (expanded || fullscreen) && <>
    <IconButton label={zoomed ? '화면 맞춤' : '원본 크기로 보기'} disabled={!screen.live}
      onPointerDown={event => { if (keyboardOpen) event.preventDefault(); }}
      onClick={() => { input.release(); setZoomed(!zoomed); setPanning(!zoomed); }}>
      {zoomed ? <ZoomOut size={17} /> : <ZoomIn size={17} />}
    </IconButton>
    {zoomed && <IconButton label="화면 이동" aria-pressed={panning}
      disabled={!screen.live || !enabled}
      onPointerDown={event => { if (keyboardOpen) event.preventDefault(); }}
      onClick={() => { input.release(); setPanning(!panning); }}>
      {panning ? <Move size={17} /> : <MousePointer2 size={17} />}
    </IconButton>}
  </>;
  if (!vm)
    return (
      <Empty icon={<Monitor size={24} />} title="컴퓨터를 기다리고 있어요">
        컴퓨터가 등록되면 이곳에서 화면을 열고 직접 제어할 수 있어요.
      </Empty>
    );
  return (
    <div
      className="computer-panel computer-session"
      data-ownership={ownership}
      data-expanded={expanded || fullscreen}
      data-keyboard-compact={compactKeyboard}
      data-zoomed={zoomed}
      data-panning={panning}
      ref={attachFrame}
      popover="manual"
      onKeyDown={(event) => {
        if (expanded && event.key === 'Escape' && !event.defaultPrevented && !event.nativeEvent.isComposing && !event.repeat) {
          event.preventDefault(); event.stopPropagation(); closeExpanded();
        }
      }}
    >
      <div className="computer-identity">
        <span className="computer-icon">
          <Monitor size={20} />
        </span>
        <div>
          <h3>{vm.name}</h3>
          <p>
            {vm.last_seen_at
              ? '마지막 연결 ' +
                new Date(vm.last_seen_at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })
              : '아직 연결된 적이 없어요'}
          </p>
        </div>
      </div>
      <div className="computer-frame" data-screen-phase={screen.phase}>
        <div className="screen-toolbar">
          {compactKeyboard ? <>
            <IconButton label="키보드 닫기" onClick={closeKeyboard}><X size={17} /></IconButton>
            <div className="computer-compact-keys">{viewControls}{keyboardKeys}</div>
            {controlAction}
          </> : <>
          <span>
            <i className={screen.live ? 'live-dot' : ''} />
            {
              {
                connecting: '연결 중',
                waiting: '화면 대기',
                retrying: '다시 연결 중',
                error: '연결 실패',
                live: 'LIVE',
              }[screen.phase]
            }
          </span>
          <div>
            {viewControls}
            <IconButton
              label={mode === 'trackpad' ? '직접 터치로 전환' : '트랙패드로 전환'}
              disabled={!enabled}
              onClick={() => {
                input.release();
                setMode(mode === 'trackpad' ? 'direct' : 'trackpad');
              }}
            >
              {mode === 'trackpad' ? <Hand size={17} /> : <MousePointer2 size={17} />}
            </IconButton>
            <IconButton
              label={keyboardOpen ? '키보드 닫기' : '키보드 열기'}
              disabled={!enabled}
              aria-pressed={keyboardOpen}
              onPointerDown={event => { if (keyboardOpen) event.preventDefault(); }}
              onClick={() => {
                input.release();
                if (keyboardOpen) {
                  keyboard.flush();
                  keyboard.field.current?.blur();
                  setKeyboardOpen(false);
                } else {
                  setKeyboardOpen(true);
                  keyboard.field.current?.focus({ preventScroll: true });
                }
              }}
            >
              <Keyboard size={17} />
            </IconButton>
            <IconButton label="화면 다시 연결" onClick={screen.reconnect}>
              <RotateCcw size={15} />
            </IconButton>
            <IconButton
              data-computer-expand
              label={fullscreen || expanded ? '전체 화면 닫기' : '화면 전체보기'}
              aria-expanded={fullscreen || expanded}
              disabled={!screen.live && !fullscreen && !expanded}
              onClick={toggleExpanded}
            >
              {fullscreen || expanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
            </IconButton>
          </div>
          </>}
        </div>
        <div className="video-region">
          <video
            ref={screen.video}
            autoPlay
            playsInline
            muted
            tabIndex={enabled && !panning ? 0 : -1}
            aria-label="컴퓨터 실시간 화면"
            aria-describedby={enabled ? keyboardHelp : undefined}
            aria-keyshortcuts={enabled ? 'Control+Alt+Escape' : undefined}
            className={screen.live ? 'visible' : ''}
            onContextMenu={(e) => e.preventDefault()}
            onPointerDown={(e) => {
              if (panning) return;
              keyboard.flush();
              input.pointer(e, 'down');
            }}
            onPointerMove={(e) => input.pointer(e, 'move')}
            onPointerUp={(e) => input.pointer(e, 'up')}
            onPointerCancel={input.releasePointer}
            onLostPointerCapture={(e) => input.lostPointer(e.pointerId)}
            onBlur={input.release}
            onKeyDown={(e) => {
              if (enabled && e.key === 'Escape' && e.ctrlKey && e.altKey) {
                e.preventDefault();
                e.stopPropagation();
                input.release();
                frame.current?.querySelector<HTMLButtonElement>('.computer-control-action')?.focus();
              } else input.keyboard(e, 'down');
            }}
            onKeyUp={(e) => input.keyboard(e, 'up')}
          />
          {enabled && (
            <span id={keyboardHelp} className="screen-keyboard-help">
              Ctrl + Alt + Esc · 화면 입력을 놓고 제어권 반환 버튼으로 이동
            </span>
          )}
          {canTakeover && (
            <button
              className="screen-takeover"
              aria-label="화면을 클릭해 제어권 가져오기"
              onClick={requestControl}
            >
              <span>
                <MousePointer2 size={16} /> 클릭하여 직접 제어
              </span>
            </button>
          )}
          {busy && (
            <div className="screen-control-pending" aria-hidden="true">
              {ownershipLabel}
            </div>
          )}
          {!screen.live && (
            <div className="screen-empty screen-connection" data-phase={screen.phase}>
              <Monitor size={24} aria-hidden="true" />
              <strong role="status">{screen.phase === 'error' ? '컴퓨터에 연결할 수 없어요.' : screen.state}</strong>
              <span>
                {screen.phase === 'error'
                  ? '준비되면 다시 연결할 수 있어요.'
                  : '화면이 도착하면 여기에 표시돼요.'}
              </span>
              {screen.phase === 'error' && <Button onClick={screen.reconnect}>다시 연결</Button>}
            </div>
          )}
        </div>
      </div>
      {!compactKeyboard && <div className="computer-control-strip">
        <span className="computer-owner" role="status">
          {ownership === 'user' ? <MousePointer2 size={15} /> : <Eye size={15} />}
          {ownershipLabel}
        </span>
        {controlAction}
      </div>}
      {(error || receipt?.error) && <ErrorNotice>{error || receipt?.error}</ErrorNotice>}
      {screen.phase === 'error' && <ErrorNotice>{screen.state}</ErrorNotice>}
      <div className="computer-keyboard" data-open={keyboardOpen} aria-hidden={!keyboardOpen}>
        <textarea
          ref={keyboard.field}
          onFocus={() => setKeyboardOpen(true)}
          onBlur={() => { keyboard.flush(); setKeyboardOpen(false); }}
          aria-label="컴퓨터 키보드 입력"
          tabIndex={keyboardOpen ? 0 : -1}
          disabled={!enabled}
          rows={1}
          autoCapitalize="none"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
        />
        {keyboardOpen && !compactKeyboard && (
          <div className="computer-keyboard-keys">
            {keyboardKeys}
            <IconButton
              label="키보드 닫기"
              onClick={closeKeyboard}
            >
              <X size={16} />
            </IconButton>
          </div>
        )}
      </div>
      {enabled && (
        <p className="computer-input-hint">
          {mode === 'trackpad'
            ? '트랙패드 · 탭하여 클릭 · 두 손가락 탭은 우클릭, 이동은 스크롤 · 두 번 탭한 뒤 끌기'
            : '직접 터치 · 화면 위치를 눌러 조작'}
        </p>
      )}
      {ownership === 'user' && screen.inputStatus && (
        <p className="screen-caption" role="status">
          {screen.inputStatus}
        </p>
      )}
    </div>
  );
}
