import { characterSvg } from './appearance/character-svg';
import { defaultAppearance } from './appearance/types';
import { m as Motion } from 'motion/react';
import { useReducedMotion } from './useReducedMotion';
import { LoaderCircle, ArrowUp, ArrowRight, Monitor, X } from 'lucide-react';
import { useEffect, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { panelSpring } from './animation';
import { errorToasts } from './error-toasts';
export function Button({
  children,
  className = '',
  busy = false,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { busy?: boolean }) {
  return (
    <button {...props} className={`button ${className}`} disabled={props.disabled || busy}>
      {busy && <LoaderCircle className="spinner" size={16} />}
      <span>{children}</span>
    </button>
  );
}
export function IconButton({
  label,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button {...props} aria-label={label} title={label} className={`icon-button ${props.className ?? ''}`}>
      {children}
    </button>
  );
}
const markSvg = characterSvg(defaultAppearance, 40);
export function Mark({ small = false }: { small?: boolean }) {
  return <span className={`mark ${small ? 'small' : ''}`} aria-hidden="true" dangerouslySetInnerHTML={{ __html: markSvg }} />;
}
export type Presence = 'online' | 'computer-offline' | 'offline';
const presenceLabel: Record<Presence, string> = { online: '연결됨', 'computer-offline': '컴퓨터 꺼짐', offline: '연결 끊김' };
const presenceTitle: Record<Presence, string> = {
  online: '어시스턴트 컴퓨터가 응답하고 있어요.',
  'computer-offline': '어시스턴트 컴퓨터가 응답하지 않아요. 보낸 메시지는 컴퓨터가 켜지면 처리돼요.',
  offline: '서버에 연결하지 못했어요. 네트워크를 확인해 주세요.',
};
export function Status({ presence }: { presence: Presence }) {
  return (
    <span className={`status ${presence}`} role="status" title={presenceTitle[presence]}>
      <i />
      {presenceLabel[presence]}
    </span>
  );
}
export function Empty({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div className="empty-state">
      <span className="empty-icon">{icon}</span>
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  );
}
export function ErrorNotice({ children }: { children: ReactNode }) {
  useEffect(() => {
    if (typeof children !== 'string' || !children.trim()) return;
    const id = `notice:${crypto.randomUUID()}`;
    errorToasts.show(children, id);
    return () => errorToasts.dismiss(id);
  }, [children]);
  return null;
}
export function Surface({ children, className = '' }: { children: ReactNode; className?: string }) {
  const reduced = useReducedMotion();
  return (
    <Motion.div
      className={className}
      initial={{ opacity: 0, y: reduced ? 0 : 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: reduced ? 0 : 8 }}
      transition={reduced ? { duration: 0.1 } : panelSpring}
    >
      {children}
    </Motion.div>
  );
}
export function Showcase() {
  return (
    <main className="showcase">
      <h1>Interface primitives</h1>
      <p>실제 컴포넌트 상태 · 개발 전용</p>
      <div className="showcase-row">
        <Mark />
        <Status presence="online" />
        <Status presence="offline" />
      </div>
      <div className="showcase-row">
        <Button className="primary">
          연결하기 <ArrowRight size={16} />
        </Button>
        <Button>다시 시도</Button>
        <Button busy>연결 중</Button>
        <Button disabled>연결하기</Button>
        <IconButton label="닫기">
          <X size={20} />
        </IconButton>
      </div>
      <ErrorNotice>연결할 수 없어요. 다시 시도해 주세요.</ErrorNotice>
      <div className="bubble user">
        메시지를 보내는 중이에요.<span className="message-meta">전송 중</span>
      </div>
      <div className="composer">
        <textarea aria-label="메시지" placeholder="어떤 일을 맡길까요?" />
        <div className="composer-actions">
          <span>Enter 전송 · Shift+Enter 줄바꿈</span>
          <IconButton label="메시지 보내기" className="send-button">
            <ArrowUp size={20} />
          </IconButton>
        </div>
      </div>
      <Empty icon={<Monitor />} title="컴퓨터 연결 대기">
        등록된 컴퓨터가 연결되면 화면을 열 수 있어요.
      </Empty>
    </main>
  );
}
