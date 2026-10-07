import { negotiateHybrid } from './native-hybrid';
import { LazyMotion } from 'motion/react';
import { createRoot } from 'react-dom/client';
import { features } from './motionFeatures';
import './styles.css';
import './mobile-forms.css';
const root = document.getElementById('root');
if (root) {

  if (window.__ASSISTANT_HYBRID_ROLE__ === 'footer') {
    document.documentElement.dataset['footerOnly'] = 'true';
    const { FooterOnly } = await import('./FooterOnly');
    createRoot(root).render(<LazyMotion features={features}><FooterOnly /></LazyMotion>);
  } else if (window.__ASSISTANT_HYBRID_ROLE__ === 'header') {
    document.documentElement.dataset['headerOnly'] = 'true';
    const { HeaderOnly } = await import('./HeaderOnly');
    createRoot(root).render(<LazyMotion features={features}><HeaderOnly /></LazyMotion>);
  } else {
    const bridge = window.webkit?.messageHandlers?.assistantNative;
    const hybrid = await negotiateHybrid(bridge ? value => bridge.postMessage(value as { method: 'hybridConnect'; version: 1; document: string }) : undefined);
    if (hybrid) document.documentElement.dataset['messageCanvas'] = 'true';
    const { BodyEntry } = await import('./body-entry');
    createRoot(root).render(<LazyMotion features={features}><BodyEntry /></LazyMotion>);
    if (import.meta.env.DEV && import.meta.env['VITE_DISABLE_REACT_DEVTOOLS'] !== '1') {
      void import('react-grab');
      void import('react-scan');
    }
  }
}
