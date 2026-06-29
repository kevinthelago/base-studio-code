// Language mix card — byte-count breakdown across the sampled repos (#1644).

import { useMemo } from "react";
import { ColorSwatch } from "@/shared/ui/controls/ColorSwatch";
import { langColor, SUMMARY_REPO_SAMPLE } from "../lib/githubSummary";

export function LanguageMix({ langTotals, repoCount, totalRepos, loading }: {
  langTotals: Record<string, number>;
  /** Sampled repos that contributed language data. */
  repoCount: number;
  /** Total connected repos (the sample is capped at SUMMARY_REPO_SAMPLE). */
  totalRepos: number;
  loading: boolean;
}) {
  const entries = useMemo(() => {
    const total = Object.values(langTotals).reduce((s, b) => s + b, 0);
    if (total === 0) return [];
    return Object.entries(langTotals)
      .map(([n, b]) => ({ n, pct: Math.round(b / total * 100), c: langColor(n) }))
      .sort((a, b) => b.pct - a.pct)
      .slice(0, 6);
  }, [langTotals]);

  // The summary only samples the most-recently-updated repos, so say so plainly:
  // "N of M repos" when capped, "N repos" otherwise. The tooltip spells out the cap.
  const sampled = Math.min(SUMMARY_REPO_SAMPLE, totalRepos);
  const capped = totalRepos > SUMMARY_REPO_SAMPLE;
  const repoLabel = capped
    ? `${repoCount} of ${sampled} sampled repos`
    : `${repoCount} repo${repoCount === 1 ? "" : "s"}`;
  const title = capped
    ? `Aggregated across the ${sampled} most-recently-updated of your ${totalRepos} repos${repoCount < sampled ? ` (${repoCount} had detected languages)` : ""}.`
    : undefined;

  return (
    <div className="card" style={{ padding: "14px 16px" }}>
      <div style={{ display: "flex", alignItems: "baseline", marginBottom: 10, gap: 10 }}>
        <h3 style={{ margin: 0 }}>Languages</h3>
        <span className="hint" title={title}>{loading ? "loading…" : entries.length > 0 ? `by byte count · ${repoLabel}` : "no data"}</span>
      </div>
      {entries.length === 0 && !loading && (
        <div className="mono" style={{ fontSize: 11, color: "var(--fg-dim)", padding: "4px 0" }}>No language data available.</div>
      )}
      {entries.length > 0 && (
        <>
          <div style={{ display: "flex", height: 10, borderRadius: 5, overflow: "hidden", background: "var(--bg-elev2)", marginBottom: 10 }}>
            {entries.map(l => (
              <div key={l.n} title={`${l.n} · ${l.pct}%`} style={{ width: `${l.pct}%`, background: l.c }} />
            ))}
          </div>
          <div className="mono" style={{ display: "flex", flexDirection: "column", gap: 5, fontSize: 10.5, color: "var(--fg-muted)" }}>
            {entries.map(l => (
              <div key={l.n} style={{ display: "grid", gridTemplateColumns: "12px 1fr 40px", gap: 8, alignItems: "center" }}>
                <ColorSwatch color={l.c} />
                <span style={{ color: "var(--fg)" }}>{l.n}</span>
                <span style={{ textAlign: "right", color: "var(--fg-dim)" }}>{l.pct}%</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
