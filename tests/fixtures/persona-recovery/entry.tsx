import { createRoot } from 'react-dom/client';
import { useEffect, useState } from 'react';
import { LazyMotion, domAnimation } from 'motion/react';
import { z } from 'zod';
import { PersonaOnboarding } from '../../../apps/web/src/settings/PersonaOnboarding';
import { InstructionsPanel } from '../../../apps/web/src/settings/InstructionsPanel';
import { AppearancePanel } from '../../../apps/web/src/appearance/AppearancePanel';
import { ConversationHeader } from '../../../apps/web/src/ConversationHeader';
import { client, useClient } from '../../../apps/web/src/store';
import { http, read } from '../../../apps/web/src/api';
import { Id } from '../../../apps/web/src/types';
import '../../../apps/web/src/styles.css';
import '../../../apps/web/src/mobile-forms.css';
import '../../../apps/web/src/messenger.css';
const params = new URL(location.href).searchParams;
function Fixture() {
  const state = useClient();
  const [ready, setReady] = useState(false);
  const [mounted, setMounted] = useState(params.get('mode') !== 'combined');
  const [workspace, setWorkspace] = useState<Id | null>(null);
  useEffect(() => {
    void (async () => {
      await client.init();
      await Promise.all([client.refreshPersona(), client.refreshAppearance()]);
      const setup = await read(`/fixture/arm?fault=${params.get('fault') ?? ''}`, z.object({ workspace: Id }));
      setWorkspace(setup.workspace); setReady(true);
    })();
  }, []);
  return <main data-fixture="persona-recovery">
    <ConversationHeader name={state.persona.name} appearance={state.appearance} archiveTitle={undefined} connected={false} computerOpen={false} onMenu={() => undefined} onSettings={() => undefined} onComputer={() => undefined} />
    <nav aria-label="Fixture controls">
      <button id="network-recover" onClick={() => void http.post('/fixture/recover')}>Recover network</button>
      <button id="network-fail" onClick={() => void http.post('/fixture/fail')}>Fail reads</button>
      <button id="toggle-mount" onClick={() => setMounted(value => !value)}>Toggle mount</button>
      <button id="switch-workspace" onClick={() => void (async () => { const result = await read('/fixture/switch', z.object({ workspace: Id })); await client.init(); await Promise.all([client.refreshPersona(), client.refreshAppearance()]); setWorkspace(result.workspace); })()}>Switch workspace</button>
    </nav>
    <output data-testid="ready">{ready ? 'ready' : 'booting'}</output>
    {ready && workspace && params.get('mode') === 'combined' && <><PersonaOnboarding workspace={workspace} />{mounted && <InstructionsPanel />}</>}
    {ready && mounted && workspace && params.get('mode') !== 'combined' && (params.get('mode') === 'onboarding'
      ? <div className="message-feed"><PersonaOnboarding workspace={workspace} /></div>
      : params.get('mode') === 'appearance' ? <AppearancePanel key={workspace} /> : <InstructionsPanel key={workspace} />)}
  </main>;
}
const root = document.getElementById('root');
if (!root) throw new TypeError('Missing fixture root');
createRoot(root).render(<LazyMotion features={domAnimation}><Fixture /></LazyMotion>);
