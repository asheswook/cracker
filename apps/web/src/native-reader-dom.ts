export type ReaderAnchor = Readonly<{ id: string; offset: number; fallback: number }>;
export type ReaderLayout = Readonly<{ width: number; height: number; contentHeight: number; offset: number }>;
export interface ReaderDOM {
  layout(): ReaderLayout;
  capture(header: number): ReaderAnchor | null;
  target(anchor: ReaderAnchor, header: number): number;
  source(id: string, header: number): ReaderAnchor | null;
  highlight(id: string): void;
}
export function readerDOM(feed: () => HTMLElement | null): ReaderDOM {
  const layout = () => ({ width: window.innerWidth, height: window.innerHeight,
    contentHeight: document.scrollingElement?.scrollHeight ?? 0, offset: document.scrollingElement?.scrollTop ?? 0 });
  return {
    layout,
    capture(header) {
      const items = feed()?.querySelectorAll<HTMLElement>('.message[id]');
      if (!items) return null;
      let low = 0, high = items.length;
      while (low < high) {
        const mid = Math.floor((low + high) / 2);
        if (items.item(mid).getBoundingClientRect().bottom <= header) low = mid + 1;
        else high = mid;
      }
      const node = items.item(low);
      return node ? { id: node.id, offset: node.getBoundingClientRect().top - header, fallback: layout().offset } : null;
    },
    target(anchor, header) {
      const node = document.getElementById(anchor.id);
      return node && feed()?.contains(node) ? layout().offset + node.getBoundingClientRect().top - header - anchor.offset : anchor.fallback;
    },
    source(id, header) {
      const node = document.getElementById(`message-${id}`);
      return node && feed()?.contains(node) ? { id: node.id, offset: 0,
        fallback: layout().offset + node.getBoundingClientRect().top - header } : null;
    },
    highlight(id) {
      const node = document.getElementById(id);
      node?.classList.add('task-highlight');
      if (node) setTimeout(() => node.classList.remove('task-highlight'), 2400);
    },
  };
}
