import { useCallback, useEffect, useState } from "react";
import { usePoll } from "@/shared/hooks/usePoll";
import { Chip } from "@/shared/ui/data/Chip";
import { Button } from "@/shared/ui/controls/Button";
import { TextField } from "@/shared/ui/controls/Field";
import { Row } from "@/shared/ui/layout/Row";
import { Stack } from "@/shared/ui/layout/Stack";
import { Grid } from "@/shared/ui/layout/Grid";
import { Card } from "@/shared/ui/data/Card";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { QRCodeSVG } from "qrcode.react";
import { useAppStore } from "@/store";
import { pairingPayload, type TunnelStatus } from "./lib/tunnel";
import {
  tunnelStart,
  tunnelStop,
  tunnelStatus,
  tunnelSetInputGranted,
  tunnelUnpair,
} from "./lib/tunnelClient";
import {
  runRelayProbe,
  emptyLegs,
  freshRoomId,
  type ProbeLegs,
  type ProbeLeg,
  type MinimalSocket,
} from "./lib/relayProbe";

// `relayHealthUrl` now lives with the probe orchestration; re-exported here so existing
// importers (and tests) keep resolving it from this module.
export { relayHealthUrl } from "./lib/relayProbe";

// A "Deploy to Cloudflare" link prefilled with the relay workspace, so a user can
// stand up their own zero-knowledge relay in their own account (BYO).
const DEPLOY_URL =
  "https://deploy.workers.cloudflare.com/?url=https://github.com/kevinthelago/base-studio-code/tree/main/relay";

/**
 * Deep-link to the user's Cloudflare dashboard for their relay. Cloudflare resolves the `:account`
 * placeholder to whoever's logged in, so we never need their account id (which the app can't know).
 * When the relay is a `*.workers.dev` URL we extract the worker NAME (the first host label) and link
 * straight to that Worker; otherwise (custom domain, or no URL yet) we fall back to the Workers &
 * Pages list.
 */
export function cloudflareDashUrl(relayUrl: string): string {
  const base = "https://dash.cloudflare.com/?to=/:account";
  const trimmed = relayUrl.trim().replace(/^wss?:\/\//i, "https://");
  let host = "";
  try {
    host = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`).hostname;
  } catch { /* unparseable / empty → fall through to the generic Workers list */ }
  // `<worker>.<account-subdomain>.workers.dev` → the first label is the Worker's name.
  const m = host.match(/^([a-z0-9][a-z0-9-]*)\.[a-z0-9-]+\.workers\.dev$/i);
  return m ? `${base}/workers/services/view/${m[1]}/production` : `${base}/workers-and-pages`;
}

/** Per-leg deadline for the relay probe before that leg is called a failure. */
const TEST_TIMEOUT_MS = 6000;

type RelayTest =
  | { state: "idle" }
  | { state: "running"; legs: ProbeLegs; version?: string }
  | { state: "done"; legs: ProbeLegs; version?: string };

const LEG_LABELS: Array<{ key: keyof ProbeLegs; label: string }> = [
  { key: "reach", label: "Reachable" },
  { key: "join", label: "Room join" },
  { key: "relay", label: "Relay handshake" },
];

/** Glyph + color for a single probe leg's status. */
function legGlyph(status: ProbeLeg["status"]): { glyph: string; color: string } {
  switch (status) {
    case "ok": return { glyph: "✓", color: "var(--success, #2ea043)" };
    case "fail": return { glyph: "✗", color: "var(--danger)" };
    case "running": return { glyph: "◌", color: "var(--fg-muted)" };
    case "skip": return { glyph: "–", color: "var(--fg-muted)" };
    default: return { glyph: "·", color: "var(--fg-muted)" };
  }
}

export function TunnelSettings() {
  const tunnelRelayUrl = useAppStore((s) => s.tunnelRelayUrl);
  const setTunnelRelayUrl = useAppStore((s) => s.setTunnelRelayUrl);
  const setTunnelRunning = useAppStore((s) => s.setTunnelRunning);

  const [status, setStatus] = useState<TunnelStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Result of the "Test relay" probe (a /health round-trip), shown inline under the URL.
  const [test, setTest] = useState<RelayTest>({ state: "idle" });
  // Set when a view-only phone tries to send input, so the grant control is highlighted
  // until the desktop responds (#B-wan-viewonly). Cleared once input is granted/revoked.
  const [inputRequested, setInputRequested] = useState(false);

  // Mirror the Rust client's running state into the store so ConsoleWorkspace knows
  // whether to push live pane metadata.
  const sync = useCallback((s: TunnelStatus) => {
    setStatus(s);
    setTunnelRunning(s.running);
  }, [setTunnelRunning]);

  useEffect(() => {
    tunnelStatus().then(sync).catch((e) => setErr(String(e)));
  }, [sync]);

  // While connected, poll so the client count / pairing updates without interaction.
  // `sync` is stable (useCallback over the stable store setter), so this re-runs only
  // when the running state flips.
  const running = status?.running ?? false;
  usePoll(() => {
    if (!running) return;
    tunnelStatus().then(sync).catch(() => { /* transient; keep last */ });
  }, 2000, [running, sync], { immediate: false });

  // A view-only phone that tries to type fires this once; surface it so the desktop can
  // decide to grant input. The badge clears as soon as the desktop grants or revokes.
  useEffect(() => {
    if (!running) return;
    const unlisten = listen("tunnel://input-requested", () => setInputRequested(true));
    return () => { unlisten.then((off) => off()); };
  }, [running]);

  const onToggleInput = useCallback(async () => {
    const next = !(status?.inputGranted ?? false);
    setBusy(true);
    setErr(null);
    try {
      sync(await tunnelSetInputGranted(next));
      setInputRequested(false);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }, [status, sync]);

  const onUnpair = useCallback(async () => {
    setBusy(true);
    setErr(null);
    try {
      sync(await tunnelUnpair());
      setInputRequested(false);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }, [sync]);

  // Probe the relay across three distinct legs — reachability, room-join, and an
  // end-to-end relayed frame — so a failure points at WHICH layer is broken rather than a
  // single opaque pass/fail. Each leg updates inline as it resolves (via onLeg).
  const onTest = useCallback(async () => {
    const target = tunnelRelayUrl.trim();
    if (!target) return;
    setTest({ state: "running", legs: emptyLegs() });
    const result = await runRelayProbe(target, {
      fetchFn: fetch,
      // The browser WebSocket's strict DOM event types are wider than the minimal surface
      // the probe uses (onopen/onmessage/send/close); adapt it through the interface.
      makeSocket: (url) => new WebSocket(url) as unknown as MinimalSocket,
      timeoutMs: TEST_TIMEOUT_MS,
      genId: freshRoomId,
      onLeg: (legs) =>
        setTest((prev) => (prev.state === "running" ? { ...prev, legs } : prev)),
    });
    setTest({ state: "done", legs: result.legs, version: result.version });
  }, [tunnelRelayUrl]);

  const onConnect = useCallback(async () => {
    setBusy(true);
    setErr(null);
    try {
      sync(running ? await tunnelStop() : await tunnelStart(tunnelRelayUrl.trim()));
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }, [running, tunnelRelayUrl, sync]);

  const payload = status ? pairingPayload(status) : null;
  const qrValue = payload ? JSON.stringify(payload) : "";
  const clients = status?.clientCount ?? 0;
  const inputGranted = status?.inputGranted ?? false;
  const paired = clients > 0;
  const canConnect = tunnelRelayUrl.trim().length > 0;

  return (
    <Box style={{ maxWidth: 820 }}>
      <h2 className="mono" style={{ fontSize: 18, margin: "0 0 4px", fontWeight: 600 }}>Mobile tunnel</h2>
      <p style={{ color: "var(--fg-muted)", margin: "0 0 22px", fontSize: 12, lineHeight: 1.6 }}>
        Pair <code>mobile-studio-code</code> to mirror these consoles from your phone — from
        anywhere. Traffic flows through a <b>zero-knowledge relay</b> you deploy into your own
        Cloudflare account; it's end-to-end encrypted (Noise), so the relay never sees your
        terminal.
      </p>

      <Card>
        <Row gap={12} style={{ marginBottom: 14 }}>
          <h3 style={{ margin: 0 }}>Relay connection</h3>
          <Chip tone={running ? "success" : "neutral"}>
            {running ? (clients > 0 ? `● paired · ${clients} device${clients === 1 ? "" : "s"}` : "● waiting for a device") : "○ disconnected"}
          </Chip>
          <Box as="span" style={{ flex: 1 }} />
          <Button disabled={busy || (!running && !canConnect)} onClick={onConnect}>
            {running ? "disconnect" : busy ? "connecting…" : "connect"}
          </Button>
        </Row>

        {err && (
          <Box className="mono" style={{
            fontSize: 11, color: "var(--danger)",
            background: "var(--bg-elev)", border: "1px solid var(--border-soft)",
            borderRadius: 6, padding: "8px 10px", marginBottom: 14,
          }}>{err}</Box>
        )}

        <Box className="field" style={{ marginBottom: running && payload ? 18 : 0 }}>
          <label>Relay URL</label>
          <Row gap={8} align="stretch">
            {/* eslint-disable-next-line no-restricted-syntax -- input shares a Row with multiple action buttons; TextField's .field wrapper would break the inline layout */}
            <input
              className="input"
              placeholder="https://msc-tunnel-relay.<you>.workers.dev"
              value={tunnelRelayUrl}
              disabled={running}
              onChange={(e) => {
                setTunnelRelayUrl(e.target.value);
                setTest({ state: "idle" }); // a fresh URL invalidates the last probe
              }}
            />
            <Button
              disabled={busy || running || test.state === "running" || !canConnect}
              onClick={onTest}
            >
              {test.state === "running" ? "testing…" : "test"}
            </Button>
            <Button onClick={() => openUrl(DEPLOY_URL)}>
              deploy a relay →
            </Button>
            <Button
              title="Open this relay's Worker in your Cloudflare dashboard"
              onClick={() => openUrl(cloudflareDashUrl(tunnelRelayUrl))}
            >
              manage in Cloudflare ↗
            </Button>
          </Row>
          {test.state === "idle" ? (
            <Box className="hint">
              Your own Cloudflare Worker (free tier is enough). Deploy once, paste the URL it prints.
            </Box>
          ) : (
            <Stack
              className="hint"
              gap={3}
              style={{ marginTop: 8 }}
              role="status"
              aria-live="polite"
            >
              {LEG_LABELS.map(({ key, label }) => {
                const leg = test.legs[key];
                const { glyph, color } = legGlyph(leg.status);
                return (
                  <Row key={key} align="baseline" gap={8}>
                    <Box as="span" className="mono" style={{ color, width: 12, textAlign: "center" }}>{glyph}</Box>
                    <Box as="span" style={{ color: leg.status === "fail" ? "var(--danger)" : "var(--fg)", minWidth: 110 }}>{label}</Box>
                    {leg.detail && <Text as="span" tone="muted">{leg.detail}</Text>}
                  </Row>
                );
              })}
            </Stack>
          )}
        </Box>

        {running && payload ? (
          <Grid cols="auto 1fr" gap={20} align="start">
            {/* QR — rendered on white for reliable scanning regardless of theme. */}
            <Stack align="center" gap={8} style={{ background: "#ffffff", padding: 12, borderRadius: 10 }}>
              <QRCodeSVG value={qrValue} size={184} bgColor="#ffffff" fgColor="#000000" level="M" />
              <Text as="div" mono size={9.5} style={{ color: "#666", letterSpacing: ".04em" }}>
                SCAN IN MOBILE-STUDIO-CODE
              </Text>
            </Stack>

            <Stack gap={14} style={{ minWidth: 0 }}>
              <TextField
                label="Room"
                readOnly
                value={status?.room ?? ""}
                onChange={() => {}}
                style={{ fontSize: 11 }}
                hint="A fresh, high-entropy room is allocated each time you connect."
              />
              <TextField
                label="Host key (Noise)"
                readOnly
                value={status?.hostPubKey ?? ""}
                onChange={() => {}}
                style={{ fontSize: 10.5 }}
                hint={<>
                  The phone pins this from the QR — it's how it knows it's talking to <i>your</i>
                  desktop, not the relay.
                </>}
              />
              <Box className="field">
                <label>Input control</label>
                <Row gap={10}>
                  <Chip tone={inputGranted ? "success" : "neutral"}>
                    {inputGranted ? "● input granted" : "○ view-only"}
                  </Chip>
                  <Box as="span" style={{ flex: 1 }} />
                  <Button
                    disabled={busy || !paired}
                    onClick={onToggleInput}
                    style={inputRequested && !inputGranted
                      ? { borderColor: "var(--accent)", color: "var(--accent)" }
                      : undefined}
                  >
                    {inputGranted ? "revoke input" : "grant input"}
                  </Button>
                </Row>
                <Box className="hint">
                  {!paired
                    ? "A paired phone starts view-only — it mirrors these panes but cannot type."
                    : inputRequested && !inputGranted
                      ? "The paired phone is asking to send input. Grant it to let the phone drive a pane."
                      : inputGranted
                        ? "The paired phone can drive panes. Revoke to return it to view-only."
                        : "The phone is view-only — keystrokes are dropped until you grant input."}
                </Box>
              </Box>
              {paired && (
                <Box className="field">
                  <label>Paired device</label>
                  <Row gap={10}>
                    <Box as="span" style={{ flex: 1 }} />
                    <Button disabled={busy} onClick={onUnpair}>
                      unpair device
                    </Button>
                  </Row>
                  <Box className="hint">
                    Drops the connected phone, rotates the room + pairing secret (the old QR
                    stops working), and shows a fresh QR to pair again.
                  </Box>
                </Box>
              )}
              <Text as="div" className="hint mono" size={10.5}>
                The pairing secret is carried inside the QR only — never shown or logged.
              </Text>
            </Stack>
          </Grid>
        ) : (
          <Box className="hint" style={{ padding: "8px 0 0" }}>
            {running
              ? "Connecting to the relay…"
              : "Connect to allocate a room and generate a pairing QR."}
          </Box>
        )}
      </Card>
    </Box>
  );
}
