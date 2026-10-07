import { MarkdownMessage } from './MarkdownMessage';

export function MessageBubble({
  role,
  content,
}: {
  readonly role: 'user' | 'assistant';
  readonly content: string;
}) {
  if (!content) return null;
  return (
    <div className={`bubble ${role}${role === 'assistant' ? ' markdown-bubble' : ''}`}>
      {role === 'assistant' ? <MarkdownMessage content={content} /> : content}
    </div>
  );
}
