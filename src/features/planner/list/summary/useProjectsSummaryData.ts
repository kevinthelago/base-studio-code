import { useState, useEffect } from "react";
import { useAppStore } from "@/store";
import { githubGraphql } from "@/shared/lib/github/github";
import { PROJECTS_SUMMARY_QUERY } from "@/features/planner/list/projectsSummaryQueries";
import type { GhProject } from "@/features/planner/list/projectsSummaryDerive";

// ── Data hook ─────────────────────────────────────────────────────────────────

/**
 * The Portfolio overview data — the GitHub Projects-v2 list via GraphQL, one round-trip.
 *
 * The per-repo issue/milestone fetches, the user-events feed, and the burndown iteration query were
 * dropped (#3675): they fed a project-detail flow that no longer exists, and cost 4+ slow REST
 * round-trips on every mount. The Portfolio now shows just the project data this one query provides.
 */
export function useProjectsSummaryData() {
  const { githubToken, githubUser } = useAppStore();
  const [loading, setLoading] = useState(false);
  const [projects, setProjects] = useState<GhProject[]>([]);

  useEffect(() => {
    if (!githubToken || !githubUser) return;
    setLoading(true);
    githubGraphql<{ viewer: { projectsV2: { nodes: GhProject[] } } }>(PROJECTS_SUMMARY_QUERY, null)
      .then(d => setProjects(d?.viewer?.projectsV2?.nodes ?? []))
      .catch(() => setProjects([]))
      .finally(() => setLoading(false));
  }, [githubToken, githubUser?.login]); // eslint-disable-line react-hooks/exhaustive-deps

  return { loading, projects };
}
