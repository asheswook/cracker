import { Component } from 'react';
import type { ReactNode } from 'react';
import { X } from 'lucide-react';
import { Button, ErrorNotice, IconButton } from './primitives';

export class PanelErrorBoundary extends Component<{
  children: ReactNode;
  onClose: () => void;
}, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.error('panel failed', error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error));
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div data-panel-recovery>
        <header className="inspector-header">
          <span>패널을 열 수 없어요</span>
          <IconButton label="패널 닫기" data-close onClick={this.props.onClose}>
            <X size={18} />
          </IconButton>
        </header>
        <div className="inspector-body">
          <ErrorNotice>앱이 업데이트됐거나 일시적인 오류가 발생했어요.</ErrorNotice>
          <p>패널을 닫고 대화를 계속하거나, 새로고침해서 다시 열어 주세요.</p>
          <Button data-reload onClick={() => window.location.reload()}>새로고침</Button>
        </div>
      </div>
    );
  }
}
