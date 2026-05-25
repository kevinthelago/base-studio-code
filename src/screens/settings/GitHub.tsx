import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore, type GithubUser, type GithubRepo } from "../../store";

function ConnectCard() {
  const { setGithubToken, setGithubUser, setGithubRepos, setActiveRepo, setGithubConnected } = useAppStore();

  const [token, setToken] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleConnect() {
    const t = token.trim();
    if (!t) return;
    setLoading(true);
    setError(null);
    try {
      const user = await invoke<GithubUser>("github_request", { token: t, path: "user" });
      const repos = await invoke<GithubRepo[]>("github_request", {
        token: t,
        path: "user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member",
      });
      setGithubToken(t);
      setGithubUser(user);
      setGithubRepos(Array.isArray(repos) ? repos : []);
      if (Array.isArray(repos) && repos.length > 0) {
        setActiveRepo(repos[0].full_name);
      }
      setGithubConnected(true);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="card">
      <h3 style={{ margin: "0 0 10px", fontFamily: "var(--mono)", fontSize: 14 }}>Connect GitHub account</h3>
      <p style={{ margin: "0 0 16px", color: "var(--fg-muted)", fontSize: 12, lineHeight: 1.6 }}>
        Create a <b>Personal Access Token</b> at{" "}
        <span style={{ fontFamily: "var(--mono)", color: "var(--accent)", fontSize: 11 }}>
          github.com/settings/tokens
        </span>{" "}
        with <span className="tag" style={{ fontSize: 10 }}>repo</span>{" "}
        <span className="tag" style={{ fontSize: 10 }}>read:org</span>{" "}
        <span className="tag" style={{ fontSize: 10 }}>read:user</span> scopes, then paste it below.
      </p>

      <div style={{ display: "flex", gap: 8 }}>
        <input
          className="input"
          type="password"
          placeholder="ghp_••••••••••••••••••••••••••••••••••••"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleConnect()}
          style={{ flex: 1, height: 34, fontSize: 12 }}
          autoComplete="off"
        />
        <button
          className="btn primary"
          onClick={handleConnect}
          disabled={loading || !token.trim()}
          style={{ whiteSpace: "nowrap", height: 34 }}
        >
          {loading ? "Connecting…" : "Connect"}
        </button>
      </div>

      {error && (
        <div style={{
          marginTop: 10, padding: "8px 12px", borderRadius: 6,
          background: "var(--bg-elev)", border: "1px solid var(--danger)",
          color: "var(--danger)", fontFamily: "var(--mono)", fontSize: 11,
        }}>
          {error}
        </div>
      )}

      <div className="hint" style={{ marginTop: 8 }}>
        Token stored locally · never sent to any server other than api.github.com
      </div>
    </div>
  );
}

export function GitHubSettings() {
  const {
    githubConnected, githubUser, githubRepos, githubToken,
    disconnectGithub,
  } = useAppStore();

  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(githubRepos.map(r => r.full_name))
  );

  function toggleRepo(name: string) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  const filtered = githubRepos.filter(r =>
    r.full_name.toLowerCase().includes(filter.toLowerCase())
  );

  return (
    <div style={{ maxWidth: 760 }}>
      <h2 style={{ fontFamily: "var(--mono)", fontSize: 18, margin: "0 0 4px", fontWeight: 600 }}>GitHub</h2>
      <p style={{ color: "var(--fg-muted)", margin: "0 0 22px", fontSize: 12 }}>
        Connect your GitHub account to browse repos, branches, and pull requests.
      </p>

      {!githubConnected || !githubUser ? (
        <ConnectCard />
      ) : (
        <>
          {/* Auth card */}
          <div className="card" style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <div style={{
              width: 44, height: 44, borderRadius: "50%",
              background: "var(--bg-elev2)", border: "1px solid var(--border-soft)",
              display: "flex", alignItems: "center", justifyContent: "center",
              fontFamily: "var(--mono)", fontSize: 18, color: "var(--fg)",
              flexShrink: 0,
            }}>
              {(githubUser.name ?? githubUser.login).charAt(0).toUpperCase()}
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <b style={{ fontFamily: "var(--mono)", fontSize: 13 }}>
                  {githubUser.name ? `${githubUser.name} (${githubUser.login})` : githubUser.login}
                </b>
                <span className="tag green">● connected</span>
                <span className="tag">scopes: repo · read:org · read:user</span>
              </div>
              <div className="hint" style={{ marginTop: 3 }}>
                {githubRepos.length} {githubRepos.length === 1 ? "repo" : "repos"} accessible
                {githubToken && (
                  <> · token: <span style={{ fontFamily: "var(--mono)", letterSpacing: ".04em" }}>
                    {githubToken.slice(0, 7)}••••••••
                  </span></>
                )}
              </div>
            </div>
            <button className="btn danger" onClick={disconnectGithub}>Disconnect</button>
          </div>

          <div style={{ height: 18 }} />

          {/* Repos card */}
          <div className="card">
            <div style={{ display: "flex", alignItems: "baseline", marginBottom: 12, gap: 10 }}>
              <h3 style={{ margin: 0 }}>Repositories</h3>
              <span className="hint">
                {selected.size} of {githubRepos.length} selected — these show up in the GitHub tab.
              </span>
              <div style={{ flex: 1 }} />
              <input
                className="input"
                placeholder="filter…"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                style={{ width: 180 }}
              />
            </div>

            {githubRepos.length === 0 ? (
              <div style={{
                padding: "20px", textAlign: "center",
                fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-dim)",
                border: "1px solid var(--border-soft)", borderRadius: 6,
              }}>
                No repositories found.
              </div>
            ) : (
              <>
                <div style={{
                  display: "flex", flexDirection: "column", gap: 1,
                  borderRadius: 6, overflow: "hidden", border: "1px solid var(--border-soft)",
                }}>
                  {filtered.length === 0 ? (
                    <div style={{
                      padding: "14px", textAlign: "center",
                      fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-dim)",
                    }}>
                      No repos match "{filter}"
                    </div>
                  ) : (
                    filtered.map((r, i) => {
                      const on = selected.has(r.full_name);
                      const pushedAgo = (() => {
                        const diff = Date.now() - new Date(r.pushed_at).getTime();
                        const d = Math.floor(diff / 86_400_000);
                        return d === 0 ? "today" : d === 1 ? "yesterday" : `${d}d ago`;
                      })();
                      return (
                        <div key={r.full_name} style={{
                          display: "grid", gridTemplateColumns: "24px 1.4fr 1fr 1.6fr 90px",
                          alignItems: "center", gap: 12, padding: "11px 14px",
                          background: i % 2 ? "var(--bg-panel)" : "var(--bg-elev)",
                          fontSize: 11.5,
                        }}>
                          <div
                            onClick={() => toggleRepo(r.full_name)}
                            style={{
                              width: 16, height: 16, borderRadius: 4, cursor: "pointer",
                              background: on ? "var(--accent)" : "transparent",
                              border: "1px solid " + (on ? "var(--accent)" : "var(--border)"),
                              display: "flex", alignItems: "center", justifyContent: "center",
                              color: "#1a120a", fontSize: 11, fontWeight: 700, flexShrink: 0,
                            }}
                          >
                            {on ? "✓" : ""}
                          </div>
                          <div>
                            <div style={{ fontFamily: "var(--mono)" }}>{r.full_name}</div>
                            <div className="hint">{r.description ?? "No description"}</div>
                          </div>
                          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                            <span className="tag">{r.private ? "private" : "public"}</span>
                            <span style={{ fontFamily: "var(--mono)", color: "var(--fg-muted)", fontSize: 10.5 }}>
                              {r.default_branch}
                            </span>
                          </div>
                          <div style={{ fontFamily: "var(--mono)", color: "var(--fg-dim)", fontSize: 10.5 }}>
                            pushed {pushedAgo}
                            {r.language && (
                              <span style={{ marginLeft: 8 }} className="tag">{r.language.toLowerCase()}</span>
                            )}
                          </div>
                          <div style={{ textAlign: "right" }}>
                            <button className="btn ghost" style={{ height: 24, padding: "0 8px", fontSize: 10.5 }}>
                              configure
                            </button>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>

                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 14 }}>
                  <div className="hint">
                    Webhook deliveries land on <span className="kbd">/gh/webhook</span>.
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button className="btn ghost" style={{ fontSize: 10.5 }} onClick={() => setSelected(new Set())}>
                      deselect all
                    </button>
                    <button className="btn" style={{ fontSize: 10.5 }} onClick={() => setSelected(new Set(githubRepos.map(r => r.full_name)))}>
                      select all
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
