// useGlanceProjects (#…) — the REAL project set for the Glance network: the user's PUBLISHED GitHub
// projects (projectsV2, the same query the Planner list runs) MERGED with local DRAFTS. Everything is
// keyed by the PLAN key (the draft/stable/alias key — NOT the GitHub node id) so each project appears
// once and drilling into it resolves its fleet from `planFleet` (which is plan-key-keyed). Published
// projects win on a key collision (they carry the real open/shipped status). Falls back to just drafts
// when there's no token / before the fetch lands, so the page is never blocked on the network.
import { useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store";
import { useGithubQuery } from "@/features/github/lib/useGithubQuery";
import { PROJECTS_QUERY, projStatus, type GhProject } from "@/features/planner/list/published/publishedModel";
import { sanitizeProjectKey } from "@/shared/lib/core/projectPaths";
import type { GStatus } from "./glanceGraph";
import type { ProjectLite } from "./glanceData";

/** A published project's status → a Glance node status: shipped ⇒ done, open ⇒ planning. */
const ghStatus = (p: GhProject): GStatus => (projStatus(p) === "shipped" ? "done" : "planning");

export function useGlanceProjects(enabled = true): ProjectLite[] {
  const drafts = useAppStore((s) => s.localDraftProjects);
  const planFleet = useAppStore((s) => s.planFleet);
  const projectKeyAlias = useAppStore((s) => s.projectKeyAlias);

  const published = useGithubQuery<GhProject[]>(
    (token) => invoke<{ viewer?: { projectsV2?: { nodes: GhProject[] } } }>("github_graphql", { token, query: PROJECTS_QUERY, variables: null })
      .then((d) => d.viewer?.projectsV2?.nodes ?? []),
    [], enabled,
  );

  return useMemo(() => {
    const byKey = new Map<string, ProjectLite>();
    // Drafts first; a published project on the same plan key overrides it below.
    for (const [id, d] of Object.entries(drafts)) {
      byKey.set(id, { id, name: d.title, status: (planFleet[id]?.streams.length ?? 0) > 0 ? "planning" : "idle" });
    }
    for (const p of published.data ?? []) {
      // The plan key: the publish alias if set, else the title-derived key — the key `planFleet` + the
      // drill resolve against (NOT the GitHub node id).
      const key = projectKeyAlias[p.id] ?? sanitizeProjectKey(p.title);
      byKey.set(key, { id: key, name: p.title, status: ghStatus(p) });
    }
    return [...byKey.values()];
  }, [drafts, planFleet, projectKeyAlias, published.data]);
}
