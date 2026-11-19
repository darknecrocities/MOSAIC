import { Component, type ErrorInfo, type ReactNode } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('MOSAIC UI error boundary caught error:', error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <main className="mosaic-content">
          <section className="mosaic-panel mosaic-stack-sm" role="alert">
            <h2>Something went wrong in this view</h2>
            <p className="mosaic-callout mosaic-callout-error">{this.state.error.message}</p>
            <div>
              <button
                type="button"
                className="mosaic-button-secondary"
                onClick={() => this.setState({ error: null })}
              >
                Try Again
              </button>
            </div>
          </section>
        </main>
      );
    }
    return this.props.children;
  }
}
