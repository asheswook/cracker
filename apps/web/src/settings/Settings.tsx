import { useId, useRef, useState } from 'react';
import { BookOpen, Plug, Plus, Upload, RefreshCw, Monitor } from 'lucide-react';
import { http, errorMessage } from '../api';
import { Button, Empty, ErrorNotice, IconButton } from '../primitives';
import type { Id, Vm } from '../types';
import type { Skill, Server, SkillDraft } from './types';
import { useExtensions } from './useExtensions';
import { ExtensionCard } from './ExtensionCard';
import { SettingsTabs } from './SettingsTabs';
import type { SettingsTab } from './SettingsTabs';
import { InstructionsPanel } from './InstructionsPanel';
import { ModelSettingsPanel } from './ModelSettingsPanel';
import { SkillEditor } from './SkillEditor';
import { ServerEditor } from './ServerEditor';
import { RemoveDialog } from './RemoveDialog';
import { NotificationPanel } from '../NotificationPanel';
import { SkillWorkflow } from './SkillWorkflow';
import { AppearancePanel } from '../appearance/AppearancePanel';
import { LoadingSkeleton } from '../LoadingSkeleton';
type Editor =
  | { kind: 'skills'; item: Skill | null; imported: SkillDraft | null }
  | { kind: 'servers'; item: Server | null };
function skillBody(item: Skill, enabled = item.enabled) {
  return {
    id: item.id,
    expected_revision: item.revision,
    vm_id: item.vm_id,
    name: item.name,
    description: item.description,
    content: item.content,
    enabled,
  };
}
function serverBody(item: Server, enabled = item.enabled) {
  return { id: item.id, vm_id: item.vm_id, name: item.name, config: item.config, enabled };
}
export function Settings({ vms, connected, onComputer }: { vms: Vm[]; connected: boolean; onComputer?: (() => void) | undefined }) {
  const tabsId = useId();
  const [tab, setTab] = useState<SettingsTab>('instructions');
  const [selected, setSelected] = useState<Id | undefined>(vms[0]?.id);
  const vm = vms.find((item) => item.id === selected) ?? vms[0];
  const [archivedSkills, setArchivedSkills] = useState(false);
  const extensions = useExtensions(vm?.id, archivedSkills);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [workflow, setWorkflow] = useState<Skill | null>(null);
  const [remove, setRemove] = useState<{ kind: 'skills' | 'servers'; id: string; name: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const upload = useRef<HTMLInputElement>(null);
  const mutate = async (id: string, path: string, body: unknown) => {
    setBusy(id);
    setError('');
    setNotice('');
    try {
      await http.post(path, { json: body });
      await extensions.refresh(true);
      setNotice('변경 내용을 저장했어요. 컴퓨터 반영 상태를 확인해 주세요.');
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(null);
    }
  };
  const saved = async () => {
    await extensions.refresh(true);
    setEditor(null);
    setNotice('설정을 저장했어요. 컴퓨터 반영 상태를 확인해 주세요.');
  };
  const importFile = async (file: File) => {
    setError('');
    if (file.size > 65536) {
      setError('스킬 문서는 64KB까지 가져올 수 있어요.');
      return;
    }
    try {
      const content = await file.text();
      if (!content.trim()) throw new Error('빈 문서는 스킬로 저장할 수 없어요.');
      const name =
        content.match(/^name:\s*["']?([^\n"']+)/m)?.[1]?.trim() ?? file.name.replace(/\.(md|markdown)$/i, '');
      const description = content.match(/^description:\s*["']?([^\n"']+)/m)?.[1]?.trim() ?? '';
      setEditor({
        kind: 'skills',
        item: null,
        imported: {
          name: name.slice(0, 64),
          description: description.slice(0, 1000),
          content,
          enabled: false,
        },
      });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '파일을 읽지 못했어요.');
    }
  };
  const items = tab === 'skills' ? extensions.data?.skills.filter(item => Boolean(item.archived_at) === archivedSkills) : extensions.data?.servers;
  return (
    <div className="settings-panel">
      <SettingsTabs
        id={tabsId}
        selected={tab}
        onChange={(next) => {
          setTab(next);
          setError('');
          setNotice('');
        }}
      />
      <div
        role="tabpanel"
        id={`${tabsId}-panel`}
        aria-labelledby={`${tabsId}-${tab}`}
        aria-label={
          tab === 'instructions' ? '페르소나 설정' : tab === 'appearance' ? '외형 설정' : tab === 'models' ? '모델 설정' : tab === 'skills' ? '스킬 설정' : tab === 'notifications' ? '알림 설정' : 'MCP 서버 설정'
        }
      >
        {tab === 'instructions' ? (
          <InstructionsPanel />
        ) : tab === 'appearance' ? (
          <AppearancePanel />
        ) : tab === 'models' ? (
          <ModelSettingsPanel vms={vms} onComputer={onComputer} />
        ) : tab === 'notifications' ? (
          <NotificationPanel />
        ) : (
          <>
            {vm ? (
              <label className="settings-vm">
                <span>
                  <Monitor size={14} />
                  적용할 컴퓨터
                </span>
                <select
                  value={vm.id}
                  onChange={(e) => {
                    setSelected(e.target.value as Id);
                    setError('');
                    setNotice('');
                  }}
                >
                  {vms.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <div className="settings-section-heading">
              <div>
                <h2>{tab === 'skills' ? archivedSkills ? '보관된 스킬' : '스킬' : 'MCP 서버'}</h2>
                <p>
                  {tab === 'skills'
                    ? '필요할 때 꺼내 쓰는 작업 방식이에요.'
                    : '어시스턴트가 사용할 도구를 연결해요.'}
                </p>
              </div>
              <IconButton
                label={tab === 'skills' ? '스킬 추가' : 'MCP 서버 추가'}
                disabled={!vm || (tab === 'skills' && archivedSkills)}
                onClick={() => {
                  setError('');
                  setEditor(
                    tab === 'skills'
                      ? { kind: 'skills', item: null, imported: null }
                      : { kind: 'servers', item: null },
                  );
                }}
              >
                <Plus size={19} />
              </IconButton>
            </div>
            {tab === 'skills' && (
              <>
                <label className="check-label"><input type="checkbox" checked={archivedSkills} onChange={event=>setArchivedSkills(event.target.checked)}/>보관된 스킬 보기</label>
                <input
                  ref={upload}
                  type="file"
                  accept=".md,.markdown,text/markdown,text/plain"
                  hidden
                  aria-label="스킬 Markdown 파일"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.target.value = '';
                    if (file) void importFile(file);
                  }}
                />
                <Button className="settings-import" disabled={!vm || archivedSkills} onClick={() => upload.current?.click()}>
                  <Upload size={14} />
                  Markdown 가져오기
                </Button>
              </>
            )}
            {(error || extensions.error) && (
              <div className="settings-error">
                <ErrorNotice>{error || extensions.error}</ErrorNotice>
                {extensions.error && (
                  <Button onClick={() => void extensions.refresh()}>
                    <RefreshCw size={14} />
                    다시 불러오기
                  </Button>
                )}
              </div>
            )}
            {notice && (
              <p className="settings-notice" role="status">
                {notice}
              </p>
            )}
            {!vm ? (
              <Empty icon={<Monitor size={24} />} title="컴퓨터를 연결해 주세요">
                등록된 컴퓨터가 있어야 스킬과 도구를 설정할 수 있어요.
              </Empty>
            ) : extensions.data === null && !extensions.error ? (
              <LoadingSkeleton label="설정을 불러오는 중이에요." />
            ) : items?.length === 0 ? (
              <Empty
                icon={tab === 'skills' ? <BookOpen size={24} /> : <Plug size={24} />}
                title={tab === 'skills' ? archivedSkills ? '보관된 스킬이 없어요' : '첫 스킬을 추가해 보세요' : '아직 연결한 서버가 없어요'}
              >
                {tab === 'skills'
                  ? '직접 작성하거나 기존 SKILL.md를 가져올 수 있어요.'
                  : 'HTTP 주소나 컴퓨터에서 실행할 명령으로 연결할 수 있어요.'}
              </Empty>
            ) : (
              <ul className="extension-list">
                {items?.map((item) => (
                  <ExtensionCard
                    key={item.id}
                    item={item}
                    vm={vm}
                    stale={!connected || !!extensions.error}
                    busy={busy !== null}
                    onToggle={(enabled) =>
                      void mutate(
                        item.id,
                        `/v1/extensions/${tab}`,
                        'description' in item ? skillBody(item, enabled) : serverBody(item, enabled),
                      )
                    }
                    onEdit={() =>
                      setEditor(
                        'description' in item
                          ? { kind: 'skills', item, imported: null }
                          : { kind: 'servers', item },
                      )
                    }
                    onWorkflow={'description' in item ? () => setWorkflow(item) : undefined}
                    onRetry={() =>
                      void mutate(
                        item.id,
                        'description' in item
                          ? '/v1/extensions/skills'
                          : `/v1/extensions/servers/${item.id}/retry`,
                        'description' in item ? skillBody(item) : {},
                      )
                    }
                    onRemove={() =>
                      setRemove({
                        kind: 'description' in item ? 'skills' : 'servers',
                        id: item.id,
                        name: item.name,
                      })
                    }
                  />
                ))}
              </ul>
            )}
          </>
        )}
      </div>
      {editor &&
        vm &&
        (editor.kind === 'skills' ? (
          <SkillEditor
            vm={vm.id}
            item={editor.item}
            imported={editor.imported}
            onClose={() => setEditor(null)}
            onSaved={saved}
          />
        ) : (
          <ServerEditor vm={vm.id} item={editor.item} onClose={() => setEditor(null)} onSaved={saved} />
        ))}
      {remove && (
        <RemoveDialog
          {...remove}
          onClose={() => setRemove(null)}
          onRemoved={async () => {
            await extensions.refresh(true);
            setRemove(null);
            setNotice(remove.kind === 'skills' ? '스킬을 보관했어요. 기존 버전과 고정된 예약은 유지돼요.' : '서버 연결을 삭제했어요. 컴퓨터에는 작업이 끝난 뒤 반영돼요.');
          }}
        />
      )}
      {workflow && <SkillWorkflow key={workflow.id} skill={workflow} onClose={() => setWorkflow(null)} />}
    </div>
  );
}
