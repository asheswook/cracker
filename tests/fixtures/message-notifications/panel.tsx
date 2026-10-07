/** @jsxImportSource ../../../apps/web/node_modules/react */
import { useState } from '../../../apps/web/node_modules/react';
import { createRoot } from '../../../apps/web/node_modules/react-dom/client';
import { NotificationPanel } from '../../../apps/web/src/NotificationPanel';
import '../../../apps/web/src/styles.css';
import '../../../apps/web/src/assistant.css';

function Harness() {
  const [mounted, setMounted] = useState(true);
  const control = async (action: string) => {
    await fetch('/fixture/control', { method: 'POST', body: JSON.stringify({ action }) });
    if (action === 'holdGet') window.dispatchEvent(new Event('focus'));
  };
  return <main style={{ maxWidth: 520, margin: '24px auto', padding: 24, background: 'var(--surface)', borderRadius: 16 }}>
    <details><summary>Synthetic QA controls</summary>
      <p>Actual NotificationPanel. No device registration or real push.</p>
      <button id="hold-get" onClick={() => void control('holdGet')}>Hold next focus GET</button>
      <button id="release-get" onClick={() => void control('releaseGet')}>Release stale GET</button>
      <button id="fail-put" onClick={() => void control('failPut')}>Fail next save</button>
      <button id="hold-put" onClick={() => void control('holdPut')}>Hold next save</button>
      <button id="release-put" onClick={() => void control('releasePut')}>Release save</button>
      <button id="refresh" onClick={() => window.dispatchEvent(new Event('focus'))}>Focus refresh</button>
      <button id="mount" onClick={() => setMounted(value => !value)}>Toggle panel</button>
    </details>
    {mounted && <NotificationPanel />}
  </main>;
}
const root = document.getElementById('root');
if (root) createRoot(root).render(<Harness />);
