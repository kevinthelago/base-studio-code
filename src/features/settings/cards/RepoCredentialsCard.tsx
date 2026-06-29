import { useState } from "react";
import { useAppStore } from "@/store";
import { StatusDot } from "@/shared/ui/StatusDot";
import { Chip } from "@/shared/ui/Chip";
import { SettingsCardHead } from "../screens/SettingsControls";

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
    <div className="card">
      <SettingsCardHead title="Repo credentials" hint="scope a repo-specific token — that repo's sessions use it instead of your global PAT, so they can't reach other repos via the proxy." />

      <div style={{ display: "flex", gap: 8 }}>
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
        <button className="btn" disabled={!repo || !tok.trim()} onClick={assign} style={{ height: 34, whiteSpace: "nowrap" }}>assign</button>
      </div>
      <div className="hint" style={{ marginTop: 8 }}>
        Create a fine-grained token limited to one repository at{" "}
        <span style={{ fontFamily: "var(--mono)", color: "var(--accent)", fontSize: 11 }}>github.com/settings/tokens?type=beta</span>.
        Stored locally · never logged.
      </div>

      {scoped.length > 0 && (
        <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 1, borderRadius: 6, overflow: "hidden", border: "1px solid var(--border-soft)" }}>
          {scoped.map((r, i) => (
            <div key={r} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", background: i % 2 ? "var(--bg-panel)" : "var(--bg-elev)", fontSize: 11.5 }}>
              <span style={{ fontFamily: "var(--mono)", flex: 1 }}>{r}</span>
              <Chip tone="success" style={{ fontSize: 9.5 }}><StatusDot style={{ marginRight: 4 }} />scoped token</Chip>
              <button className="btn ghost danger" style={{ height: 24, fontSize: 10.5 }} onClick={() => setRepoGithubToken(r, null)}>remove</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
