import { useState } from "react";
import { useAppStore } from "@/store";
import { StatusDot } from "@/shared/ui/feedback/StatusDot";
import { Chip } from "@/shared/ui/data/Chip";
import { Card } from "@/shared/ui/data/Card";
import { Row } from "@/shared/ui/layout/Row";
import { Stack } from "@/shared/ui/layout/Stack";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import { Button } from "@/shared/ui/controls/Button";

export function RepoCredentialsCard() {
  const repoGithubTokens = useAppStore((s) => s.repoGithubTokens);
  const setRepoGithubToken = useAppStore((s) => s.setRepoGithubToken);
  const githubRepos = useAppStore((s) => s.githubRepos);
  const [repo, setRepo] = useState("");
  const [tok, setTok] = useState("");
  const scoped = Object.keys(repoGithubTokens).sort();

  function assign() {
    if (!repo || !tok.trim()) return;
    setRepoGithubToken(repo, tok);
    setRepo(""); setTok("");
  }

  return (
    <Card title="Repo credentials" hint="scope a repo-specific token — that repo's sessions use it instead of your global PAT, so they can't reach other repos via the proxy.">

      <Row gap={8} align="stretch">
        <select className="input" value={repo} onChange={(e) => setRepo(e.target.value)} style={{ width: 240, height: 34 }}>
          <option value="">choose a repo…</option>
          {githubRepos.map((r) => <option key={r.full_name} value={r.full_name}>{r.full_name}</option>)}
        </select>
        <input
          className="input" type="password" autoComplete="off"
          placeholder="github_pat_•••• (repo-scoped)"
          value={tok} onChange={(e) => setTok(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && assign()}
          style={{ flex: 1, height: 34, fontSize: 12 }}
        />
        <Button disabled={!repo || !tok.trim()} onClick={assign} style={{ height: 34, whiteSpace: "nowrap" }}>assign</Button>
      </Row>
      <Box className="hint" style={{ marginTop: 8 }}>
        Create a fine-grained token limited to one repository at{" "}
        <Text as="span" mono size="sm" tone="accent">github.com/settings/tokens?type=beta</Text>.
        Stored locally · never logged.
      </Box>

      {scoped.length > 0 && (
        <Stack gap={1} style={{ marginTop: 14, borderRadius: 6, overflow: "hidden", border: "1px solid var(--border-soft)" }}>
          {scoped.map((r, i) => (
            <Row key={r} gap={10} style={{ padding: "10px 12px", background: i % 2 ? "var(--bg-panel)" : "var(--bg-elev)", fontSize: 11.5 }}>
              <Text as="span" mono style={{ flex: 1 }}>{r}</Text>
              <Chip tone="success" style={{ fontSize: 9.5 }}><StatusDot style={{ marginRight: 4 }} />scoped token</Chip>
              <Button variant="ghost" danger style={{ height: 24, fontSize: 10.5 }} onClick={() => setRepoGithubToken(r, null)}>remove</Button>
            </Row>
          ))}
        </Stack>
      )}
    </Card>
  );
}
