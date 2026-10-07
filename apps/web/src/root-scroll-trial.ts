import { hybridEnabled } from './native-hybrid';
import './root-scroll-trial.css';
let active = false;
let retired = false;
export function retireRootReader(owner: 'header' | 'footer') {
  retired = true;
  window.dispatchEvent(new CustomEvent('assistant-root-reader-disable', { detail: owner }));
  setRootScrollActive(false);
}
export function rootReaderAvailable() {
  return !retired && hybridEnabled()
    && Boolean(window.webkit?.messageHandlers?.assistantReader);
}
export function isRootScrollActive() { return active; }
export function setRootScrollActive(value: boolean) {
  if (value && retired) return;
  active = value;
  if (value) document.documentElement.dataset['rootScrollTrial'] = 'true';
  else delete document.documentElement.dataset['rootScrollTrial'];
}
