import { useEffect, useId, useRef, useState } from 'react';
import type { AssistantAppearance } from './types';
import { bodyPaths, characterColors } from './catalog';
import { CharacterAccessory, CharacterEyes, CharacterEyewear } from './CharacterDetails';
import './appearance.css';

export function AssistantCharacter({ appearance, thinking = false, still = false }: {
  readonly appearance: AssistantAppearance;
  readonly thinking?: boolean;
  readonly still?: boolean;
}) {
  const id = useId().replace(/:/g, '');
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
  const [light, base, shade] = characterColors[appearance.color];
  return <span ref={ref} className="assistant-character" data-thinking={thinking} data-active={active && !still} aria-hidden="true">
    <svg viewBox="-50 -50 200 200" width="112" height="112" focusable="false">
      <defs>
        <radialGradient id={`${id}-body`} cx=".32" cy=".23" r=".85"><stop stopColor={light} /><stop offset=".53" stopColor={base} /><stop offset="1" stopColor={shade} /></radialGradient>
        <radialGradient id={`${id}-gloss`} cx=".3" cy=".13" r=".8"><stop stopColor="white" stopOpacity=".4" /><stop offset=".5" stopColor="white" stopOpacity="0" /><stop offset="1" stopColor="black" stopOpacity=".1" /></radialGradient>
        <radialGradient id={`${id}-shadow`}><stop stopColor={shade} stopOpacity=".22" /><stop offset="1" stopColor={shade} stopOpacity="0" /></radialGradient>
      </defs>
      <ellipse className="character-shadow" cx="50" cy="94" rx="37" ry="8" fill={`url(#${id}-shadow)`} />
      <g className="character-body">
        <path d={bodyPaths[appearance.shape]} fill={`url(#${id}-body)`} />
        <path d={bodyPaths[appearance.shape]} fill={`url(#${id}-gloss)`} />
        <g className="character-face"><g className="character-eyes"><CharacterEyes kind={appearance.eyes} /></g><CharacterEyewear kind={appearance.eyewear} /><path d="M47 62q3 2 6 0" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" opacity=".55" /></g>
        <CharacterAccessory kind={appearance.accessory} />
      </g>
      <g className="character-bulb" fill="#ebc75f" stroke="#aa8038" strokeWidth="1.5" strokeLinecap="round">
        <path d="M100 6c0-14-20-14-20 0 0 6 5 8 5 13h10c0-5 5-7 5-13z" /><path d="M85 23h10M87 27h6M90-15v-5M72-7l-4-4M108-7l4-4M69 7h-5M111 7h5" fill="none" /><path d="m87 4 3 5 3-5m-3 5v9" fill="none" stroke="white" opacity=".7" />
      </g>
    </svg>
  </span>;
}
