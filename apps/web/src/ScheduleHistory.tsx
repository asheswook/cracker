import { useEffect, useState } from 'react';
import { ArrowUpRight } from 'lucide-react';
import { z } from 'zod';
import { HTTPError } from 'ky';
import { ResponsibilityHistory, ResponsibilityRun } from '../../../packages/memory/responsibility-history-schema';
import { errorMessage, read } from './api';
import { Button, ErrorNotice } from './primitives';
import { Task, type Id } from './types';

const History = ResponsibilityHistory.extend({ runs: ResponsibilityRun.extend({ task: Task.nullable() }).array() });
const taskLabels: Readonly<Record<string, string>> = {
  queued: '대기 중', running: '진행 중', waiting: '응답 대기', pausing: '일시 정지 중',
  paused: '일시 정지', cancelling: '중지 확인 중', cancelled: '취소됨', succeeded: '완료',
  failed: '실패', unknown: '확인 필요',
};

export function ScheduleHistory({ responsibility, timezone, onTask }: {
  readonly responsibility: Id; readonly timezone: string | undefined;
  readonly onTask: (task: Task) => void;
}) {
  const [page, setPage] = useState<z.infer<typeof History> | null>(null);
  const [request, setRequest] = useState<{ readonly cursor: string | null; readonly revision: number }>({ cursor: null, revision: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    setLoading(true); setError('');
    const suffix = request.cursor ? `?cursor=${encodeURIComponent(request.cursor)}` : '';
    void read(`/v1/responsibilities/${responsibility}/history${suffix}`, History).then(result => {
      if (active) setPage(previous => ({
        ...result, runs: request.cursor && previous ? [...previous.runs, ...result.runs] : result.runs,
      }));
    }).catch((cause: unknown) => {
      if (active) setError(cause instanceof HTTPError && cause.response.status === 400
        ? '실행 기록을 새로고침한 뒤 다시 시도해 주세요.'
        : errorMessage(cause));
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [responsibility, request]);
  return <section className="schedule-history" aria-label="실행 기록">
    <div className="schedule-history-heading"><h3>실행 기록</h3>
      <Button className="small-button" disabled={loading} onClick={() => setRequest(value => ({ cursor: null, revision: value.revision + 1 }))}>새로고침</Button>
    </div>
    {loading && <p className="field-help" role="status">실행 기록을 불러오는 중…</p>}
    {error && <div><ErrorNotice>{error}</ErrorNotice><Button className="small-button" onClick={() => setRequest(value => ({ ...value, revision: value.revision + 1 }))}>다시 시도</Button></div>}
    {page?.runs.length === 0 && !loading && !error && <p className="field-help">아직 실행 기록이 없어요.</p>}
    {page && page.runs.length > 0 && <ol className="schedule-history-list" role="list">
      {page.runs.map(run => {
        const date = run.scheduled_for ?? run.created_at;
        return <li key={run.id}>
          <div className="schedule-history-meta">
            <time dateTime={date}>{new Date(date).toLocaleString('ko-KR', { timeZone: timezone, year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</time>
            <span>{run.task ? taskLabels[run.task.state] ?? '상태 확인 중' : run.state === 'pending' ? '시작 대기' : run.state === 'cancelled' ? '취소됨' : '작업 정보 없음'}</span>
          </div>
          {run.task && <Button className="small-button" onClick={() => { if (run.task) onTask(run.task); }} aria-label={`${new Date(date).toLocaleDateString('ko-KR', { timeZone: timezone })} 실행 보기`}><ArrowUpRight size={13} />실행 보기</Button>}
        </li>;
      })}
    </ol>}
    {page?.next_cursor && !error && <Button className="small-button" disabled={loading} onClick={() => setRequest(value => ({ cursor: page.next_cursor, revision: value.revision + 1 }))}>이전 실행 더 보기</Button>}
  </section>;
}
