import { memo, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import type { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkCjkFriendly from 'remark-cjk-friendly/parseOnly';
import { Check, Copy } from 'lucide-react';
import { Id } from './types';
import './MarkdownMessage.css';

function CodeBlock({ children }: { readonly children?: ReactNode }) {
  const pre = useRef<HTMLPreElement>(null);
  const [status, setStatus] = useState<'idle' | 'copied' | 'failed'>('idle');
  useEffect(() => {
    if (status !== 'copied') return;
    const timer = setTimeout(() => setStatus('idle'), 1800);
    return () => clearTimeout(timer);
  }, [status]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(pre.current?.textContent ?? '');
      setStatus('copied');
    } catch (error) {
      if (error instanceof Error) setStatus('failed');
      else throw error;
    }
  };
  return (
    <div className="markdown-code">
      <div className="markdown-code-toolbar">
        <span>코드</span>
        <button type="button" onClick={() => void copy()} aria-label="코드 복사">
          {status === 'copied' ? <Check size={13} /> : <Copy size={13} />}
          <span aria-live="polite">
            {status === 'copied' ? '복사됨' : status === 'failed' ? '복사 실패 · 다시 시도' : '복사'}
          </span>
        </button>
      </div>
      <pre ref={pre} tabIndex={0} aria-label="코드 블록">
        {children}
      </pre>
    </div>
  );
}
const components: Components = {
  pre: CodeBlock,
  table: ({ children }) => (
    <div className="markdown-table-scroll" role="region" aria-label="표" tabIndex={0}>
      <table>{children}</table>
    </div>
  ),
  a: ({ href, children, title }) =>
    href ? (
      <a href={href} title={title} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),
};
const plugins = [remarkCjkFriendly, remarkGfm];
function messageUrl(url: string): string {
  if (url.startsWith('attachment://')) {
    const id = Id.safeParse(url.slice('attachment://'.length));
    return id.success ? `/v1/artifacts/${id.data}/content` : '';
  }
  return defaultUrlTransform(url);
}
export const MarkdownMessage = memo(function MarkdownMessage({ content }: { readonly content: string }) {
  return (
    <div className="markdown-message">
      <ReactMarkdown remarkPlugins={plugins} components={components} urlTransform={messageUrl} skipHtml>
        {content}
      </ReactMarkdown>
    </div>
  );
});
