import { Window } from 'happy-dom';
const window = new Window({ url: 'https://test.invalid/' });
Object.assign(globalThis, { window, document: window.document, navigator: window.navigator, location: window.location,
  HTMLElement: window.HTMLElement, HTMLVideoElement: window.HTMLVideoElement, Event: window.Event,
  MouseEvent: window.MouseEvent, FocusEvent: window.FocusEvent, matchMedia: window.matchMedia.bind(window),
  localStorage: window.localStorage, innerHeight: 900, IS_REACT_ACT_ENVIRONMENT: true });
const matches = window.HTMLElement.prototype.matches;
window.HTMLElement.prototype.matches = function(selector: string) { return selector === ':popover-open' ? false : matches.call(this, selector); };
Object.defineProperty(window.document, 'visibilityState', { configurable: true, value: 'visible' });
