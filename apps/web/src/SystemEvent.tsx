import { Info } from 'lucide-react';

export function SystemEvent({ children }: { readonly children: string }) {
  return <div className="system-event"><Info size={14} aria-hidden="true" /><span>{children}</span></div>;
}
