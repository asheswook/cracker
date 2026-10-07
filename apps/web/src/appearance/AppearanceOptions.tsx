import { Check } from 'lucide-react';
import { useId } from 'react';
import type { AssistantAppearance } from './types';
import { appearanceChoices, characterColors } from './catalog';
import { AssistantCharacter } from './AssistantCharacter';

export function AppearanceOptions<K extends Exclude<keyof AssistantAppearance, 'version'>>({ field, title, draft, onChange, disabled }: {
  readonly field: K;
  readonly title: string;
  readonly draft: AssistantAppearance;
  readonly onChange: (value: AssistantAppearance) => void;
  readonly disabled: boolean;
}) {
  const id = useId();
  return <fieldset className="appearance-options" disabled={disabled}>
    <legend>{title}</legend>
    <div className="appearance-option-grid">
      {appearanceChoices[field].map(([value, label]) => {
        const next = { ...draft, [field]: value };
        const preview: AssistantAppearance = field === 'eyes' ? { ...next, eyewear: 'none' } : next;
        return <label className="appearance-option" key={value}>
          <input type="radio" name={id} value={value} checked={draft[field] === value} onChange={() => onChange(next)} />
          {field === 'color' ? <span className="appearance-swatch" style={{ background: characterColors[preview.color][1] }} /> : <AssistantCharacter appearance={preview} still />}
          <span>{label}</span><Check className="appearance-option-check" size={12} aria-hidden="true" />
        </label>;
      })}
    </div>
  </fieldset>;
}
