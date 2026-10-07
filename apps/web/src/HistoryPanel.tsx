import { useState } from 'react';
import { ArrowUpRight, History } from 'lucide-react';
import { Empty } from './primitives';
import type { Conversation, Id } from './types';
import { compareNewestCreated } from './recent-order';
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
  const records = conversations.filter(
    (item) =>
      item.id !== assistantId && item.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
  ).sort(compareNewestCreated);
  return (
    <section aria-label="이전 대화 기록">
      <p className="field-help">
        이전에 나눈 대화는 그대로 보관돼요. 앞으로의 대화는 하나의 메시지 흐름으로 이어집니다.
      </p>
      <div className="work-tools">
        <input
          type="search"
          aria-label="이전 대화 검색"
          placeholder="제목으로 찾기"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      {records.length ? (
        records.map((item) => (
          <button key={item.id} type="button" className="history-link" onClick={() => onOpen(item.id)}>
            <span>
              {item.title}
              <small>{new Date(item.created_at).toLocaleDateString('ko-KR')}</small>
            </span>
            <ArrowUpRight size={16} />
          </button>
        ))
      ) : (
        <Empty
          icon={<History size={24} />}
          title={query ? '일치하는 기록이 없어요' : '이전 대화 기록이 없어요'}
        >
          현재 대화는 메시지에서 이어갈 수 있어요.
        </Empty>
      )}
    </section>
  );
}
