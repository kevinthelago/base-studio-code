import { useAppStore } from "@/store";
import { clearGithubCache } from "@/shared/lib/github/github";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useGithubConnect } from "../lib/useGithubConnect";
import { StatusDot } from "@/shared/ui/feedback/StatusDot";
import { Chip } from "@/shared/ui/data/Chip";
import { Card } from "@/shared/ui/data/Card";
import { Row } from "@/shared/ui/layout/Row";
import { Button } from "@/shared/ui/controls/Button";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";

function ConnectFlowCard() {
  const {
    token, setToken,
    loading, error,
    clientId, device, deviceBusy,
    handleConnect, handleDeviceConnect, cancelDevice,
  } = useGithubConnect();

  return (
    <Card>
      <Text as="h3" mono size="lg" style={{ margin: "0 0 10px" }}>Connect GitHub account</Text>

      {clientId ? (
        device ? (
          <Box pad={16} bg="var(--bg-elev)" border="soft" radius={8} style={{
            marginBottom: 18,
          }}>
            <Text as="p" tone="muted" size="md" style={{ margin: "0 0 12px", lineHeight: 1.6 }}>
              In the browser tab that just opened, enter this code to authorize:
            </Text>
            <Box className="mono" pad={[10, 0]} style={{
              fontSize: 26, fontWeight: 700, letterSpacing: ".18em",
              textAlign: "center", color: "var(--accent)",
              userSelect: "all",
            }}>
              {device.user_code}
            </Box>
            <Row gap={10} style={{ marginTop: 12 }}>
              <Box as="span" className="hint" style={{ flex: 1 }}>
                Waiting for authorization at{" "}
                <Text as="span" mono tone="accent" size="sm">
                  {device.verification_uri.replace(/^https?:\/\//, "")}
                </Text>
                …
              </Box>
              <Button variant="ghost" style={{ height: 28, fontSize: 11 }} onClick={() => openUrl(device.verification_uri)}>
                reopen
              </Button>
              <Button variant="ghost" danger style={{ height: 28, fontSize: 11 }} onClick={cancelDevice}>
                cancel
              </Button>
            </Row>
          </Box>
        ) : (
          <Box style={{ marginBottom: 18 }}>
            <Text as="p" tone="muted" size="md" style={{ margin: "0 0 12px", lineHeight: 1.6 }}>
              Authorize base-studio-code on GitHub in your browser — no token to copy.
            </Text>
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
              <Box bg="var(--border-soft)" style={{ flex: 1, height: 1}} />
              or use a token
              <Box bg="var(--border-soft)" style={{ flex: 1, height: 1}} />
            </Row>
          </Box>
        )
      ) : null}

      <Text as="p" tone="muted" size="md" style={{ margin: "0 0 16px", lineHeight: 1.6 }}>
        Create a <b>Personal Access Token</b> at{" "}
        <Text as="span" mono tone="accent" size="sm">
          github.com/settings/tokens
        </Text>{" "}
        with <Chip style={{ fontSize: 10 }}>repo</Chip>{" "}
        <Chip style={{ fontSize: 10 }}>read:org</Chip>{" "}
        <Chip style={{ fontSize: 10 }}>read:user</Chip>{" "}
        <Chip style={{ fontSize: 10 }}>project</Chip> scopes, then paste it below.
      </Text>

      <Row gap={8} align="stretch">
        {/* eslint-disable-next-line no-restricted-syntax -- unlabelled inline input beside the Connect Button in a Row; a TextField .field wrapper would break the horizontal layout */}
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
        <Box className="mono" pad={[8, 12]} bg="var(--bg-elev)" radius={6} style={{
          marginTop: 10, border: "1px solid var(--danger)",
          color: "var(--danger)", fontSize: 11,
        }}>
          {error}
        </Box>
      )}

      <Box className="hint" style={{ marginTop: 8 }}>
        Token stored locally · never sent to any server other than github.com
      </Box>
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
      <Row className="mono" justify="center" style={{
        width: 44, height: 44, borderRadius: "50%",
        background: "var(--bg-elev2)", border: "1px solid var(--border-soft)",
        fontSize: 18, color: "var(--fg)",
        flexShrink: 0,
      }}>
        {(githubUser.name ?? githubUser.login).charAt(0).toUpperCase()}
      </Row>
      <Box style={{ flex: 1 }}>
        <Row gap={8} wrap>
          <b className="mono" style={{ fontSize: 13 }}>
            {githubUser.name ? `${githubUser.name} (${githubUser.login})` : githubUser.login}
          </b>
          <Chip tone="success"><StatusDot style={{ marginRight: 4 }} />connected</Chip>
          <Chip>scopes: repo · read:org · read:user · project</Chip>
        </Row>
        <Box className="hint" style={{ marginTop: 3 }}>
          {githubRepos.length} {githubRepos.length === 1 ? "repo" : "repos"} accessible
          {githubToken && (
            <> · token: <Box as="span" className="mono" style={{ letterSpacing: ".04em" }}>
              {githubToken.slice(0, 7)}••••••••
            </Box></>
          )}
        </Box>
      </Box>
      <Button danger onClick={() => { clearGithubCache().catch(() => {}); disconnectGithub(); }}>Disconnect</Button>
    </Card>
  );
}
