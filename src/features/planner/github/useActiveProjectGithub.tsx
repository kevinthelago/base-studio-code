// Shared active-project GitHub wiring (#1754) — the board screens (Issues / Insights /
// ProjectBoard / Roadmap) all assembled the same `ActiveProjectInfo` from the store and the
// node-query screens all hand-rolled the identical Projects-v2 `useGithubQuery` over the active
// project's node id, plus the same error banner. Extracted here so the four screens share one
// source.
import type { CSSProperties } from "react";
import { useAppStore } from "@/store";
import { rateLimitNote } from "@/shared/lib/github/github";
import { fetchBoardWithProbe } from "@/shared/lib/github/githubProbe";
import { useGithubQuery, type GithubQuery } from "@/shared/lib/github/useGithubQuery";
import { InlineError } from "@/shared/ui/feedback/InlineError";
import { Text } from "@/shared/ui/typography/Text";
import type { ActiveProjectInfo } from "../list/ProjectsHeader";

/** The active project's identity, assembled from the store — the `project` prop every board
 *  screen passes to <ProjectsHeader>. */
export function useActiveProject(): ActiveProjectInfo {
  const id     = useAppStore((s) => s.activeProjectId);
  const name   = useAppStore((s) => s.activeProjectName);
  const repo   = useAppStore((s) => s.activeProjectRepo);
  const repos  = useAppStore((s) => s.activeProjectRepos);
  const number = useAppStore((s) => s.activeProjectNumber);
  return { id: id ?? "", number, name, repo, repos, description: "" };
}

/**
 * Run a Projects-v2 GraphQL `query` against the active project's node id — the identical fetch the
 * Issues / Insights / ProjectBoard screens hand-rolled — and return the active project alongside the
 * `{ data, loading, error }` state. Skips while there's no active project (the `!!activeProjectId`
 * gate). Roadmap fetches milestones by repo instead, so it uses `useActiveProject` directly.
 */
export function useActiveProjectGithub<T = { node: Record<string, unknown> }>(
  query: string,
): { project: ActiveProjectInfo } & GithubQuery<T> {
  const project = useActiveProject();
  const activeProjectId = useAppStore((s) => s.activeProjectId);
  // fetchBoardWithProbe keeps the board reads on the backend TTL cache (#2447 — switching between
  // Board / Issues / Insights within the window re-serves the cached result) and gates the heavy
  // `items(first:100)` re-POST past the window behind the board's light updatedAt probe (#2448):
  // an unchanged board keeps serving the cached copy, a moved one fetches fresh.
  const state = useGithubQuery<T>(
    () => fetchBoardWithProbe<T>(query, activeProjectId!),
    [activeProjectId],
    !!activeProjectId,
  );
  return { project, ...state };
}

/** The shared banner the board screens render for a failed query. Renders nothing when there is no
 *  error; a rate-limited query (#2448) renders as a quiet dim note (the screens keep showing their
 *  cached data) instead of the red danger callout. `style` lets a screen keep its existing margin. */
export function QueryBanner({ error, style }: { error: string | null; style?: CSSProperties }) {
  if (!error) return null;
  const note = rateLimitNote(error);
  if (note) {
    return (
      <Text as="div" mono size={11} tone="dim" style={{ padding: "12px 16px", ...style }}>
        {note}
      </Text>
    );
  }
  return (
    <InlineError pad={[12, 16]} radius={6} style={style}>{error}</InlineError>
  );
}
