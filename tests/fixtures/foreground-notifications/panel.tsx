/** @jsxImportSource ../../../apps/web/node_modules/react */
import { createRoot } from '../../../apps/web/node_modules/react-dom/client';
import { useCallback, useState } from '../../../apps/web/node_modules/react';
import { useNotificationAttention } from '../../../apps/web/src/useNotificationAttention';
import { isNativeApp } from '../../../apps/web/src/native-bridge';

function Panel() {
  const [connected, setConnected] = useState(true);
  const [received, setReceived] = useState(0);
  const [draft, setDraft] = useState('unsent draft');
  const [screen, setScreen] = useState('Chat');
  const [permission, setPermission] = useState(() => 'Notification' in window ? Notification.permission : 'unsupported');
  const requestPermission = async () => {
    try {
      setPermission(await Notification.requestPermission());
      window.dispatchEvent(new Event('assistant-notification-subscription'));
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      setPermission('request failed');
    }
  };
  const refresh = useCallback(() => setReceived(count => count + 1), []);
  useNotificationAttention(connected, refresh, document.body.dataset['conversation'] ?? null);
  return <main>
    <h1>Foreground notification diagnostic</h1>
    <p>Production hook; local synthetic subscription and transport. No OS push receipt.</p>
    {!isNativeApp() && permission !== 'unsupported' && <>
      <button onClick={() => void requestPermission()}>Request notification permission</button>
      <p role="status">Notification permission: {permission}</p>
    </>}
    <h2>{screen}</h2>
    <button onClick={() => setScreen(screen === 'Chat' ? 'Settings' : 'Chat')}>Switch screen</button>
    <button onClick={() => setConnected(value => !value)}>{connected ? 'Disconnect' : 'Connect'}</button>
    <button onClick={() => window.dispatchEvent(new Event('assistant-native-notification'))}>Native receipt</button>
    <button onClick={() => window.dispatchEvent(new Event('fixture-toggle-subscription'))}>Toggle subscription</button>
    <button onClick={() => window.dispatchEvent(new Event('fixture-native-active'))}>Toggle native active</button>
    <button onClick={() => document.querySelector('dialog')?.showModal()}>Open modal</button>
    <dialog><h2>Modal settings</h2><button onClick={() => document.querySelector('dialog')?.close()}>Close modal</button></dialog>
    <label>Draft <input value={draft} onChange={event => setDraft(event.target.value)} /></label>
    <p id="receipts">Refresh count: {received}</p>
    <p id="connection">{connected ? 'Connected' : 'Disconnected'}</p>
    <a href="/away">Leave app</a>
  </main>;
}
const root = document.getElementById('root');
if (root) createRoot(root).render(<Panel />);
