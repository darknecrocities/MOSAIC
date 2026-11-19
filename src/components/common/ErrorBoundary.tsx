import { Component, type ErrorInfo, type ReactNode } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: unknown;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false, error: null };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error('MOSAIC UI error boundary caught error:', error, info);
  }

  render() {
    if (this.state.hasError) {
      const message =
        this.state.error instanceof Error
          ? this.state.error.message
          : String(this.state.error || 'Unexpected error');
      return (
        <main className="mosaic-content">
          <section className="mosaic-panel mosaic-stack-sm" role="alert">
            <h2>Something went wrong in this view</h2>
            <p className="mosaic-callout mosaic-callout-error">{message}</p>
            <div>
              <button
                type="button"
                className="mosaic-button-secondary"
                onClick={() => this.setState({ hasError: false, error: null })}
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
