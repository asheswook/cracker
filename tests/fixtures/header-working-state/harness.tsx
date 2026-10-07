/** @jsxImportSource ../../../apps/web/node_modules/react */
import { createRoot } from '../../../apps/web/node_modules/react-dom/client';
import { flushSync } from '../../../apps/web/node_modules/react-dom';
import { useAssistantWorking } from '../../../apps/web/src/useAssistantWorking';
import { context, now, other } from '../../client-working-fixture';

type Context = Parameters<typeof useAssistantWorking>[0];
const element = document.getElementById('root');
if (!element) throw new TypeError('Missing fixture root');
const root = createRoot(element);
let value: Context = context;
let instant = now;
let serial = 0;
const timers = new Map<number, { readonly at: number; readonly run: () => void }>();
Date.now = () => instant;
Object.defineProperty(window, 'setTimeout', { configurable: true, value: (handler: TimerHandler, delay = 0, ...args: unknown[]) => {
  if (typeof handler !== 'function') throw new TypeError('Fixture requires a callback');
  const id = ++serial;
  timers.set(id, { at: instant + delay, run: () => handler(...args) });
  return id;
} });
Object.defineProperty(window, 'clearTimeout', { configurable: true, value: (id?: number) => { if (id !== undefined) timers.delete(id); } });

function Probe() {
  return <output id="working">{String(useAssistantWorking(value))}</output>;
}
function render(next: Context) {
  value = next;
  flushSync(() => root.render(<Probe />));
}
function snapshot() {
  return { active: document.getElementById('working')?.textContent, now: instant,
    timers: [...timers.entries()].map(([id, timer]) => ({ id, at: timer.at })) };
}
Object.assign(window, { workingHarness: {
  snapshot,
  reset: () => { render({ ...context, working: null }); instant = now; render(context); return snapshot(); },
  renderSame: () => { render({ ...value, working: value.working ? { ...value.working } : null }); return snapshot(); },
  renew: () => { render({ ...context, working: { ...context.working, expires_at: new Date(instant + 5000).toISOString() } }); return snapshot(); },
  disconnect: () => { render({ ...context, connected: false }); return snapshot(); },
  archive: () => { render({ ...context, selected: other }); return snapshot(); },
  advance: (milliseconds: number) => {
    instant += milliseconds;
    for (const [id, timer] of [...timers.entries()]) {
      if (timer.at <= instant) { timers.delete(id); flushSync(timer.run); }
    }
    return snapshot();
  },
  unmount: () => { flushSync(() => root.unmount()); return snapshot(); },
} });
render(context);
