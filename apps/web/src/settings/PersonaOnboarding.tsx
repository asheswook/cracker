import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { HTTPError } from 'ky';
import { Check } from 'lucide-react';
import { read, http, errorMessage } from '../api';
import { client } from '../store';
import { Button, ErrorNotice } from '../primitives';
import { Instructions, Persona } from './types';
import type { Id } from '../types';
import './persona.css';
import { onboardingDraftKey, readOnboardingDraft } from './onboardingDraft';
import { SettingsConflict } from './SettingsConflict';
const presets = [
  {
    title: '함께 생각하는 동료',
    role: '생각을 정리하고 선택지를 비교하며 실행까지 돕는 동료',
    style: '편안한 존댓말로 결론부터 간결하게. 필요하면 근거와 다른 관점도 알려 주세요.',
  },
  {
    title: '꼼꼼한 리서처',
    role: '신뢰할 수 있는 자료를 찾아 비교하고 핵심을 정리하는 리서처',
    style: '사실과 추측을 구분하고 출처를 함께 알려 주세요. 모르는 것은 솔직하게 말해 주세요.',
  },
  {
    title: '실행하는 파트너',
    role: '할 일을 구체적인 단계로 나누고 실행과 검증을 돕는 파트너',
    style: '진행 상황은 짧게, 결과와 검증은 명확하게 알려 주세요.',
  },
] as const;
export function PersonaOnboarding({ workspace }: { readonly workspace: Id }) {
  const fieldId = useId();
  const key = onboardingDraftKey(workspace);
  const [draft, setDraft] = useState<Persona | null>(null);
  const [visible, setVisible] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [base, setBase] = useState<Instructions | null>(null);
  const [latest, setLatest] = useState<Instructions | null>(null);
  const [stale, setStale] = useState(false);
  const [loadState, setLoadState] = useState<{ readonly workspace: Id; readonly status: 'pending' | 'failed' | 'ready' }>({ workspace, status: 'pending' });
  const operation = useRef<AbortController | null>(null);
  const formRegion = useRef<HTMLElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const region = formRegion.current;
    const feed = region?.closest('.message-feed');
    if (!region || !feed) return;
    let height = feed.clientHeight;
    const observer = new ResizeObserver(() => {
      const nextHeight = feed.clientHeight;
      const shrinking = nextHeight < height;
      height = nextHeight;
      const focused = document.activeElement;
      if (
        shrinking &&
        (focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement) &&
        region.contains(focused)
      )
        focused.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
    });
    observer.observe(feed);
    return () => observer.disconnect();
  }, [visible, dismissed]);
  const load = useCallback(async () => {
    operation.current?.abort();
    const controller = new AbortController();
    operation.current = controller;
    setLoadState({ workspace, status: 'pending' });
    setError('');
    setVisible(false);
    setDraft(null);
    setBase(null);
    setLatest(null);
    setStale(false);
    setBusy(false);
    try {
      const settings = Instructions.parse(await http.get('/v1/settings', { signal: controller.signal }).json<unknown>());
      if (controller.signal.aborted) return;
      setBase(settings);
      setLoadState({ workspace, status: 'ready' });
      if (
        settings.onboarding?.status === 'completed' ||
        settings.persona.name !== 'Assistant' ||
        settings.persona.role || settings.persona.style || settings.instructions
      ) return;
      let restored = settings.persona;
      let skipped = settings.onboarding?.status === 'skipped';
      try {
        const saved = readOnboardingDraft(workspace);
        if (saved) {
          restored = saved.persona;
          skipped = skipped || saved.dismissed === true;
        }
      } catch (failure) {
        setError(`설정 초안을 복원하지 못했어요. ${errorMessage(failure)}`);
      }
      setDraft(restored);
      setDismissed(skipped);
      setVisible(true);
    } catch (failure) {
      if (!controller.signal.aborted) {
        setError(errorMessage(failure));
        setLoadState({ workspace, status: 'failed' });
      }
    }
  }, [workspace]);
  useEffect(() => {
    void load();
    return () => operation.current?.abort();
  }, [load]);
  const persist = (persona: Persona, skipped: boolean) => {
    setDraft(persona);
    try {
      localStorage.setItem(key, JSON.stringify({ persona, dismissed: skipped }));
      setDismissed(skipped);
    } catch (failure) {
      if (!(failure instanceof Error)) throw failure;
      setDismissed(false);
      setError('이 기기에 초안을 보관하지 못했어요. 입력 내용은 열려 있는 화면에 남아 있어요.');
    }
  };
  const compare = async () => {
    setBusy(true);
    setError('');
    try { setLatest(await read('/v1/settings', Instructions)); }
    catch (failure) { setError(`최신 설정을 불러오지 못했어요. 초안은 유지돼요. ${errorMessage(failure)}`); }
    finally { setBusy(false); }
  };
  const failed = async (failure: unknown) => {
    if (failure instanceof HTTPError && failure.response.status === 409) {
      setStale(true); await compare();
    } else setError(errorMessage(failure));
  };
  if (loadState.workspace !== workspace || loadState.status === 'pending')
    return <section className="persona-onboarding" aria-label="소개 설정 확인"><p role="status">소개 설정을 확인하는 중이에요.</p></section>;
  if (loadState.status === 'failed')
    return <section className="persona-onboarding" aria-label="소개 설정 확인"><ErrorNotice>{error}</ErrorNotice><Button onClick={() => void load()}>다시 불러오기</Button></section>;
  if (!visible || !draft || !base) return null;
  if (dismissed)
    return (
      <button className="onboarding-resume" onClick={() => persist(draft, false)}>
        어시스턴트 설정 이어서 하기
      </button>
    );
  const skip = async () => {
    if (busy || stale) return;
    if (base.onboarding?.status === 'completed') { persist(draft, true); return; }
    setBusy(true);
    setError('');
    try {
      setBase(Instructions.parse(await http.put('/v1/settings', { json: { expected_revision: base.revision, onboarding: { status: 'skipped' } } }).json<unknown>()));
      persist(draft, true);
    } catch (failure) {
      await failed(failure);
    } finally {
      setBusy(false);
    }
  };
  const save = async () => {
    if (busy || stale) return;
    setBusy(true);
    setError('');
    try {
      setBase(Instructions.parse(await http.put('/v1/settings', {
        json: { expected_revision: base.revision, persona: Persona.parse(draft), onboarding: { status: 'completed' } },
      }).json<unknown>()));
      try { await client.refreshPersona(); }
      catch (failure) { setError(`설정은 저장됐지만 화면의 이름을 갱신하지 못했어요. 다시 눌러 갱신해 주세요. ${errorMessage(failure)}`); return; }
      try { localStorage.removeItem(key); }
      catch (failure) {
        if (!(failure instanceof Error)) throw failure;
        setError('설정은 저장됐지만 이 기기의 초안을 정리하지 못했어요. 다시 눌러 정리해 주세요.'); return;
      }
      setVisible(false);
    } catch (failure) {
      await failed(failure);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section ref={formRegion} className="persona-onboarding" aria-label="어시스턴트 소개">
      <div className="onboarding-heading">
        <h1>어시스턴트 설정</h1>
        <p className="onboarding-intro">이름과 말투를 정해 주세요. 나중에 설정에서 바꿀 수 있어요.</p>
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <fieldset disabled={busy || stale}>
          <label>
            이름
            <input
              ref={nameInput}
              autoComplete="off"
              required
              maxLength={80}
              value={draft.name}
              onChange={(event) => persist({ ...draft, name: event.target.value }, false)}
            />
          </label>
          <div className="persona-presets" role="group" aria-label="함께 일하는 방식 프리셋">
            {presets.map((preset) => (
              <button
                type="button"
                key={preset.title}
                aria-pressed={draft.role === preset.role && draft.style === preset.style}
                onClick={() => persist({ ...draft, role: preset.role, style: preset.style }, false)}
              >
                {draft.role === preset.role && <Check size={14} />}
                {preset.title}
              </button>
            ))}
          </div>
          <label>
            <span id={`${fieldId}-role`}>역할</span>
            <textarea
              aria-labelledby={`${fieldId}-role`}
              rows={2}
              maxLength={2000}
              placeholder="어떤 일을 함께하면 좋을까요?"
              value={draft.role}
              onChange={(event) => persist({ ...draft, role: event.target.value }, false)}
            />
          </label>
          <label>
            <span id={`${fieldId}-style`}>말투와 답변 방식</span>
            <textarea
              aria-labelledby={`${fieldId}-style`}
              rows={2}
              maxLength={2000}
              placeholder="예: 편안한 존댓말로, 결론부터 간결하게"
              value={draft.style}
              onChange={(event) => persist({ ...draft, style: event.target.value }, false)}
            />
          </label>
        </fieldset>
        {error && <ErrorNotice>{error}</ErrorNotice>}
        {latest && <SettingsConflict key={latest.revision} base={base} local={{ ...base, persona: draft }} latest={latest} onResolve={resolved => {
          setError(''); setBase(latest); setLatest(null); setStale(false); persist(resolved.persona, false);
          requestAnimationFrame(() => nameInput.current?.focus());
        }} />}
        {stale && !latest && <Button type="button" busy={busy} onClick={() => void compare()}>최신 설정과 비교</Button>}
        <footer>
          <Button type="button" disabled={busy || stale} onClick={() => void skip()}>
            나중에
          </Button>
          <Button type="submit" className="primary" busy={busy} disabled={stale || !draft.name.trim()}>
            저장
          </Button>
        </footer>
      </form>
    </section>
  );
}
