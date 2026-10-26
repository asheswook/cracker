import type { Message } from './types';

export const BACKGROUND_RUN_PREFIX = '예약된 작업 실행: ';
export const BACKGROUND_RUN_FALLBACK = '자동 작업';

export function isBackgroundMessage(message: Message): boolean {
  // A card waiting for the user is never folded away: it must stay answerable in the conversation.
  if (message.blocks?.some(block => block.kind === 'draft' || block.kind === 'choice')) return false;
  return !message.notify && (message.origin === 'schedule' || message.origin === 'responsibility');
}

export type BackgroundRun = {
  readonly kind: 'run';
  readonly messages: readonly Message[];
  readonly title: string;
  readonly preview: string;
  readonly at: string;
};
export type FeedItem = { readonly kind: 'message'; readonly message: Message } | BackgroundRun;

// A wake line carries the objective; the first readable line of the reply is enough to recognise the result.
function firstLine(content: string): string {
  for (const raw of content.split(/\r?\n/)) {
    const line = raw
      .replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/, '')
      .replace(/\*\*|__|~~|`/g, '')
      .trim();
    if (line && !/^\|?[\s:|-]+\|?$/.test(line)) return line.replace(/^\||\|$/g, '').replace(/\s*\|\s*/g, ' · ').trim();
  }
  return '';
}

/** Assistant-owned source jobs carry English model instructions as their objective; show what they are, in Korean. */
export function readableTitle(line: string): string {
  const account = line.match(/for ([\w.+-]+@[\w.-]+|[\w-]+) \(/)?.[1] ?? line.match(/\(([\w.+-]+@[\w.-]+)/)?.[1];
  const subject = line.match(/Thread: (.+?)(?: \(from\b|, id\b)/)?.[1] ?? line.match(/"([^"]+)"\)?\.?$/)?.[1];
  if (/^(Gmail|Slack) observation for/.test(line)) return `${line.startsWith('Slack') ? 'Slack' : 'Gmail'} 확인${account ? ` · ${account}` : ''}`;
  if (/Prepare a reply draft/.test(line)) return `답장 초안 쓰기${subject ? ` · ${subject}` : ''}`;
  if (/^Send (exactly )?one approved/.test(line)) return `승인한 답장 보내기${subject ? ` · ${subject}` : ''}`;
  if (/^Check whether an approved reply went out/.test(line)) return '보낸 답장 확인';
  return line;
}
function run(messages: readonly Message[], objectives: ReadonlyMap<string, string>): BackgroundRun {
  const wake = messages.find(message => message.role === 'system');
  const task = messages.find(message => message.task_id)?.task_id;
  const line = (wake ? wake.content : (task && objectives.get(task)) || '').split(/\r?\n/, 1)[0]?.trim() ?? '';
  const title = readableTitle(line.startsWith(BACKGROUND_RUN_PREFIX) ? line.slice(BACKGROUND_RUN_PREFIX.length).trim() : line);
  const reply = [...messages].reverse().find(message => message.role === 'assistant');
  return {
    kind: 'run',
    messages,
    title: title || BACKGROUND_RUN_FALLBACK,
    preview: reply ? firstLine(reply.content) : '',
    at: (reply ?? messages.at(-1) ?? messages[0])?.created_at ?? '',
  };
}

/** Consecutive background messages of one task collapse into a single run; untasked ones stand alone. */
export function feedItems(messages: readonly Message[], objectives: ReadonlyMap<string, string> = new Map()): FeedItem[] {
  const items: FeedItem[] = [];
  let group: Message[] = [];
  const flush = () => {
    if (group.length) items.push(run(group, objectives));
    group = [];
  };
  for (const message of messages) {
    if (!isBackgroundMessage(message)) {
      flush();
      items.push({ kind: 'message', message });
      continue;
    }
    const previous = group.at(-1);
    if (!previous || !message.task_id || previous.task_id !== message.task_id) flush();
    group.push(message);
    if (!message.task_id) flush();
  }
  flush();
  return items;
}
