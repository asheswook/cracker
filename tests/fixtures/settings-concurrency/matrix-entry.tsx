import {createRoot} from 'react-dom/client';
import {useEffect,useState} from 'react';
import {LazyMotion,domAnimation} from 'motion/react';
import {InstructionsEditor} from '../../../apps/web/src/settings/InstructionsEditor';
import {InstructionsPanel} from '../../../apps/web/src/settings/InstructionsPanel';
import {PersonaOnboarding} from '../../../apps/web/src/settings/PersonaOnboarding';
import {Instructions} from '../../../apps/web/src/settings/types';
import {Id} from '../../../apps/web/src/types';
import {read} from '../../../apps/web/src/api';
import {client} from '../../../apps/web/src/store';
import '../../../apps/web/src/styles.css';
import '../../../apps/web/src/mobile-forms.css';
import '../../../apps/web/src/settings/persona.css';
const mode=new URL(location.href).searchParams.get('mode')??'editor';
function Fixture(){
  const [value,setValue]=useState<Instructions|null>(null),[editing,setEditing]=useState(true),[workspace,setWorkspace]=useState<Id|null>(null);
  useEffect(()=>{void client.init().then(async()=>{setWorkspace(client.snapshot().workspace);setValue(await read('/v1/settings',Instructions));});},[]);
  return <main data-fixture="settings-matrix">
    {value&&workspace&&(mode==='onboarding'
      ?<div className="message-feed"><PersonaOnboarding workspace={workspace}/></div>
      :mode==='panel'?<InstructionsPanel/>
      :<><button onClick={()=>setEditing(true)}>Open editor</button><output data-testid="saved">{JSON.stringify(value)}</output>{editing&&<InstructionsEditor value={value} initialPersona={null} onClose={()=>setEditing(false)} onSaved={saved=>{setValue(saved);setEditing(false);}}/>}</>)}
  </main>;
}
const element=document.getElementById('root');
if(!element)throw new Error('Fixture root missing');
createRoot(element).render(<LazyMotion features={domAnimation}><Fixture/></LazyMotion>);
