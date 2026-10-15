export type ErrorToastAction = Readonly<{ label: string; run: () => void }>;
export type ErrorToastValue = Readonly<{ id: string; message: string; action?: ErrorToastAction }>;

export function createErrorToasts() {
  let current: readonly ErrorToastValue[] = [];
  const listeners = new Set<() => void>();
  const seen = new Set<string>();
  const publish = () => { for (const listener of listeners) listener(); };
  return {
    snapshot: () => current,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    show(message: string, id: string = crypto.randomUUID(), action?: ErrorToastAction) {
      if (!message.trim() || seen.has(id)) return;
      seen.add(id);
      if (seen.size > 128) { const first = seen.values().next().value; if (first) seen.delete(first); }
      if (current.some(toast => toast.message === message)) return;
      current = [...current.slice(-2), action ? { id, message, action } : { id, message }]; publish();
    },
    dismiss(id: string) { current = current.filter(toast => toast.id !== id); publish(); },
    clear() { current = []; seen.clear(); publish(); },
  };
}
export const errorToasts = createErrorToasts();
