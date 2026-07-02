import { Component, type ErrorInfo, type ReactNode } from "react";
import { error as logError } from "@tauri-apps/plugin-log";

interface Props {
  children: ReactNode;
  /** Optional label for the area this boundary wraps (shown in the fallback + logs). */
  label?: string;
  /** When any value here changes, the boundary clears its error — without remounting the
   *  children. Pass `[activeWorkspace]` so navigating away from a crashed view auto-recovers
   *  while persistent screens (Projects/Knowledge with live PTY sessions) keep their mount. */
  resetKeys?: unknown[];
}

interface State {
  err: Error | null;
}

/** Shallow element-wise inequality, treating different lengths as changed. */
function keysChanged(a: unknown[] = [], b: unknown[] = []): boolean {
  return a.length !== b.length || a.some((v, i) => !Object.is(v, b[i]));
}

/**
 * App-wide safety net. Without a boundary, a render error in any screen unmounts the
 * entire React tree — the window goes blank and looks like the whole app crashed (e.g.
 * deleting a project draft, #874). This catches the error, keeps the chrome alive, and
 * shows a recoverable fallback with a "try again" reset so the user never loses the app.
 *
 * It only catches errors thrown during render / lifecycle of its children. Errors in
 * async callbacks (event handlers, promises) don't propagate here — those are handled at
 * their call sites — but any state change they cause that then crashes a render IS caught.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { err: null };

  static getDerivedStateFromError(err: Error): State {
    return { err };
  }

  componentDidCatch(err: Error, info: ErrorInfo) {
    // Best-effort structured log to the Tauri sink; never let logging itself throw.
    void logError(
      `ErrorBoundary${this.props.label ? ` [${this.props.label}]` : ""} caught: ${err?.message ?? err}\n${info?.componentStack ?? ""}`,
    ).catch(() => {});
  }

  componentDidUpdate(prev: Props) {
    // Auto-recover when the reset keys change (e.g. the user navigated to another screen),
    // so a one-off crash doesn't strand the view behind the fallback forever.
    if (this.state.err && keysChanged(prev.resetKeys, this.props.resetKeys)) {
      this.setState({ err: null });
    }
  }

  reset = () => this.setState({ err: null });

  render() {
    if (!this.state.err) return this.props.children;
    return (
      // eslint-disable-next-line no-restricted-syntax -- crash boundary must render without depending on the UI kit
      <div
        role="alert"
        className="mono"
        style={{
          display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
          gap: 14, height: "100%", minHeight: 240, padding: 32, textAlign: "center",
          color: "var(--fg)",
        }}
      >
        {/* eslint-disable-next-line no-restricted-syntax -- crash boundary must render without depending on the UI kit */}
        <div style={{ fontSize: 14, fontWeight: 600 }}>Something went wrong{this.props.label ? ` in ${this.props.label}` : ""}.</div>
        {/* eslint-disable-next-line no-restricted-syntax -- crash boundary must render without depending on the UI kit */}
        <div style={{ fontSize: 11.5, color: "var(--fg-muted)", maxWidth: 520, lineHeight: 1.5 }}>
          The view hit an unexpected error and was stopped to keep the rest of the app running.
        </div>
        <pre
          style={{
            margin: 0, maxWidth: 520, maxHeight: 140, overflow: "auto", textAlign: "left",
            fontSize: 10.5, color: "var(--danger)", background: "color-mix(in oklch, var(--danger), transparent 92%)",
            border: "1px solid color-mix(in oklch, var(--danger), transparent 70%)", borderRadius: "var(--r-md)",
            padding: "8px 10px", whiteSpace: "pre-wrap", wordBreak: "break-word",
          }}
        >{this.state.err.message || String(this.state.err)}</pre>
        {/* eslint-disable-next-line no-restricted-syntax -- crash boundary must render without depending on the UI kit */}
        <button className="btn primary" onClick={this.reset} style={{ height: 28 }}>try again</button>
      </div>
    );
  }
}
