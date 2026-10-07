export type ComputerPointerMode = 'trackpad' | 'direct';
type Point = { x: number; y: number };
type Contact = { start: Point; last: Point };
type PointerInput = {
  id: number;
  kind: string;
  action: 'down' | 'move' | 'up';
  button: number;
  x: number;
  y: number;
  time: number;
  bounds: { left: number; top: number; width: number; height: number };
};
const clamp = (value: number) => Math.max(0, Math.min(1, value));

export function createComputerPointer(send: (message: unknown) => void) {
  const contacts = new Map<number, Contact>();
  const buttons = new Map<number, boolean>();
  let relative = false;
  let pending = { x: 0, y: 0 };
  let position: Point = { x: 0.5, y: 0.5 };
  let started = 0,
    moved = false,
    multiple = false,
    cancelled = false,
    scroll = 0;
  let lastTap: { at: number; point: Point } | null = null;
  let lastMove = 0;
  const flush = () => {
    while (pending.x || pending.y) {
      const dx = Math.max(-1, Math.min(1, pending.x));
      const dy = Math.max(-1, Math.min(1, pending.y));
      send({ type: 'pointer_relative', dx, dy });
      pending.x -= dx;
      pending.y -= dy;
    }
  };
  const emit = (action: 'down' | 'move' | 'up', button = 0, isRelative = relative) => {
    if (!isRelative) send({ type: 'pointer', ...position, button, action });
    else {
      flush();
      if (action !== 'move') send({ type: 'pointer_button', button, action });
    }
  };
  const releaseButtons = () => {
    flush();
    for (const [button, isRelative] of buttons) emit('up', button, isRelative);
    buttons.clear();
  };
  const click = (button: number) => {
    emit('down', button);
    emit('up', button);
  };
  return {
    release() {
      releaseButtons();
      contacts.clear();
      lastTap = null;
      cancelled = true;
    },
    has(id: number) {
      return contacts.has(id);
    },
    handle(event: PointerInput, mode: ComputerPointerMode) {
      const { action, bounds, x, y, time, id } = event;
      if (
        ![bounds.left, bounds.top, bounds.width, bounds.height, x, y, time].every(Number.isFinite) ||
        bounds.width <= 0 || bounds.height <= 0
      ) {
        releaseButtons();
        contacts.clear();
        lastTap = null;
        cancelled = true;
        return;
      }
      relative = event.kind === 'touch' && mode === 'trackpad';
      const point = { x, y };
      const absolute = () => ({
        x: clamp((x - bounds.left) / bounds.width),
        y: clamp((y - bounds.top) / bounds.height),
      });
      if (event.kind !== 'touch') {
        if (
          !buttons.size &&
          (x < bounds.left ||
            y < bounds.top ||
            x > bounds.left + bounds.width ||
            y > bounds.top + bounds.height)
        )
          return;
        position = absolute();
        if (action === 'down') {
          if (event.button > 2) return;
          buttons.set(event.button, false);
        }
        if (action === 'up' && !buttons.delete(event.button)) return;
        if (action === 'move' && time - lastMove < 32) return;
        if (action === 'move') lastMove = time;
        emit(action, Math.max(0, event.button));
        return;
      }
      if (action === 'down') {
        if (
          mode === 'direct' &&
          (x < bounds.left ||
            y < bounds.top ||
            x > bounds.left + bounds.width ||
            y > bounds.top + bounds.height)
        )
          return;
        if (!contacts.size) {
          started = time;
          moved = false;
          multiple = false;
          cancelled = false;
          scroll = 0;
        }
        contacts.set(id, { start: point, last: point });
        if (contacts.size > 1) {
          multiple = true;
          releaseButtons();
          lastTap = null;
        }
        if (contacts.size > 2) cancelled = true;
        if (!multiple && mode === 'direct') position = absolute();
        if (
          !multiple &&
          mode === 'trackpad' &&
          lastTap &&
          time - lastTap.at < 320 &&
          Math.hypot(x - lastTap.point.x, y - lastTap.point.y) < 28
        ) {
          buttons.set(0, true);
          emit('down');
          lastTap = null;
        }
        return;
      }
      const contact = contacts.get(id);
      if (!contact) return;
      const dx = x - contact.last.x,
        dy = y - contact.last.y;
      contact.last = point;
      if (Math.hypot(x - contact.start.x, y - contact.start.y) > 8) moved = true;
      if (action === 'move' && !cancelled) {
        if (multiple) {
          if (contacts.size === 2) {
            scroll += dy / 2;
            const steps = Math.trunc(-scroll / 32);
            if (steps) {
              scroll += steps * 32;
              send({ type: 'scroll', dy: Math.max(-20, Math.min(20, steps)) });
            }
          }
        } else {
          if (mode === 'direct' && moved && !buttons.size) {
            buttons.set(0, false);
            emit('down');
          }
          if (mode === 'direct') position = absolute();
          else {
            // Preserve reversals at desktop edges instead of cancelling opposing deltas.
            if (pending.x * dx < 0 || pending.y * dy < 0) flush();
            pending.x += dx / bounds.width;
            pending.y += dy / bounds.height;
          }
          if (time - lastMove >= 32) {
            lastMove = time;
            emit('move');
          }
        }
      }
      if (action === 'up') {
        if (relative && !multiple && !cancelled) {
          if (pending.x * dx < 0 || pending.y * dy < 0) flush();
          pending.x += dx / bounds.width;
          pending.y += dy / bounds.height;
          flush();
        }
        contacts.delete(id);
        if (!contacts.size) {
          const held = buttons.size > 0;
          releaseButtons();
          if (!cancelled && !moved && time - started < 350) {
            if (multiple) click(2);
            else if (!held) {
              click(0);
              lastTap = mode === 'trackpad' ? { at: time, point } : null;
            }
          } else lastTap = null;
        }
      }
    },
  };
}
