import './loading-skeleton.css';

type LoadingLayout = 'conversation' | 'persona' | 'model' | 'panel' | 'cards' | 'list';

const cardLines = [[34, 88, 62], [30, 92, 48], [36, 80, 70]] as const;

function Cards() {
  return <div className="resource-list loading-skeleton-cards">
    {cardLines.map((widths, index) => <div className="resource-item" key={index}>
      <span className="loading-skeleton-line loading-skeleton-meta" style={{ width: `${widths[0]}%` }} />
      <span className="loading-skeleton-line" style={{ width: `${widths[1]}%` }} />
      <span className="loading-skeleton-line" style={{ width: `${widths[2]}%` }} />
      <span className="loading-skeleton-line loading-skeleton-actions" />
    </div>)}
  </div>;
}

function List() {
  return <div className="loading-skeleton-list">
    {[72, 58, 80, 46, 64].map((width, index) => <div className="loading-skeleton-list-row" key={index}>
      <span className="loading-skeleton-line" style={{ width: `${width}%` }} />
      <span className="loading-skeleton-line loading-skeleton-meta" style={{ width: `${width - 22}%` }} />
    </div>)}
  </div>;
}

function Conversation() {
  return <div className="loading-skeleton-conversation-feed">
    <span className="loading-skeleton-bubble" data-side="user" style={{ width: '46%' }} />
    <span className="loading-skeleton-bubble" style={{ width: '72%', height: 64 }} />
    <span className="loading-skeleton-bubble" data-side="user" style={{ width: '38%' }} />
    <span className="loading-skeleton-bubble" style={{ width: '64%', height: 88 }} />
  </div>;
}

const rows = { persona: 4, model: 3, panel: 3 } as const;

function Fields({ layout }: { readonly layout: 'persona' | 'model' | 'panel' }) {
  return <>
    {layout === 'model' && <div className="loading-skeleton-summary"><span /><span /></div>}
    {Array.from({ length: rows[layout] }, (_, index) => (
      <div className="loading-skeleton-row" key={index}>
        <span className="loading-skeleton-label" />
        <span className="loading-skeleton-value" />
        {layout === 'model' && index < 2 && <span className="loading-skeleton-help" />}
      </div>
    ))}
    {(layout === 'persona' || layout === 'model') && <span className="loading-skeleton-action" />}
  </>;
}

export function LoadingSkeleton({ layout = 'panel', label }: {
  readonly layout?: LoadingLayout;
  readonly label: string;
}) {
  return (
    <div className={`loading-skeleton loading-skeleton-${layout}`} aria-busy="true">
      <p className="visually-hidden" role="status">{label}</p>
      <div className="loading-skeleton-geometry" aria-hidden="true">
        {layout === 'cards' ? <Cards /> : layout === 'list' ? <List /> : layout === 'conversation' ? <Conversation /> : <Fields layout={layout} />}
      </div>
    </div>
  );
}
