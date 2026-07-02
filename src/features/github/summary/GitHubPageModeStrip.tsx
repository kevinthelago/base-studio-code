// The GitHub page-mode strip (Summary · Projects · Repositories) shared across the
// GitHub screen views (#1644 — extracted from GitHubSummary).

import { useAppStore } from "@/store";
import { Row } from "@/shared/ui/layout/Row";
import { Spacer } from "@/shared/ui/layout/Spacer";

export function GitHubPageModeStrip() {
  const { githubPageMode, setGithubPageMode, githubUser } = useAppStore();
  const modes = [
    { k: "summary",  label: "Summary",      hint: "all repos · analytics" },
    { k: "projects", label: "Projects",     hint: "portfolio · analytics" },
    { k: "repos",    label: "Repositories", hint: "progress · changes · CI" },
  ] as const;
  return (
    <Row className="mono" gap={6} style={{
      padding: "0 24px",
      borderBottom: "1px solid var(--border-soft)",
      background: "var(--bg-panel)",
      fontSize: 11.5,
      height: 34, flex: "0 0 34px",
    }}>
      {modes.map(m => {
        const on = m.k === githubPageMode;
        return (
          <Row key={m.k} onClick={() => setGithubPageMode(m.k)} gap={8} style={{
            padding: "0 12px", height: 34,
            borderBottom: "2px solid " + (on ? "var(--accent)" : "transparent"),
            color: on ? "var(--accent)" : "var(--fg-muted)",
            cursor: "pointer",
          }}>
            {m.label}
            {on && <span style={{ color: "var(--fg-dim)", fontSize: 10 }}>· {m.hint}</span>}
          </Row>
        );
      })}
      <Spacer />
      <Row className="mono" gap={8} style={{ fontSize: 10, color: "var(--fg-dim)" }}>
        <span style={{ color: "var(--success)" }}>● connected</span>
        {githubUser && <><span>·</span><span>{githubUser.login}</span></>}
      </Row>
    </Row>
  );
}
