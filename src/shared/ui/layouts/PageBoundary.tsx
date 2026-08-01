import { Component, type ErrorInfo, type ReactNode } from "react";
import { log } from "@/shared/lib/core/log";
import { Box } from "@/shared/ui/layout/Box";
import { Stack } from "@/shared/ui/layout/Stack";
import { Text } from "@/shared/ui/typography/Text";
import { Button } from "@/shared/ui/controls/Button";

interface Props {
  children: ReactNode;
  /** The active page id — shown in the fallback, and the reset key: navigating to another page clears a
   *  crash, so one bad render never strands the workspace behind a fallback. */
  page: string;
}

interface State {
  err: Error | null;
  /** The page the error belongs to, so a NEW page renders normally instead of inheriting the fallback. */
  crashedPage: string | null;
}

/**
 * A **page-scoped** error boundary (#4170) — the Page body's safety net, deliberately smaller in scope
 * than the app-wide `ErrorBoundary`.
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
export class PageBoundary extends Component<Props, State> {
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
          <Text weight={600}>This page didn’t load.</Text>
          <Text tone="dim" size={12}>
            {this.props.page} — {this.state.err.message || "render error"}
          </Text>
          <Text tone="dim" size={12}>
            The other pages still work: pick one from the tabs above, or press Ctrl+← / Ctrl+→.
          </Text>
          <Box>
            <Button onClick={this.retry}>Try again</Button>
          </Box>
        </Stack>
      </Box>
    );
  }
}
