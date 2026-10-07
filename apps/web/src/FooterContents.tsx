import { LatestButton } from './LatestButton';
import { DraftAttachmentsView } from './DraftAttachmentsView';
import { Button, ErrorNotice } from './primitives';
import type { FooterActionName, FooterPropsValue } from './independent-footer-protocol';
export function FooterContents({ value, action }: Readonly<{ value: FooterPropsValue; action: (name: FooterActionName, id?: string) => void }>) {
  return <>
    {value.latest && <LatestButton onLatest={() => action('latest')} />}
    {value.readOnly ? <p className="archive-footnote">기록은 그대로 보관돼요. 새 메시지는 어시스턴트 대화에서 보낼 수 있어요.</p> : <>
      {value.error && <ErrorNotice>{value.error}</ErrorNotice>}
      {value.storage.failed && <div className="attachment-store-recovery" role="status"><span>보관된 첨부 파일을 확인하지 못했어요.</span>
        <Button type="button" busy={value.storage.retrying} onClick={() => action('retry-storage')}>첨부 다시 확인</Button></div>}
      {value.drafts.length > 0 && <DraftAttachmentsView drafts={value.drafts} onRetry={id => action('retry-upload', id)} onRemove={id => action('remove-draft', id)} />}
    </>}
  </>;
}
