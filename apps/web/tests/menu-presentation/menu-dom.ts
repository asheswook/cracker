import './dom';
Object.assign(globalThis, {
  MutationObserver: window.MutationObserver, ResizeObserver: window.ResizeObserver,
  HTMLDialogElement: window.HTMLDialogElement, CustomEvent: window.CustomEvent,
  getComputedStyle: window.getComputedStyle.bind(window),
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  Element: window.Element, Node: window.Node, SVGElement: window.SVGElement,
  IntersectionObserver: window.IntersectionObserver,
});
Object.defineProperties(window, { innerWidth: { value: 402 }, innerHeight: { value: 874 } });
Object.defineProperty(document, 'scrollingElement', { configurable: true, value: document.documentElement });
Object.defineProperty(document.documentElement, 'scrollHeight', { configurable: true, value: 2874 });
document.documentElement.scrollTop = 2000;
window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
window.HTMLDialogElement.prototype.show = function () { this.open = true; };
window.HTMLDialogElement.prototype.close = function () { this.open = false; };
