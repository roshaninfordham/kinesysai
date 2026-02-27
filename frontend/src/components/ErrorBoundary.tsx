/**
 * KINESYS — ErrorBoundary Component
 *
 * Wraps child components and catches rendering errors. On crash:
 *   - Shows a graceful "Recovering..." message
 *   - Auto-resets after 2 seconds
 *   - Logs the error for debugging
 *
 * Usage: <ErrorBoundary name="VoicePanel"><VoicePanel /></ErrorBoundary>
 */

import { Component, type ReactNode, type ErrorInfo } from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Props {
  children: ReactNode;
  name?: string;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

// ---------------------------------------------------------------------------
// Component (class-based — required for error boundaries)
// ---------------------------------------------------------------------------

export default class ErrorBoundary extends Component<Props, State> {
  private resetTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    const label = this.props.name || "Unknown";
    console.error(
      `[ErrorBoundary:${label}] Component crashed:`,
      error,
      info.componentStack,
    );

    // Auto-reset after 2 seconds
    this.resetTimer = setTimeout(() => {
      this.setState({ hasError: false, error: null });
    }, 2000);
  }

  componentWillUnmount(): void {
    if (this.resetTimer) {
      clearTimeout(this.resetTimer);
    }
  }

  render(): ReactNode {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div className="flex items-center justify-center rounded-lg border border-amber-500/20 bg-amber-500/5 p-4">
          <div className="text-center space-y-1.5">
            <div className="flex items-center justify-center gap-2">
              <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-amber-400 border-t-transparent" />
              <span className="text-xs font-medium text-amber-400">
                Recovering...
              </span>
            </div>
            {this.props.name && (
              <p className="text-[10px] font-mono text-white/20">
                {this.props.name}
              </p>
            )}
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
