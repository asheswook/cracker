import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Monitor, RefreshCw } from 'lucide-react';
import { z } from 'zod';
import {
  ModelProvider,
  ModelSelection,
  ModelSettings,
  SaveModelSettings,
} from '../../../../packages/models/schema';
import { http, errorMessage } from '../api';
import { Button, Empty, ErrorNotice } from '../primitives';
import { LoadingSkeleton } from '../LoadingSkeleton';
import type { Vm } from '../types';
import './ModelSettingsPanel.css';
import { ChatgptAccountPanel } from './ChatgptAccountPanel';
import { SubscriptionAccountPanel } from './SubscriptionAccountPanel';
import { SubscriptionModel } from '../../../../packages/models/subscription-schema';

const providers = [
  { id: 'chatgpt', label: 'ChatGPT 계정' },
  { id: 'openai', label: 'OpenAI API' },
  { id: 'anthropic', label: 'Claude API' },
  { id: 'subscription', label: '구독 계정' },
] as const;
const gptModels = ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-luna'] as const;
const claudeModels = ['claude-opus-5-5', 'claude-sonnet-5-5'] as const;
const effort = z.enum(['auto', 'low', 'medium', 'high', 'xhigh', 'max']);
const providerName = (provider: z.infer<typeof ModelProvider>) =>
  providers.find((item) => item.id === provider)?.label ?? provider;
const blank: ModelSelection = { provider: 'chatgpt', model: '', reasoning_effort: null };

function ModelEditor({ vm, onComputer }: { readonly vm: Vm; readonly onComputer?: (() => void) | undefined }) {
  const id = useId();
  const operation = useRef<AbortController | null>(null);
  const [saved, setSaved] = useState<z.infer<typeof ModelSettings> | null>(null);
  const [selection, setSelection] = useState<ModelSelection>(blank);
  const [apiKey, setApiKey] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [subscriptionModels, setSubscriptionModels] = useState<z.infer<typeof SubscriptionModel>[]>([]);
  const load = useCallback(async () => {
    operation.current?.abort();
    const controller = new AbortController();
    operation.current = controller;
    setLoading(true);
    setError('');
    setNotice('');
    try {
      const value = ModelSettings.parse(
        await http
          .get('/v1/model-settings', { searchParams: { vm_id: vm.id }, signal: controller.signal })
          .json<unknown>(),
      );
      if (controller.signal.aborted) return;
      setSaved(value);
      setSelection(value.binding?.selection ?? blank);
      setApiKey('');
    } catch (failure) {
      if (!controller.signal.aborted) setError(errorMessage(failure));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [vm.id]);
  useEffect(() => {
    void load();
    return () => operation.current?.abort();
  }, [load]);
  const available = saved?.defaults?.available.includes(selection.provider) ?? false;
  const stored = saved?.saved_credentials.includes(selection.provider) ?? false;
  const usesKey = selection.provider === 'openai' || selection.provider === 'anthropic';
  const keyRequired = usesKey && !available && !stored;
  const needsAccount = selection.provider === 'chatgpt' && !available;
  const valid = ModelSelection.safeParse(selection).success && (selection.provider !== 'subscription' || subscriptionModels.some(model => model.id === selection.model));
  const current = saved?.binding?.selection;
  const refreshConnections = async () => {
    setSaved(ModelSettings.parse(await http.get('/v1/model-settings', { searchParams: { vm_id: vm.id } }).json()));
  };
  const changed =
    !current ||
    selection.provider !== current.provider ||
    selection.model !== current.model ||
    selection.reasoning_effort !== current.reasoning_effort ||
    apiKey.trim().length > 0;
  const save = async () => {
    if (!saved?.defaults) return;
    const body = SaveModelSettings.parse({
      vm_id: vm.id,
      expected_revision_id: saved.binding?.revision_id ?? null,
      selection,
      ...(usesKey && apiKey.trim() ? { api_key: apiKey.trim() } : {}),
    });
    const controller = new AbortController();
    operation.current?.abort();
    operation.current = controller;
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const value = ModelSettings.parse(
        await http.put('/v1/model-settings', { json: body, signal: controller.signal }).json<unknown>(),
      );
      if (controller.signal.aborted) return;
      setSaved(value);
      setSelection(value.binding?.selection ?? selection);
      setApiKey('');
      setNotice('저장했어요. 다음에 시작하는 작업부터 적용돼요. 실제 모델 연결은 아직 확인하지 않았어요.');
    } catch (failure) {
      if (!controller.signal.aborted) setError(errorMessage(failure));
    } finally {
      if (!controller.signal.aborted) setSaving(false);
    }
  };
  return (
    <section className="model-settings" aria-label={`${vm.name} 모델 설정`}>
      {loading && !saved && <LoadingSkeleton layout="model" label="모델 설정을 불러오는 중이에요." />}
      {loading && saved && (
        <p className="settings-loading" role="status">
          모델 설정을 불러오는 중이에요.
        </p>
      )}
      {error && (
        <div className="model-settings-error">
          <ErrorNotice>{error}</ErrorNotice>
          <Button disabled={loading || saving} onClick={() => void load()}>
            <RefreshCw size={14} />
            최신 설정으로 다시 불러오기
          </Button>
        </div>
      )}
      {saved && (
        <>
          <div className="model-current">
            <span>{saved.binding?.revision_id ? '저장된 모델' : '컴퓨터 기본 모델'}</span>
            <strong>
              {current
                ? `${providerName(current.provider)} · ${current.model}`
                : '아직 보고된 기본 모델이 없어요.'}
            </strong>
          </div>
          {!saved.defaults && (
            <div className="model-settings-error">
              <p className="model-field-help" role="status">
                컴퓨터의 모델 설정 기능이 아직 준비되지 않았어요. 컴퓨터가 연결되고 준비되면 다시 불러와
                주세요.
              </p>
              <Button disabled={loading || saving} onClick={() => void load()}>
                <RefreshCw size={14} />
                준비되면 다시 불러오기
              </Button>
            </div>
          )}
          {selection.provider === 'chatgpt' && <ChatgptAccountPanel vmId={vm.id} onComputer={onComputer} onChanged={refreshConnections} />}
          {selection.provider === 'subscription' && <SubscriptionAccountPanel vmId={vm.id} onModels={setSubscriptionModels} onChanged={refreshConnections} onComputer={onComputer} />}
          <form
            className="model-settings-form"
            aria-busy={saving}
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <fieldset disabled={loading || saving}>
              <label htmlFor={`${id}-provider`}>연결 방식</label>
              <select
                id={`${id}-provider`}
                value={selection.provider}
                onChange={(event) => {
                  const provider = ModelProvider.parse(event.target.value);
                  setSelection(
                    saved.binding?.selection.provider === provider
                      ? saved.binding.selection
                      : {
                          provider,
                          model: provider === 'subscription' ? '' : provider === 'anthropic' ? claudeModels[0] : gptModels[0],
                          reasoning_effort: null,
                        },
                  );
                  setApiKey('');
                  setError('');
                  setNotice('');
                }}
              >
                {providers.map((provider) => (
                  <option key={provider.id} value={provider.id}>
                    {provider.label} ·{' '}
                    {saved.saved_credentials.includes(provider.id)
                      ? '저장된 키'
                      : saved.defaults?.available.includes(provider.id)
                        ? '컴퓨터에 설정됨'
                        : '연결 필요'}
                  </option>
                ))}
              </select>
              <p className="model-field-help">
                {stored
                  ? '이 제공자의 API 키가 저장되어 있어요.'
                  : available
                    ? '이 컴퓨터에 설정된 연결을 사용할 수 있어요.'
                     : selection.provider === 'subscription'
                       ? '위에서 구독 계정을 연결해 주세요.'
                     : selection.provider === 'chatgpt'
                      ? '이 컴퓨터에서 ChatGPT 계정을 먼저 연결해 주세요.'
                      : '사용할 API 키를 입력해 주세요.'}{' '}
                연결 성공 여부는 실제 요청에서 확인돼요.
              </p>
              <label htmlFor={`${id}-model`}>모델 ID</label>
              {selection.provider === 'subscription' ? <select id={`${id}-model`} value={selection.model} required disabled={!subscriptionModels.length} onChange={event => { setSelection({ ...selection, model: event.target.value }); setNotice(''); }}>
                <option value="">모델 선택</option>
                {selection.model && !subscriptionModels.some(model => model.id === selection.model) && <option value={selection.model} disabled>{selection.model} · 목록에 없음</option>}
                {subscriptionModels.map(model => <option key={model.id} value={model.id}>{model.id}</option>)}
              </select> : <><input
                id={`${id}-model`}
                list={`${id}-models`}
                value={selection.model}
                required
                maxLength={120}
                pattern={`${selection.provider === 'anthropic' ? 'claude-' : 'gpt-'}[a-zA-Z0-9._:\\-]+`}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => {
                  setSelection({ ...selection, model: event.target.value });
                  setNotice('');
                }}
              />
              <datalist id={`${id}-models`}>
                {(selection.provider === 'anthropic' ? claudeModels : gptModels).map((model) => (
                  <option key={model} value={model} />
                ))}
              </datalist>
              <p className="model-field-help">
                목록에서 고르거나 {selection.provider === 'anthropic' ? 'claude-' : 'gpt-'}로 시작하는 정확한
                모델 ID를 입력하세요.
              </p>
              </>}
              {selection.provider === 'anthropic' ? (
                <p className="model-field-help">Claude의 기본 사고 설정을 사용해요.</p>
              ) : (
                <>
                  <label htmlFor={`${id}-effort`}>추론 강도</label>
                  <select
                    id={`${id}-effort`}
                    value={selection.reasoning_effort ?? 'auto'}
                    onChange={(event) => {
                      const next = effort.parse(event.target.value);
                      setSelection({ ...selection, reasoning_effort: next === 'auto' ? null : next });
                      setNotice('');
                    }}
                  >
                    <option value="auto">모델 기본값</option>
                    {['low', 'medium', 'high', 'xhigh', 'max'].map((value) => (
                      <option key={value} value={value}>
                        {value}
                      </option>
                    ))}
                  </select>
                </>
              )}
              {usesKey && (
                <>
                  <label htmlFor={`${id}-key`}>{keyRequired ? 'API 키' : '새 API 키 (선택)'}</label>
                  <input
                    id={`${id}-key`}
                    type="password"
                    value={apiKey}
                    required={keyRequired}
                    maxLength={4096}
                    autoComplete="new-password"
                    spellCheck={false}
                    placeholder={keyRequired ? 'API 키 입력' : '비워 두면 기존 연결 유지'}
                    onChange={(event) => {
                      setApiKey(event.target.value);
                      setNotice('');
                    }}
                  />
                  <p className="model-field-help">
                    키는 다시 표시하지 않으며 이 브라우저에 저장하지 않아요. API 사용 요금은 제공자 계정에
                    청구돼요.
                  </p>
                </>
              )}
            </fieldset>
            <Button
              type="submit"
              className="primary"
              busy={saving}
              disabled={
                loading ||
                !saved.defaults ||
                !valid ||
                !changed ||
                needsAccount ||
                (keyRequired && !apiKey.trim())
              }
            >
              모델 설정 저장
            </Button>
          </form>
        </>
      )}
      {notice && (
        <p className="settings-notice" role="status">
          {notice}
        </p>
      )}
      <p className="model-application-note">
        새로 시작하는 작업에 적용돼요. 진행 중인 작업과 그 작업의 메모리 처리는 시작할 때 선택한 모델을
        유지해요. 새 후속 확인은 선택한 모델을 사용해요.
      </p>
    </section>
  );
}

export function ModelSettingsPanel({ vms, onComputer }: { readonly vms: readonly Vm[]; readonly onComputer?: (() => void) | undefined }) {
  const [selected, setSelected] = useState(vms[0]?.id ?? '');
  const vm = vms.find((item) => item.id === selected) ?? vms[0];
  return (
    <div className="model-settings-panel">
      <p className="settings-intro">새로 시작하는 작업에 쓸 모델을 골라요.</p>
      {!vm ? (
        <Empty icon={<Monitor size={24} />} title="컴퓨터를 연결해 주세요">
          등록된 컴퓨터가 있어야 모델을 설정할 수 있어요.
        </Empty>
      ) : (
        <>
          <label className="settings-vm">
            <span>
              <Monitor size={14} />
              적용할 컴퓨터
            </span>
            <select value={vm.id} onChange={(event) => setSelected(event.target.value)}>
              {vms.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <ModelEditor key={vm.id} vm={vm} onComputer={onComputer} />
        </>
      )}
    </div>
  );
}
