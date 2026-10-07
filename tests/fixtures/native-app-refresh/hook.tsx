/** @jsxImportSource ../../../apps/web/node_modules/react */
import { useState } from '../../../apps/web/node_modules/react';
import { createRoot } from '../../../apps/web/node_modules/react-dom/client';
import { useNativeApp } from '../../../apps/web/src/useNativeApp';

function Probe({ connected }: { readonly connected: boolean }) {
  const [target, setTarget] = useState({ href: location.href, revision: 0 });
  const [actionError, setActionError] = useState('');
  const refreshError: unknown = useNativeApp(connected, setTarget, setActionError);
  return <><output id="hook-error">{actionError || (typeof refreshError === 'string' ? refreshError : '')}</output><output id="hook-target">{target.revision}</output></>;
}
function Harness() {
  const [connected, setConnected] = useState(true);
  const [mounted, setMounted] = useState(true);
  return <main><button id="connection" onClick={() => setConnected(value => !value)}>Connected: {String(connected)}</button><button id="mount" onClick={() => setMounted(value => !value)}>Mounted: {String(mounted)}</button>{mounted && <Probe connected={connected} />}</main>;
}
const root = document.getElementById('root');
if (root) createRoot(root).render(<Harness />);
