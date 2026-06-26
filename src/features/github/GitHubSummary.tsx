// The GitHub summary dashboard — the cross-repo analytics view (#1644).
//
// Presentation/composition only: the data + derivations live in `useGithubSummary`,
// the per-card UI in `summary/*`, and the React-free shaping in `lib/githubSummary.ts`.

import { useAppStore } from "@/store";
import { useGithubSummary } from "./useGithubSummary";
import { ActivityHeatmap } from "./summary/ActivityHeatmap";
import { LanguageMix } from "./summary/LanguageMix";
import { ContributorsCard } from "./summary/ContributorsCard";
import { CrossRepoActivity } from "./summary/CrossRepoActivity";
import { OpenPRsAllRepos } from "./summary/OpenPRsCard";
import { ReposGrid } from "./summary/ReposGrid";
import { CIHealthCard } from "./summary/CIHealthCard";

// Re-export the shared page-mode strip from its previous home so existing
// `@/features/github/GitHubSummary` importers keep working.
export { GitHubPageModeStrip } from "./summary/GitHubPageModeStrip";

export function GitHubSummary() {
  const setGithubPageMode = useAppStore(s => s.setGithubPageMode);
  const {
    loading, githubRepos,
    heatmap, totalMerged, crossRepoEvts, openPRs,
    langTotals, langRepoCount, contributors, ciMatrix, repoGridData,
    kpiOpenPRs, kpiContribs, kpiCIPassing,
  } = useGithubSummary();
  const { heatmapCells, rawCounts, rawDates, totalContribs } = heatmap;

  return (
    <section style={{ flex: 1, overflow: "auto", padding: "20px 24px", minWidth: 0, background: "var(--bg-canvas)" }}>
      <div style={{ maxWidth: 1280, margin: "0 auto" }}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 14, marginBottom: 14 }}>
          <div style={{ flex: 1 }}>
            <h2 style={{ margin: 0, fontFamily: "var(--mono)", fontSize: 20, fontWeight: 600 }}>Across all repositories</h2>
            <div style={{ color: "var(--fg-muted)", fontSize: 12, marginTop: 4 }}>
              {githubRepos.length} repo{githubRepos.length !== 1 ? "s" : ""} · 28-week view
            </div>
          </div>
          <button className="btn" onClick={() => setGithubPageMode("repos")}>browse repositories →</button>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 8, marginBottom: 14 }}>
          {([
            ["repositories", String(githubRepos.length),               "all connected",                 "fg"     ],
            ["open PRs",     loading ? "…" : String(kpiOpenPRs),       `${openPRs.filter(p => !p.draft).length} ready to review`, "accent"],
            ["contributions · 28w", loading ? "…" : String(totalContribs), "commits · PRs · issues",      "success"],
            ["CI passing",   loading ? "…" : kpiCIPassing != null ? `${kpiCIPassing}%` : "—", "latest run per repo", "info"],
            ["contributors", loading ? "…" : String(kpiContribs),      "all repos",                     "muted"  ],
            ["merged PRs",       loading ? "…" : String(totalMerged),   "last ~90 days via events",      "muted"  ],
          ] as const).map(([k, v, sub, tone]) => (
            <div key={k} className="card" style={{ padding: "10px 12px" }}>
              <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)", textTransform: "uppercase", letterSpacing: ".06em" }}>{k}</div>
              <div style={{
                fontFamily: "var(--mono)", fontSize: 18, fontWeight: 600, marginTop: 2,
                color: tone === "accent" ? "var(--accent)" : tone === "success" ? "var(--success)" : tone === "info" ? "var(--info)" : "var(--fg)",
              }}>{v}</div>
              <div style={{ fontSize: 10, color: "var(--fg-muted)", marginTop: 1 }}>{sub}</div>
            </div>
          ))}
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1.7fr 1fr", gap: 14 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 14, minWidth: 0 }}>
            <ReposGrid repos={repoGridData} loading={loading} />
            <CrossRepoActivity events={crossRepoEvts} loading={loading} />
            <OpenPRsAllRepos prs={openPRs} loading={loading} />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 14, minWidth: 0 }}>
            <ActivityHeatmap cells={heatmapCells} rawCounts={rawCounts} rawDates={rawDates} totalContribs={totalContribs} totalMerged={totalMerged} loading={loading} />
            <CIHealthCard matrix={ciMatrix} loading={loading} />
            <ContributorsCard contributors={contributors} loading={loading} />
            <LanguageMix langTotals={langTotals} repoCount={langRepoCount} totalRepos={githubRepos.length} loading={loading} />
          </div>
        </div>
      </div>
    </section>
  );
}
