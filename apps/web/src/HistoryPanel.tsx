import { useMemo, useState } from 'react';
import { ChevronRight, History } from 'lucide-react';
import { Empty } from './primitives';
import type { Conversation, Id } from './types';
import { conversationLabel } from './feed-labels';

const dateFormat = new Intl.DateTimeFormat('ko-KR', { month: 'short', day: 'numeric' });
const yearFormat = new Intl.DateTimeFormat('ko-KR', { year: 'numeric', month: 'short', day: 'numeric' });

function when(iso: string): string {
  const date = new Date(iso);
  return (date.getFullYear() === new Date().getFullYear() ? dateFormat : yearFormat).format(date);
}

export function HistoryPanel({
  conversations,
  assistantId,
  onOpen,
}: {
  conversations: Conversation[];
  assistantId: Id | null;
  onOpen: (id: Id) => void;
}) {
  const [query, setQuery] = useState('');
  const records = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return conversations
      .filter(item => item.id !== assistantId && (item.message_count ?? 1) > 0)
      .map(item => ({ item, label: conversationLabel(item), at: item.last_message_at ?? item.created_at }))
      .filter(({ item, label }) => !needle || `${label.title} ${label.detail ?? ''} ${item.title}`.toLocaleLowerCase().includes(needle))
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  }, [conversations, assistantId, query]);
  return (
    <section aria-label="이전 대화 기록" className="history-panel">
      <input
        className="history-search"
        type="search"
        aria-label="이전 대화 검색"
        placeholder="대화 찾기"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      {records.length ? (
        <ul className="history-list">
          {records.map(({ item, label, at }) => (
            <li key={item.id}>
              <button type="button" className="history-link" onClick={() => onOpen(item.id)}>
                <span className="history-text">
                  <span className="history-title">{label.title}</span>
                  {label.detail && <span className="history-detail">{label.detail}</span>}
                </span>
                <time dateTime={at}>{when(at)}</time>
                <ChevronRight size={16} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <Empty icon={<History size={24} />} title={query ? '찾는 대화가 없어요' : '이전 대화가 없어요'}>
          {query ? '다른 단어로 찾아보세요.' : '지금 대화는 메시지에서 이어갈 수 있어요.'}
        </Empty>
      )}
    </section>
  );
}
