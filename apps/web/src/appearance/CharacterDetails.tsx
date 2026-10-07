import type { AssistantAppearance } from './types';

export function CharacterEyes({ kind }: { readonly kind: AssistantAppearance['eyes'] }) {
  switch (kind) {
    case 'sleepy': return <g fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round"><path d="M32 46q5 6 10 0M58 46q5 6 10 0" /></g>;
    case 'sparkle': return <g fill="currentColor"><path d="m37 36 3 7 5 3-5 3-3 7-3-7-5-3 5-3zM63 36l3 7 5 3-5 3-3 7-3-7-5-3 5-3z" /></g>;
    case 'dots': return <g fill="currentColor"><circle cx="37" cy="46" r="5" /><circle cx="63" cy="46" r="5" /></g>;
    case 'oval': return <g fill="currentColor"><ellipse cx="37" cy="46" rx="5.5" ry="7" /><ellipse cx="63" cy="46" rx="5.5" ry="7" /><g fill="white" opacity=".86"><circle cx="35.5" cy="43.5" r="1.7" /><circle cx="61.5" cy="43.5" r="1.7" /></g></g>;
  }
  return kind satisfies never;
}

export function CharacterEyewear({ kind }: { readonly kind: AssistantAppearance['eyewear'] }) {
  switch (kind) {
    case 'none': return null;
    case 'monocle': return <g fill="none" stroke="currentColor" strokeWidth="2.8"><circle cx="63" cy="46" r="12" /><path d="M74 52q-2 19 12 20" strokeLinecap="round" /><path d="m57 38 7-2" stroke="white" strokeWidth="1.6" opacity=".55" /></g>;
    case 'round': return <g fill="none" stroke="currentColor" strokeWidth="2.8"><circle cx="36" cy="46" r="11" /><circle cx="64" cy="46" r="11" /><path d="M47 45q3-3 6 0M25 43l-7-2M75 43l7-2" /></g>;
    case 'sunglasses': return <g fill="currentColor"><path d="M23 38h24l-3 17q-14 9-19-3zm30 0h24l-2 14q-5 12-19 3z" /><path d="M44 43h12v4H44z" /><g fill="white" opacity=".3"><path d="m29 41 5 0-7 10zM60 41h5l-7 10z" /></g></g>;
  }
  return kind satisfies never;
}

export function CharacterAccessory({ kind }: { readonly kind: AssistantAppearance['accessory'] }) {
  switch (kind) {
    case 'none': return null;
    case 'headphones': return <g stroke="currentColor" strokeWidth="5" fill="none"><path d="M14 48V39a36 36 0 0 1 72 0v9" /><rect x="9" y="42" width="9" height="22" rx="4" fill="currentColor" /><rect x="82" y="42" width="9" height="22" rx="4" fill="currentColor" /></g>;
    case 'bow': return <g fill="currentColor"><path d="M47 77 33 70q-4-2-4 3v17q0 4 4 2l14-7zm6 0 14-7q4-2 4 3v17q0 4-4 2l-14-7z" /><rect x="44" y="75" width="12" height="13" rx="4" /></g>;
    case 'beanie': return <g fill="currentColor"><path d="M21 27c0-34 58-34 58 0z" /><rect x="18" y="22" width="64" height="11" rx="5" /><path d="M37 3v18M50 0v21M63 3v18" stroke="white" strokeWidth="1.5" opacity=".17" /></g>;
    case 'crown': return <g fill="#ebc75f" stroke="#aa8038" strokeWidth="1.3" strokeLinejoin="round"><path d="m25 22-3-22 17 11L50-6l11 17L78 0l-3 22z" /><path d="M26 17h48" /><circle cx="50" cy="11" r="2" fill="white" stroke="none" /></g>;
  }
  return kind satisfies never;
}
