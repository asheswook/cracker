import { useState } from 'react';
import { http, errorMessage } from '../api';
import { Button, ErrorNotice } from '../primitives';
import { EditDialog } from './EditDialog';
export function RemoveDialog({
  kind,
  id,
  name,
  onClose,
  onRemoved,
}: {
  kind: 'skills' | 'servers';
  id: string;
  name: string;
  onClose: () => void;
  onRemoved: () => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const remove = async () => {
    setBusy(true);
    setError('');
    try {
      await http.delete(`/v1/extensions/${kind}/${id}`);
      await onRemoved();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <EditDialog
      title={kind === 'skills' ? '스킬 보관' : '서버 연결을 삭제할까요?'}
      busy={busy}
      onClose={onClose}
    >
      <div className="settings-form">
        <div className="settings-form-body">
          <p>
            <strong>{name}</strong>{' '}
            {kind === 'skills'
              ? '스킬을 일반 목록에서 숨기고 사용을 꺼요. 버전과 실행 기록은 보존돼요. 이 버전에 고정된 예약은 계속 실행되며, 예약 화면에서 별도로 취소할 수 있어요.'
              : '설정을 삭제해요. 컴퓨터에는 실행 중인 작업이 끝난 뒤 반영돼요.'}
          </p>
          {error && <ErrorNotice>{error}</ErrorNotice>}
        </div>
        <footer>
          <Button autoFocus disabled={busy} onClick={onClose}>
            유지하기
          </Button>
          <Button className="danger" busy={busy} onClick={() => void remove()}>
            {kind === 'skills' ? '보관하기' : '삭제'}
          </Button>
        </footer>
      </div>
    </EditDialog>
  );
}
