import { useState, useEffect } from "react";
import { useAppStore } from "@/store";
import { githubRequest, githubGraphql } from "@/shared/lib/github/github";
import { parseProjectIteration, type BurndownResult, type ProjectIterationNode } from "@/features/planner/github/burndown";
import type { GHEvent, GhMilestone, GhIssueItem as GhIssue } from "@/shared/lib/github/types";
import { PROJECTS_SUMMARY_QUERY, PROJECT_ITERATION_QUERY } from "@/features/planner/list/projectsSummaryQueries";
import type { GhProject } from "@/features/planner/list/projectsSummaryDerive";

// ── Data hook ─────────────────────────────────────────────────────────────────

export function useProjectsSummaryData() {
  const { githubToken, githubUser } = useAppStore();
  const [loading, setLoading] = useState(false);
  const [projects, setProjects] = useState<GhProject[]>([]);
  const [events, setEvents] = useState<GHEvent[]>([]);
  const [repoMilestones, setRepoMilestones] = useState<Record<string, GhMilestone[]>>({});
  const [repoIssues, setRepoIssues] = useState<Record<string, GhIssue[]>>({});
  const [burndown, setBurndown] = useState<BurndownResult | null>(null);

  useEffect(() => {
    if (!githubToken || !githubUser) return;
    const login = githubUser.login;
    setLoading(true);

    const projectsP = githubGraphql<{ viewer: { projectsV2: { nodes: GhProject[] } } }>(PROJECTS_SUMMARY_QUERY, null)
      .then(d => d?.viewer?.projectsV2?.nodes ?? []).catch((): GhProject[] => []);

    const eventsP = githubRequest<GHEvent[]>(`users/${login}/events?per_page=100`).catch((): GHEvent[] => []);

    Promise.all([projectsP, eventsP]).then(([projs, evts]) => {
      const projArr = Array.isArray(projs) ? projs : [];
      const evtArr = Array.isArray(evts) ? evts : [];
      setProjects(projArr);
      setEvents(evtArr);

      // Iteration burn-down for the lead project (first active with items): pull
      // its Iteration/Status fields + items and resolve the current iteration.
      const lead = projArr.find(p => !p.closed && p.items.totalCount > 0);
      if (lead) {
        githubGraphql<{ node: ProjectIterationNode | null }>(PROJECT_ITERATION_QUERY, { projectId: lead.id })
          .then(d => setBurndown(parseProjectIteration(d?.node ?? null, Date.now())))
          .catch(() => setBurndown({ status: "no-field" }));
      } else {
        setBurndown({ status: "no-field" });
      }

      // Collect unique repos from all projects
      const slugSet = new Set<string>();
      projArr.forEach(p => p.repositories.nodes.forEach(r => slugSet.add(r.nameWithOwner)));
      const slugs = Array.from(slugSet).slice(0, 6);

      if (slugs.length === 0) { setLoading(false); return; }

      const eightWeeksAgo = new Date(Date.now() - 56 * 86400000).toISOString();

      Promise.all(slugs.map(slug => Promise.all([
        githubRequest<GhMilestone[]>(
          `repos/${slug}/milestones?state=open&sort=due_on&direction=asc&per_page=10`,
        ).catch((): GhMilestone[] => []),
        githubRequest<GhIssue[]>(
          `repos/${slug}/issues?state=all&per_page=100&sort=created&direction=desc&since=${eightWeeksAgo}`,
        ).catch((): GhIssue[] => []),
      ]))).then(results => {
        const ms: Record<string, GhMilestone[]> = {};
        const is: Record<string, GhIssue[]> = {};
        slugs.forEach((slug, i) => {
          const [milestones, issues] = results[i] as [GhMilestone[], GhIssue[]];
          ms[slug] = Array.isArray(milestones) ? milestones : [];
          is[slug] = Array.isArray(issues) ? issues : [];
        });
        setRepoMilestones(ms);
        setRepoIssues(is);
        setLoading(false);
      }).catch(() => setLoading(false));
    }).catch(() => setLoading(false));
  }, [githubToken, githubUser?.login]); // eslint-disable-line react-hooks/exhaustive-deps

  return { loading, projects, events, repoMilestones, repoIssues, burndown };
}
