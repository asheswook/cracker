import { Info } from 'lucide-react';

export function SystemEvent({ children, detail = null }: { readonly children: string; readonly detail?: string | null }) {
  return <div className="system-event" title={detail ?? undefined}><Info size={14} aria-hidden="true" /><span>{children}</span></div>;
}
