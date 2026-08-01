import { Component, type ErrorInfo, type ReactNode } from "react";
import { log } from "@/shared/lib/core/log";
import { Box } from "@/shared/ui/layout/Box";
import { Stack } from "@/shared/ui/layout/Stack";
import { Text } from "@/shared/ui/typography/Text";
import { Button } from "@/shared/ui/controls/Button";

export interface PageBoundaryProps {
  children?: ReactNode;
  /** The active page id — shown in the fallback, and the reset key: navigating to another page clears a
   *  crash, so one bad render never strands the workspace behind a fallback. */
  page: string;
  /** The headline. Default: "This page didn't load." */
  title?: string;
  /** How to recover, in the HOST's own words (#4172). The app shell passes its navigation ("pick one from
   *  the tabs above, or press Ctrl+← / Ctrl+→"); a generated app names whatever its own affordance is.
   *  Defaulted neutrally rather than hard-coded, because a boundary that tells you to press keys the app
   *  does not have is worse than no hint at all. */
  hint?: string;
  /** The retry button's label. Default: "Try again". */
  retryLabel?: string;
}

interface State {
  err: Error | null;
  /** The page the error belongs to, so a NEW page renders normally instead of inheriting the fallback. */
  crashedPage: string | null;
}

/**
 * A **page-scoped** error boundary (#4170) — the Page body's safety net, deliberately smaller in scope
 * than the app-wide `ErrorBoundary`, and a registered kit primitive (#4172) so a DESIGNED page can carry
 * the same containment instead of it living only in this app's shell.
 *
 * It composes from a data spec: every prop is plain data and the retry is internal, because a spec tree
 * cannot carry a function. Wrap a page composition's body with it and a throwing child is contained to
 * that page rather than blanking whatever hosts it.
 *
 * `Screen` renders the PageTabs strip and the Page body as siblings with no boundary between them, so a
 * render error in any body used to unmount the whole Workspace — the tab strip with it — leaving no way
 * to navigate off the broken page. The bar is exactly what you need when a page fails to load, so the
 * boundary goes AROUND THE BODY ONLY: the strip keeps rendering, click and Ctrl+←/→ keep working, and the
 * failure is contained to the one page that caused it.
 *
 * It catches errors thrown during render/lifecycle of the page body. Errors in async callbacks do not
 * propagate here (they are handled at their call sites), but a state change they cause that then crashes
 * a render IS caught.
 */
export class PageBoundary extends Component<PageBoundaryProps, State> {
  state: State = { err: null, crashedPage: null };

  static getDerivedStateFromError(err: Error): Partial<State> {
    return { err };
  }

  componentDidCatch(err: Error, info: ErrorInfo) {
    // Same structured sink + `safety` scope as the app boundary, so a contained page crash is still
    // RECORDED rather than silently swallowed by the smaller blast radius.
    log.error(
      `PageBoundary [${this.props.page}] caught: ${err?.message ?? err}\n${info?.componentStack ?? ""}`,
      "safety",
    );
    this.setState({ crashedPage: this.props.page });
  }

  componentDidUpdate() {
    // Navigating to another page clears the error — the whole point of keeping the bar alive is that the
    // user can leave, and arriving somewhere else must not show the previous page's fallback.
    if (this.state.err && this.state.crashedPage !== null && this.state.crashedPage !== this.props.page) {
      this.setState({ err: null, crashedPage: null });
    }
  }

  retry = () => this.setState({ err: null, crashedPage: null });

  render() {
    if (!this.state.err) return this.props.children;
    return (
      <Box className="page-boundary" role="alert">
        <Stack gap={8}>
          <Text weight={600}>{this.props.title ?? "This page didn’t load."}</Text>
          <Text tone="dim" size={12}>
            {this.props.page} — {this.state.err.message || "render error"}
          </Text>
          <Text tone="dim" size={12}>
            {this.props.hint ?? "The other pages still work — open one of them to carry on."}
          </Text>
          <Box>
            <Button onClick={this.retry}>{this.props.retryLabel ?? "Try again"}</Button>
          </Box>
        </Stack>
      </Box>
    );
  }
}
