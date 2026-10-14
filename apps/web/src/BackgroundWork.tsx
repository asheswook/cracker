import { memo, useId, useState } from 'react';
import { AnimatePresence, m } from 'motion/react';
import { ChevronDown, Repeat2 } from 'lucide-react';
import type { MessagePage } from './types';
import type { z } from 'zod';
import { useReducedMotion } from './useReducedMotion';
import './background-work.css';

type Background = NonNullable<z.infer<typeof MessagePage>['background']>;
const stateLabel = { queued: '대기 중', running: '진행 중', waiting: '응답 대기', paused: '일시 정지' } as const;
const spring = { type: 'spring', stiffness: 520, damping: 40, mass: 0.7 } as const;

export const BackgroundWork = memo(function BackgroundWork({ background, onOpenTasks }: {
  readonly background: Background | undefined;
  readonly onOpenTasks: () => void;
}) {
  const [open, setOpen] = useState(false);
  const reduced = useReducedMotion();
  const listId = useId();
  const items = background?.items ?? [];
  const running = items.filter(item => item.state === 'running').length;
  return (
    <AnimatePresence initial={false}>
      {items.length > 0 && (
        <m.div
          className="background-work"
          data-open={open || undefined}
          initial={reduced ? false : { opacity: 0, y: 6, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={reduced ? { opacity: 0 } : { opacity: 0, y: 6, scale: 0.96 }}
          transition={reduced ? { duration: 0 } : spring}
          layout={!reduced}
        >
          <button type="button" className="background-work-pill" aria-expanded={open} aria-controls={listId}
            onClick={() => setOpen(value => !value)}>
            <span className="background-work-glyph" data-active={running > 0 || undefined} aria-hidden="true"><Repeat2 size={12} /></span>
            <span>자동 작업 {items.length}개 {running > 0 ? '진행 중' : '대기 중'}</span>
            <ChevronDown size={12} aria-hidden="true" className="background-work-chevron" />
          </button>
          <AnimatePresence initial={false}>
            {open && (
              <m.div id={listId} className="background-work-list" role="list"
                initial={reduced ? false : { opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={reduced ? { opacity: 0 } : { opacity: 0, height: 0 }}
                transition={reduced ? { duration: 0 } : spring}
              >
                {items.map(item => (
                  <div key={item.task_id} role="listitem" className="background-work-item">
                    <span className="background-work-dot" data-state={item.state} aria-hidden="true" />
                    <span className="background-work-objective">{item.objective.split(/\r?\n/, 1)[0]}</span>
                    <span className="background-work-state">{stateLabel[item.state]}</span>
                  </div>
                ))}
                <button type="button" className="background-work-more" onClick={() => { setOpen(false); onOpenTasks(); }}>맡긴 일에서 보기</button>
              </m.div>
            )}
          </AnimatePresence>
        </m.div>
      )}
    </AnimatePresence>
  );
});
