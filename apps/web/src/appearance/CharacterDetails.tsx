import type { AssistantAppearance } from './types';
import { characterParts } from './character-svg';

export function CharacterDrawing({ appearance }: { readonly appearance: AssistantAppearance }) {
  const p = characterParts(appearance);
  return <>
    <g className="character-body-art" dangerouslySetInnerHTML={{ __html: p.body }} />
    <g className="character-face" dangerouslySetInnerHTML={{ __html: p.face }} />
    <g className="character-accessory" dangerouslySetInnerHTML={{ __html: p.accessory }} />
    <g dangerouslySetInnerHTML={{ __html: p.extras }} />
  </>;
}
