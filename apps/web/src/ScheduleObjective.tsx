import { useLayoutEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';

export function ScheduleObjective({ objective, open, onToggle }: {
  readonly objective: string;
  readonly open?: boolean;
  readonly onToggle?: (open: boolean) => void;
}) {
  const text = useRef<HTMLSpanElement>(null);
  const [expandable, setExpandable] = useState(open ?? false);
  useLayoutEffect(() => {
    const element = text.current;
    if (!element) return;
    const measure = () => {
      if (element.clientWidth === 0) return;
      const lineHeight = Number.parseFloat(getComputedStyle(element).lineHeight);
      setExpandable(element.scrollHeight > lineHeight * 3 + 1);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [objective, expandable]);
  const content = <span className="schedule-objective-text" ref={text}>{objective}</span>;
  if (!expandable) return <h3>{content}</h3>;
  return <details className="schedule-objective" open={open} onToggle={event => onToggle?.(event.currentTarget.open)}>
    <summary>
      {content}<span className="schedule-objective-toggle">
        <span className="schedule-objective-more">전체 내용 보기</span>
        <span className="schedule-objective-less">접기</span>
        <ChevronDown size={16} aria-hidden="true" />
      </span>
    </summary>
    <p className="schedule-objective-full">{objective}</p>
  </details>;
}
