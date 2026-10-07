import { Pencil, RefreshCw, Trash2 } from 'lucide-react';
import { Button, IconButton } from '../primitives';
import type { Vm } from '../types';
import type { Skill, Server } from './types';
import { ExtensionStatus } from './Status';
export function ExtensionCard({
  item,
  vm,
  stale,
  busy,
  onToggle,
  onEdit,
  onRetry,
  onRemove,
  onWorkflow,
}: {
  item: Skill | Server;
  vm: Vm | undefined;
  stale: boolean;
  busy: boolean;
  onToggle: (enabled: boolean) => void;
  onEdit: () => void;
  onRetry: () => void;
  onRemove: () => void;
  onWorkflow?: (() => void) | undefined;
}) {
  const archived = 'description' in item && Boolean(item.archived_at);
  return (
    <li className="extension-card">
      <div className="extension-card-heading">
        <h3>{item.name}</h3>
        <label className="extension-toggle">
          <input
            type="checkbox"
            checked={item.enabled}
            disabled={busy || archived}
            aria-label={`${item.name} 사용`}
            onChange={(event) => onToggle(event.target.checked)}
          />
          <span aria-hidden="true" />
        </label>
      </div>
      <p className="extension-description">
        {'description' in item
          ? item.description
          : item.config.transport === 'http'
            ? new URL(item.config.url).origin + new URL(item.config.url).pathname
            : `${item.config.command} · stdio`}
      </p>
      {archived ? (
        <p className="field-help">보관됨 · 일반 사용 꺼짐 · 버전과 실행 기록 보존</p>
      ) : (
        <ExtensionStatus item={item} vm={vm} stale={stale} />
      )}
      <div className="extension-actions">
        {onWorkflow && (
          <Button className="small-button" disabled={busy} onClick={onWorkflow}>
            버전·실행
          </Button>
        )}
        <Button className="small-button" disabled={busy || archived} onClick={onEdit}>
          <Pencil size={13} />
          편집
        </Button>
        {item.state === 'error' && !archived && (
          <Button className="small-button" busy={busy} onClick={onRetry}>
            <RefreshCw size={13} />
            다시 시도
          </Button>
        )}
        {!archived && (
          <IconButton
            label={`${item.name} ${'description' in item ? '보관' : '삭제'}`}
            disabled={busy}
            onClick={onRemove}
          >
            <Trash2 size={14} />
          </IconButton>
        )}
      </div>
    </li>
  );
}
