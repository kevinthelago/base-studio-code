// The GitHub page-mode strip (Summary · Projects · Repositories) shared across the
// GitHub screen views (#1644 — extracted from GitHubSummary).

import { useAppStore } from "@/store";
import { Row } from "@/shared/ui/layout/Row";
import { Spacer } from "@/shared/ui/layout/Spacer";
import { Text } from "@/shared/ui/typography/Text";

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
            {on && <Text as="span" size={10} tone="dim">· {m.hint}</Text>}
          </Row>
        );
      })}
      <Spacer />
      <Row className="mono" gap={8} style={{ fontSize: 10, color: "var(--fg-dim)" }}>
        <Text as="span" tone="success">● connected</Text>
        {githubUser && <><Text>·</Text><Text>{githubUser.login}</Text></>}
      </Row>
    </Row>
  );
}
