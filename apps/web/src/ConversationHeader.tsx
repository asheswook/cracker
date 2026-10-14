import { Monitor, PanelLeft } from 'lucide-react';
import { IconButton, Status, type Presence } from './primitives';
import { useLayoutEffect, useRef, type CSSProperties } from 'react';
import { AnimatePresence, animate, m, useMotionValue, useTransform } from 'motion/react';
import { AssistantCharacter } from './appearance/AssistantCharacter';
import { defaultAppearance, type AssistantAppearance } from './appearance/types';
import { useReducedMotion } from './useReducedMotion';
import './appearance/identity.css';

const identityFadeDuration = 0.15;
const identityMotionTokens: CSSProperties & { readonly '--identity-fade-duration': string } = {
  '--identity-fade-duration': `${identityFadeDuration}s`,
};
const identityTransition = { type: 'tween', duration: 0.3, ease: [0.23, 1, 0.32, 1] } as const;

export function AssistantIdentity({ name, onOpen, appearance = defaultAppearance, working = false }: {
  readonly name: string;
  readonly onOpen: () => void;
  readonly appearance?: AssistantAppearance;
  readonly working?: boolean;
}) {
  const measure = useRef<HTMLSpanElement>(null);
  const width = useMotionValue(0);
  const height = useMotionValue(0);
  const reducedMotion = useReducedMotion();
  const clipPath = useTransform(() => `inset(0 calc(50% - ${width.get()}px / 2) calc(100% - ${height.get()}px) round var(--identity-radius))`);
  useLayoutEffect(() => {
    const node = measure.current;
    if (!node) return;
    const update = () => {
      if (reducedMotion || width.get() === 0) {
        width.jump(node.offsetWidth);
        height.jump(node.offsetHeight);
      } else {
        animate(width, node.offsetWidth, identityTransition);
        animate(height, node.offsetHeight, identityTransition);
      }
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => { observer.disconnect(); width.stop(); height.stop(); };
  }, [reducedMotion, width, height]);
  return (
    <button
      className="messenger-identity"
      style={identityMotionTokens}
      type="button"
      onClick={onOpen}
      aria-label={`${name} 페르소나 설정`}
      title={name}
    >
      <AssistantCharacter appearance={appearance} thinking={working} />
      <span className="identity-name identity-working-label" data-working={working} aria-hidden="true">
        <m.span className="identity-label-surface" style={{ width, height }} />
        <m.span ref={measure} className="identity-label-content" style={{ clipPath }}>
          <span className="identity-label-persona">{name}</span>
          <AnimatePresence initial={false}>
            {working && <m.span key="working" className="identity-label-thinking"
              initial={{ opacity: reducedMotion ? 1 : 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              transition={{ ...identityTransition, duration: reducedMotion ? 0 : identityFadeDuration }}
            >생각 중…</m.span>}
          </AnimatePresence>
        </m.span>
      </span>
      <span className="identity-status" role="status">{working ? `${name}, 생각 중` : ''}</span>
    </button>
  );
}

export function ConversationHeader({
  name,
  archiveTitle,
  presence,
  computerOpen,
  onMenu,
  onSettings,
  onComputer,
  onTimeControlMount,
  appearance,
  working = false,
}: {
  readonly name: string;
  readonly archiveTitle: string | undefined;
  readonly presence: Presence;
  readonly computerOpen: boolean;
  readonly onMenu: () => void;
  readonly onSettings: () => void;
  readonly onComputer: () => void;
  readonly onTimeControlMount?: (node: HTMLDivElement | null) => void;
  readonly appearance?: AssistantAppearance;
  readonly working?: boolean;
}) {
  return (
    <header className="conversation-header messenger-header">
      <div className="messenger-header-start">
        <IconButton label="메뉴 열기" className="mobile-menu" onClick={onMenu}>
          <PanelLeft size={19} />
        </IconButton>
        <div className="message-time-slot" ref={onTimeControlMount} />
      </div>
      {archiveTitle ? (
        <span className="messenger-archive-title">
          <span className="archive-kicker">보관된 대화</span>
          <span className="archive-name" title={archiveTitle}>{archiveTitle}</span>
        </span>
      ) : (
        <AssistantIdentity name={name} onOpen={onSettings} appearance={appearance ?? defaultAppearance} working={working} />
      )}
      <div className="header-actions">
        <Status presence={presence} />
        <button
          type="button"
          className={`computer-trigger ${computerOpen ? 'active' : ''}`}
          onClick={onComputer}
          aria-expanded={computerOpen}
          aria-label="컴퓨터"
        >
          <Monitor size={17} />
          <span>컴퓨터</span>
        </button>
      </div>
    </header>
  );
}
