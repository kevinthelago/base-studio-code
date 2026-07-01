// Shared active-project GitHub wiring (#1754) — the board screens (Issues / Insights /
// ProjectBoard / Roadmap) all assembled the same `ActiveProjectInfo` from the store and the
// node-query screens all hand-rolled the identical Projects-v2 `useGithubQuery` over the active
// project's node id, plus the same error banner. Extracted here so the four screens share one
// source.
import type { CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store";
import { useGithubQuery, type GithubQuery } from "@/features/github/lib/useGithubQuery";
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
  const state = useGithubQuery<T>(
    (token) => invoke("github_graphql", { token, query, variables: { id: activeProjectId } }),
    [activeProjectId],
    !!activeProjectId,
  );
  return { project, ...state };
}

/** The shared danger banner the board screens render for a failed query. Renders nothing when there
 *  is no error. `style` lets a screen keep its existing margin. */
export function QueryBanner({ error, style }: { error: string | null; style?: CSSProperties }) {
  if (!error) return null;
  return (
    <div className="mono" style={{
      padding: "12px 16px", borderRadius: 6,
      background: "color-mix(in oklch, var(--danger), transparent 88%)",
      border: "1px solid color-mix(in oklch, var(--danger), transparent 70%)",
      fontSize: 11, color: "var(--danger)",
      ...style,
    }}>{error}</div>
  );
}
