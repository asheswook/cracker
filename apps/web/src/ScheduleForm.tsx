import { useState } from 'react';
import { client, useClient } from './store';
import { Button, ErrorNotice } from './primitives';
import { errorMessage } from './api';
export function ScheduleForm({ state, onDone, skill }: { state: ReturnType<typeof useClient>; onDone: () => void; skill?: {id: string; revision: number; name: string} }) {
  const [objective, setObjective] = useState('');
  const conversation = state.assistantId;
  const [due, setDue] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [scheduleId] = useState(() => crypto.randomUUID());
  return (
    <form
      className="schedule-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!conversation || !due) return;
        setBusy(true);
        setError('');
        void client
          .action('/v1/schedules', {
            conversation_id: conversation,
            objective,
            due_at: new Date(due).toISOString(),
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            client_schedule_id: scheduleId,
            ...(skill ? {skill_id: skill.id, skill_revision: skill.revision} : {}),
          })
          .then(onDone)
          .catch((e) => setError(errorMessage(e)))
          .finally(() => setBusy(false));
      }}
    >
      <p className="field-help">예약한 일의 결과는 {state.persona.name}와의 메시지에 도착해요.</p>
      {skill && <p className="field-help">{skill.name} · 버전 {skill.revision}에 고정돼요. 이후 스킬을 편집해도 이 예약의 버전은 바뀌지 않아요.</p>}
      <label>
        맡길 일
        <textarea
          required
          value={objective}
          onChange={(e) => setObjective(e.target.value)}
          placeholder="어떤 일을 시작할까요?"
        />
      </label>
      <label>
        시작 시간
        <input type="datetime-local" required value={due} onChange={(e) => setDue(e.target.value)} />
      </label>
      {error && <ErrorNotice>{error}</ErrorNotice>}
      <Button
        className="primary"
        type="submit"
        busy={busy}
        disabled={!conversation || !objective.trim() || !due}
      >
        한 번 예약하기
      </Button>
    </form>
  );
}
