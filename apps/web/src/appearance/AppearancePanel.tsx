import { useCallback, useEffect, useRef, useState } from 'react';
import { Pencil } from 'lucide-react';
import { read, errorMessage } from '../api';
import { client } from '../store';
import { Button, ErrorNotice } from '../primitives';
import { AppearanceSettings } from './types';
import { AssistantCharacter } from './AssistantCharacter';
import { AppearanceEditor } from './AppearanceEditor';

export function AppearancePanel() {
  const [value, setValue] = useState<AppearanceSettings | null>(null);
  const [editing, setEditing] = useState(false);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState('');
  const generation = useRef(0);
  const operation = useRef<AbortController | null>(null);
  const load = useCallback(async (failurePrefix = '') => {
    const version = ++generation.current;
    operation.current?.abort();
    const controller = new AbortController();
    operation.current = controller;
    setError('');
    try {
      const result = await client.refreshAppearance(controller.signal);
      if (controller.signal.aborted || version !== generation.current) return;
      if (!result) { setError('최신 설정을 확인하지 못했어요. 다시 불러와 주세요.'); return; }
      setValue(result);
    } catch (failure) { if (!controller.signal.aborted && version === generation.current) setError(failurePrefix + errorMessage(failure)); }
  }, []);
  useEffect(() => { void load(); return () => { generation.current++; operation.current?.abort(); }; }, [load]);
  const open = async () => {
    if (opening) return;
    operation.current?.abort();
    const version = ++generation.current;
    setOpening(true); setError('');
    try {
      const next = await read('/v1/appearance', AppearanceSettings);
      if (version === generation.current) { setValue(next); setEditing(true); }
    } catch (failure) { if (version === generation.current) setError(errorMessage(failure)); }
    finally { if (version === generation.current) setOpening(false); }
  };
  return <section className="appearance-summary">
    <div className="settings-section-heading"><div><h2>어시스턴트 외형</h2><p>함께 일하는 어시스턴트의 모습을 꾸며 주세요.</p></div></div>
    {error && <><ErrorNotice>{error}</ErrorNotice><Button onClick={() => void load()}>다시 불러오기</Button></>}
    {!value && !error && <p role="status">외형을 불러오는 중이에요.</p>}
    {value && <><div className="appearance-preview"><AssistantCharacter appearance={value.appearance} /></div><Button busy={opening} onClick={() => void open()}><Pencil size={15} />외형 편집</Button></>}
    {editing && value && <AppearanceEditor value={value} onClose={() => setEditing(false)} onSaved={next => {
      generation.current++; setValue(next); setEditing(false);
      void load('저장됐지만 헤더를 갱신하지 못했어요. ');
    }} />}
  </section>;
}
