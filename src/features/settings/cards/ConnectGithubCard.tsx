import { useAppStore } from "@/store";
import { clearGithubCache } from "@/shared/lib/github/github";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useGithubConnect } from "../lib/useGithubConnect";
import { StatusDot } from "@/shared/ui/feedback/StatusDot";
import { Chip } from "@/shared/ui/data/Chip";
import { Card } from "@/shared/ui/data/Card";
import { Row } from "@/shared/ui/layout/Row";
import { Button } from "@/shared/ui/controls/Button";

function ConnectFlowCard() {
  const {
    token, setToken,
    loading, error,
    clientId, device, deviceBusy,
    handleConnect, handleDeviceConnect, cancelDevice,
  } = useGithubConnect();

  return (
    <Card>
      <h3 className="mono" style={{ margin: "0 0 10px", fontSize: 14 }}>Connect GitHub account</h3>

      {clientId ? (
        device ? (
          <div style={{
            marginBottom: 18, padding: "16px", borderRadius: 8,
            background: "var(--bg-elev)", border: "1px solid var(--border-soft)",
          }}>
            <p style={{ margin: "0 0 12px", fontSize: 12, color: "var(--fg-muted)", lineHeight: 1.6 }}>
              In the browser tab that just opened, enter this code to authorize:
            </p>
            <div className="mono" style={{
              fontSize: 26, fontWeight: 700, letterSpacing: ".18em",
              textAlign: "center", color: "var(--accent)", padding: "10px 0",
              userSelect: "all",
            }}>
              {device.user_code}
            </div>
            <Row gap={10} style={{ marginTop: 12 }}>
              <span className="hint" style={{ flex: 1 }}>
                Waiting for authorization at{" "}
                <span className="mono" style={{ color: "var(--accent)", fontSize: 11 }}>
                  {device.verification_uri.replace(/^https?:\/\//, "")}
                </span>
                …
              </span>
              <Button variant="ghost" style={{ height: 28, fontSize: 11 }} onClick={() => openUrl(device.verification_uri)}>
                reopen
              </Button>
              <Button variant="ghost" danger style={{ height: 28, fontSize: 11 }} onClick={cancelDevice}>
                cancel
              </Button>
            </Row>
          </div>
        ) : (
          <div style={{ marginBottom: 18 }}>
            <p style={{ margin: "0 0 12px", color: "var(--fg-muted)", fontSize: 12, lineHeight: 1.6 }}>
              Authorize base-studio-code on GitHub in your browser — no token to copy.
            </p>
            <Button
              variant="primary"
              onClick={handleDeviceConnect}
              disabled={deviceBusy || loading}
              style={{ height: 36, width: "100%" }}
            >
              {deviceBusy ? "Starting…" : "Connect with GitHub"}
            </Button>
            <Row className="mono" gap={10} style={{
              margin: "16px 0 4px",
              color: "var(--fg-dim)", fontSize: 10.5,
            }}>
              <div style={{ flex: 1, height: 1, background: "var(--border-soft)" }} />
              or use a token
              <div style={{ flex: 1, height: 1, background: "var(--border-soft)" }} />
            </Row>
          </div>
        )
      ) : null}

      <p style={{ margin: "0 0 16px", color: "var(--fg-muted)", fontSize: 12, lineHeight: 1.6 }}>
        Create a <b>Personal Access Token</b> at{" "}
        <span className="mono" style={{ color: "var(--accent)", fontSize: 11 }}>
          github.com/settings/tokens
        </span>{" "}
        with <Chip style={{ fontSize: 10 }}>repo</Chip>{" "}
        <Chip style={{ fontSize: 10 }}>read:org</Chip>{" "}
        <Chip style={{ fontSize: 10 }}>read:user</Chip>{" "}
        <Chip style={{ fontSize: 10 }}>project</Chip> scopes, then paste it below.
      </p>

      <Row gap={8} align="stretch">
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
        <Button
          variant="primary"
          onClick={handleConnect}
          disabled={loading || !token.trim()}
          style={{ whiteSpace: "nowrap", height: 34 }}
        >
          {loading ? "Connecting…" : "Connect"}
        </Button>
      </Row>

      {error && (
        <div className="mono" style={{
          marginTop: 10, padding: "8px 12px", borderRadius: 6,
          background: "var(--bg-elev)", border: "1px solid var(--danger)",
          color: "var(--danger)", fontSize: 11,
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
      <div className="mono" style={{
        width: 44, height: 44, borderRadius: "50%",
        background: "var(--bg-elev2)", border: "1px solid var(--border-soft)",
        display: "flex", alignItems: "center", justifyContent: "center",
        fontSize: 18, color: "var(--fg)",
        flexShrink: 0,
      }}>
        {(githubUser.name ?? githubUser.login).charAt(0).toUpperCase()}
      </div>
      <div style={{ flex: 1 }}>
        <Row gap={8} wrap>
          <b className="mono" style={{ fontSize: 13 }}>
            {githubUser.name ? `${githubUser.name} (${githubUser.login})` : githubUser.login}
          </b>
          <Chip tone="success"><StatusDot style={{ marginRight: 4 }} />connected</Chip>
          <Chip>scopes: repo · read:org · read:user · project</Chip>
        </Row>
        <div className="hint" style={{ marginTop: 3 }}>
          {githubRepos.length} {githubRepos.length === 1 ? "repo" : "repos"} accessible
          {githubToken && (
            <> · token: <span className="mono" style={{ letterSpacing: ".04em" }}>
              {githubToken.slice(0, 7)}••••••••
            </span></>
          )}
        </div>
      </div>
      <Button danger onClick={() => { clearGithubCache().catch(() => {}); disconnectGithub(); }}>Disconnect</Button>
    </Card>
  );
}
