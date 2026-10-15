import { useEffect, useRef, useState } from 'react';
import type { AssistantAppearance } from './types';
import { inkFor } from './character-svg';
import { CharacterDrawing } from './CharacterDetails';
import './appearance.css';

export type CharacterState = 'idle' | 'thinking' | 'typing' | 'computer' | 'web' | 'code' | 'memory';

export function AssistantCharacter({ appearance, state, thinking = false, still = false }: {
  readonly appearance: AssistantAppearance;
  readonly state?: CharacterState;
  readonly thinking?: boolean;
  readonly still?: boolean;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [active, setActive] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element || still) return;
    let visible = false;
    const update = () => setActive(visible && !document.hidden);
    const observer = new IntersectionObserver(entries => {
      visible = entries.some(entry => entry.isIntersecting);
      update();
    });
    observer.observe(element);
    document.addEventListener('visibilitychange', update);
    return () => { observer.disconnect(); document.removeEventListener('visibilitychange', update); };
  }, [still]);
  const current: CharacterState = state ?? (thinking ? 'thinking' : 'idle');
  return <span ref={ref} className="assistant-character" data-state={current} data-sandwich={appearance.biscuit === 'sandwich'} data-active={active && !still} style={{ color: inkFor(appearance.color) }} aria-hidden="true">
    <svg viewBox="-50 -50 200 200" width="112" height="112" focusable="false">
      <CharacterDrawing appearance={appearance} />
    </svg>
  </span>;
}
