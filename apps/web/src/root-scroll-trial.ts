import { hybridEnabled } from './native-hybrid';
import { nativeShellConfiguration } from './native-bridge';
import './root-scroll-trial.css';
let active = false;
let retired = false;
export function retireRootReader(owner: 'header' | 'footer') {
  retired = true;
  window.dispatchEvent(new CustomEvent('assistant-root-reader-disable', { detail: owner }));
  setRootScrollActive(false);
}
export function rootReaderAvailable() {
  // Under the native shell the page keeps its own scroller: WebKit offsets fixed headers when the root
  // scroll view carries the composer inset, which hides the persona header.
  return !retired && hybridEnabled() && !nativeShellConfiguration()
    && Boolean(window.webkit?.messageHandlers?.assistantReader);
}
export function isRootScrollActive() { return active; }
export function setRootScrollActive(value: boolean) {
  if (value && retired) return;
  active = value;
  if (value) document.documentElement.dataset['rootScrollTrial'] = 'true';
  else delete document.documentElement.dataset['rootScrollTrial'];
}
