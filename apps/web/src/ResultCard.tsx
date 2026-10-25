import { CalendarCheck, Check, DoorOpen, ExternalLink, Mail, MessageSquare, Pencil, Send, Trash2 } from 'lucide-react';
import type { ResultBlock } from './types';
import './result-card.css';

const verb: Record<ResultBlock['action'], string> = {
  sent: '보냄', posted: '게시함', scheduled: '일정 등록함', booked: '예약함', updated: '바꿈', deleted: '삭제함', created: '만듦',
};
const when = new Intl.DateTimeFormat('ko-KR', { month: 'numeric', day: 'numeric', weekday: 'short', hour: 'numeric', minute: '2-digit' });

function icon(block: ResultBlock) {
  const channel = block.channel.toLowerCase();
  if (block.action === 'deleted') return Trash2;
  if (block.action === 'updated') return Pencil;
  if (block.action === 'booked' || /회의실|room/.test(channel)) return DoorOpen;
  if (block.action === 'scheduled' || /calendar|캘린더/.test(channel)) return CalendarCheck;
  if (/mail|메일/.test(channel)) return Mail;
  if (/slack|메신저|카톡|kakao|discord|teams/.test(channel)) return MessageSquare;
  return Send;
}

/** A finished action the user asked for. No buttons: it reports what happened, with a link when there is one. */
function targetLabel(block: ResultBlock): string {
  const channel = block.channel.toLowerCase();
  if (block.action === 'booked' || /회의실|room/.test(channel)) return '장소';
  if (block.action === 'scheduled' || /calendar|캘린더/.test(channel)) return '캘린더';
  if (/slack|discord|teams|채널/.test(channel)) return '채널';
  return '받는 사람';
}

export function ResultCard({ block }: { readonly block: ResultBlock }) {
  const Icon = icon(block);
  const at = block.at ? new Date(block.at) : null;
  return (
    <section className="result-card" aria-label={`${block.channel} ${verb[block.action]}`}>
      <header>
        <span className="result-card-icon" aria-hidden="true"><Icon size={15} /></span>
        <span className="result-card-channel">{block.channel}</span>
        <span className="result-card-state"><Check size={12} aria-hidden="true" />{verb[block.action]}</span>
      </header>
      {(block.target || block.title) && (
        <dl>
          {block.target && <><dt>{targetLabel(block)}</dt><dd>{block.target}</dd></>}
          {block.title && <><dt>제목</dt><dd>{block.title}</dd></>}
          {at && !Number.isNaN(at.getTime()) && <><dt>시각</dt><dd><time dateTime={block.at ?? undefined}>{when.format(at)}</time></dd></>}
        </dl>
      )}
      {!block.target && !block.title && at && !Number.isNaN(at.getTime()) && <p className="result-card-time"><time dateTime={block.at ?? undefined}>{when.format(at)}</time></p>}
      {block.body && <p className="result-card-body">{block.body}</p>}
      {block.url && (
        <a className="result-card-link" href={block.url} target="_blank" rel="noreferrer noopener">
          원문 열기<ExternalLink size={12} aria-hidden="true" />
        </a>
      )}
    </section>
  );
}
