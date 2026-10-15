import { useLayoutEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';

export function ScheduleObjective({ objective, open, onToggle }: {
  readonly objective: string;
  readonly open?: boolean;
  readonly onToggle?: (open: boolean) => void;
}) {
  const text = useRef<HTMLSpanElement>(null);
  const [long, setLong] = useState<string | null>(open ? objective : null);
  const expandable = long === objective;
  useLayoutEffect(() => {
    const element = text.current;
    if (!element) return;
    // Line height differs between the plain heading and the disclosure summary, so the threshold must only
    // ever switch on (text longer than three lines); switching back off from the other wrapper would oscillate.
    const measure = () => {
      if (element.clientWidth === 0) return;
      const lineHeight = Number.parseFloat(getComputedStyle(element).lineHeight);
      if (element.scrollHeight > lineHeight * 3 + 1) setLong(objective);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [objective]);
  const content = <span className="schedule-objective-text" ref={text}>{objective}</span>;
  if (!expandable) return <h3>{content}</h3>;
  return <details className="schedule-objective" open={open} onToggle={event => onToggle?.(event.currentTarget.open)}>
    <summary>
      {content}<span className="schedule-objective-toggle">
        <span className="schedule-objective-more">더 보기</span>
        <span className="schedule-objective-less">접기</span>
        <ChevronDown size={16} aria-hidden="true" />
      </span>
    </summary>
    <p className="schedule-objective-full">{objective}</p>
  </details>;
}
