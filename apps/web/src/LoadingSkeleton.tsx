import './loading-skeleton.css';

type LoadingLayout = 'conversation' | 'persona' | 'model' | 'panel';
const rows = { conversation: 3, persona: 4, model: 3, panel: 3 } as const;

export function LoadingSkeleton({ layout = 'panel', label }: {
  readonly layout?: LoadingLayout;
  readonly label: string;
}) {
  return (
    <div className={`loading-skeleton loading-skeleton-${layout}`}>
      <p className="loading-skeleton-status" role="status">{label}</p>
      <div className="loading-skeleton-geometry" aria-hidden="true">
        {layout === 'model' && <div className="loading-skeleton-summary"><span /><span /></div>}
        {Array.from({ length: rows[layout] }, (_, index) => (
          <div className="loading-skeleton-row" key={index}>
            <span className="loading-skeleton-label" />
            <span className="loading-skeleton-value" />
            {layout === 'conversation' && <span className="loading-skeleton-tail" />}
            {layout === 'model' && index < 2 && <span className="loading-skeleton-help" />}
          </div>
        ))}
        {(layout === 'persona' || layout === 'model') && <span className="loading-skeleton-action" />}
      </div>
    </div>
  );
}
