import { useAppStore } from "@/store";
import { clearGithubCache } from "@/shared/lib/github/github";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useGithubConnect } from "../lib/useGithubConnect";
import { StatusDot } from "@/shared/ui/StatusDot";
import { Chip } from "@/shared/ui/Chip";
import { Card } from "@/shared/ui/Card";

function ConnectFlowCard() {
  const {
    token, setToken,
    loading, error,
    clientId, device, deviceBusy,
    handleConnect, handleDeviceConnect, cancelDevice,
  } = useGithubConnect();

  return (
    <Card>
      <h3 style={{ margin: "0 0 10px", fontFamily: "var(--mono)", fontSize: 14 }}>Connect GitHub account</h3>

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
        with <Chip style={{ fontSize: 10 }}>repo</Chip>{" "}
        <Chip style={{ fontSize: 10 }}>read:org</Chip>{" "}
        <Chip style={{ fontSize: 10 }}>read:user</Chip>{" "}
        <Chip style={{ fontSize: 10 }}>project</Chip> scopes, then paste it below.
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
    </Card>
  );
}

export function ConnectGithubCard() {
  const {
    githubConnected, githubUser, githubRepos, githubToken,
    disconnectGithub,
  } = useAppStore();

  if (!githubConnected || !githubUser) {
    return <ConnectFlowCard />;
  }

  return (
    <Card style={{ display: "flex", alignItems: "center", gap: 16 }}>
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
          <Chip tone="success"><StatusDot style={{ marginRight: 4 }} />connected</Chip>
          <Chip>scopes: repo · read:org · read:user · project</Chip>
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
    </Card>
  );
}
