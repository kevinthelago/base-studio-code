import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useAppStore, type GithubUser, type GithubRepo } from "../../store";
import { clearGithubCache } from "../../lib/github";
import { runDeviceFlow, type DeviceStartInfo, type DevicePollResult } from "../../lib/githubDeviceFlow";

/** Mirror of the backend `DeviceStart` struct (`github_device_start`). */
type DeviceStart = DeviceStartInfo;

// `project` is required to read AND create GitHub Projects v2 (the Projects page
// + planning publish); without it the API returns "token lacks read:project".
const DEVICE_SCOPE = "repo read:org read:user project";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function ConnectCard() {
  const { setGithubToken, setGithubUser, setGithubRepos, setActiveRepo, setGithubConnected } = useAppStore();

  const [token, setToken] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Device flow: clientId === null until probed; "" means this build has no OAuth
  // app configured, so we offer the PAT path only.
  const [clientId, setClientId] = useState<string | null>(null);
  const [device, setDevice] = useState<DeviceStart | null>(null);
  const [deviceBusy, setDeviceBusy] = useState(false);
  // Generation token: bumped each time a flow starts, so starting over cancels the
  // previous loop — WITHOUT tying cancellation to unmount. Navigating away no longer
  // aborts an in-flight authorization (#594); the flow runs to completion and the
  // store write in finishConnect lands regardless of which screen is shown.
  const runIdRef = useRef(0);
  // Guards component-state setters so they no-op after unmount (the store write does not).
  const mountedRef = useRef(true);

  useEffect(() => {
    invoke<string>("github_client_id").then(setClientId).catch(() => setClientId(""));
    return () => { mountedRef.current = false; };
  }, []);

  // Exchange a validated token for the user + repo list and flip to connected.
  async function finishConnect(t: string) {
    // New token (possibly a different account) — drop any cached bodies first.
    await clearGithubCache().catch(() => {});
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
  }

  async function handleConnect() {
    const t = token.trim();
    if (!t) return;
    setLoading(true);
    setError(null);
    try {
      await finishConnect(t);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  async function handleDeviceConnect() {
    const myRun = ++runIdRef.current;
    // Update component state only if still mounted AND this is the current run.
    const ui = (fn: () => void) => { if (mountedRef.current && runIdRef.current === myRun) fn(); };
    ui(() => { setError(null); setDeviceBusy(true); });
    try {
      await runDeviceFlow({
        start: () => invoke<DeviceStart>("github_device_start", { scope: DEVICE_SCOPE }),
        poll: (deviceCode) => invoke<DevicePollResult>("github_device_poll", { deviceCode }),
        sleep,
        // Cancelled only when the user starts a new flow — never on unmount (#594).
        isCancelled: () => runIdRef.current !== myRun,
        onDevice: (start) => {
          ui(() => setDevice(start));
          openUrl(start.verification_uri).catch(() => { /* user can use the shown URL/code manually */ });
        },
        // The store write must complete even if the user navigated away — no ui() guard.
        onSuccess: (token) => finishConnect(token),
        onError: (message) => ui(() => { setError(message); setDevice(null); }),
      });
    } catch (e) {
      ui(() => { setError(String(e)); setDevice(null); });
    } finally {
      ui(() => setDeviceBusy(false));
    }
  }

  function cancelDevice() {
    // Bump the generation token so the in-flight flow's isCancelled() trips.
    runIdRef.current++;
    setDevice(null);
    setDeviceBusy(false);
  }

  return (
    <div className="card">
      <h3 style={{ margin: "0 0 10px", fontFamily: "var(--mono)", fontSize: 14 }}>Connect GitHub account</h3>

      {/* Device flow (when this build has an OAuth Client ID) */}
      {clientId ? (
        device ? (
          <div style={{
            marginBottom: 18, padding: "16px", borderRadius: 8,
            background: "var(--bg-elev)", border: "1px solid var(--border-soft)",
          }}>
            <p style={{ margin: "0 0 12px", fontSize: 12, color: "var(--fg-muted)", lineHeight: 1.6 }}>
              In the browser tab that just opened, enter this code to authorize:
            </p>
            <div style={{
              fontFamily: "var(--mono)", fontSize: 26, fontWeight: 700, letterSpacing: ".18em",
              textAlign: "center", color: "var(--accent)", padding: "10px 0",
              userSelect: "all",
            }}>
              {device.user_code}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 12 }}>
              <span className="hint" style={{ flex: 1 }}>
                Waiting for authorization at{" "}
                <span style={{ fontFamily: "var(--mono)", color: "var(--accent)", fontSize: 11 }}>
                  {device.verification_uri.replace(/^https?:\/\//, "")}
                </span>
                …
              </span>
              <button className="btn ghost" style={{ height: 28, fontSize: 11 }} onClick={() => openUrl(device.verification_uri)}>
                reopen
              </button>
              <button className="btn ghost danger" style={{ height: 28, fontSize: 11 }} onClick={cancelDevice}>
                cancel
              </button>
            </div>
          </div>
        ) : (
          <div style={{ marginBottom: 18 }}>
            <p style={{ margin: "0 0 12px", color: "var(--fg-muted)", fontSize: 12, lineHeight: 1.6 }}>
              Authorize base-studio-code on GitHub in your browser — no token to copy.
            </p>
            <button
              className="btn primary"
              onClick={handleDeviceConnect}
              disabled={deviceBusy || loading}
              style={{ height: 36, width: "100%" }}
            >
              {deviceBusy ? "Starting…" : "Connect with GitHub"}
            </button>
            <div style={{
              display: "flex", alignItems: "center", gap: 10, margin: "16px 0 4px",
              color: "var(--fg-dim)", fontSize: 10.5, fontFamily: "var(--mono)",
            }}>
              <div style={{ flex: 1, height: 1, background: "var(--border-soft)" }} />
              or use a token
              <div style={{ flex: 1, height: 1, background: "var(--border-soft)" }} />
            </div>
          </div>
        )
      ) : null}

      <p style={{ margin: "0 0 16px", color: "var(--fg-muted)", fontSize: 12, lineHeight: 1.6 }}>
        Create a <b>Personal Access Token</b> at{" "}
        <span style={{ fontFamily: "var(--mono)", color: "var(--accent)", fontSize: 11 }}>
          github.com/settings/tokens
        </span>{" "}
        with <span className="tag" style={{ fontSize: 10 }}>repo</span>{" "}
        <span className="tag" style={{ fontSize: 10 }}>read:org</span>{" "}
        <span className="tag" style={{ fontSize: 10 }}>read:user</span>{" "}
        <span className="tag" style={{ fontSize: 10 }}>project</span> scopes, then paste it below.
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
        Token stored locally · never sent to any server other than github.com
      </div>
    </div>
  );
}

// Repo-scoped credentials (#158): assign a fine-grained, repo-scoped token to a repo
// so that repo's sessions make GitHub calls with it instead of the global PAT.
function RepoCredentialsCard() {
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
      <div style={{ display: "flex", alignItems: "baseline", marginBottom: 12, gap: 10 }}>
        <h3 style={{ margin: 0 }}>Repo credentials</h3>
        <span className="hint">scope a repo-specific token — that repo's sessions use it instead of your global PAT, so they can't reach other repos via the proxy.</span>
      </div>

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
              <span className="tag green" style={{ fontSize: 9.5 }}>● scoped token</span>
              <button className="btn ghost danger" style={{ height: 24, fontSize: 10.5 }} onClick={() => setRepoGithubToken(r, null)}>remove</button>
            </div>
          ))}
        </div>
      )}
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
                <span className="tag">scopes: repo · read:org · read:user · project</span>
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
            <button className="btn danger" onClick={() => { clearGithubCache().catch(() => {}); disconnectGithub(); }}>Disconnect</button>
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
                          display: "grid", gridTemplateColumns: "24px 1.4fr 1fr 1.6fr",
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

          <div style={{ height: 18 }} />
          <RepoCredentialsCard />
        </>
      )}
    </div>
  );
}
