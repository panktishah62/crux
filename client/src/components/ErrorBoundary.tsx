import { Component, type ReactNode } from 'react';

export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error('[ui] render crash', error);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="crash">
        <h3>Something went wrong in the editor</h3>
        <pre>{this.state.error.message}</pre>
        <button className="btn primary" onClick={() => location.reload()}>
          Reload (your design is saved)
        </button>
      </div>
    );
  }
}
