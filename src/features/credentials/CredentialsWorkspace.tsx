// The Credentials workspace — the window onto the credential store (`bsc secret`).
//
// It answers one question the app previously could not answer at all: WHICH services are we paired
// with, and are any of those pairings broken? The OS keychain has no listing, so before this store
// existed a credential that had quietly expired was indistinguishable from one that worked, right up
// until an agent's call failed in the middle of a task.
//
// What it deliberately does NOT do: show, reveal, copy or edit a secret value. There is no verb on
// `bsc secret` that returns one, so there is nothing here to render even by accident — the page reads
// metadata and a derived status, and that is the whole of what it can reach.
//
// The status is NOT computed here. `crates/bsc-secret` derives it, because only the backend can see
// the keychain — which is what decides `missing`. Re-deriving it in the frontend would be a second
// implementation of the same rule, free to drift from the first.
import { useCallback, useEffect, useMemo, useState } from "react";
import { KeyRound, RefreshCw } from "lucide-react";
import { Box } from "@/shared/ui/layout/Box";
import { Row } from "@/shared/ui/layout/Row";
import { Stack } from "@/shared/ui/layout/Stack";
import { Text } from "@/shared/ui/typography/Text";
import { Button } from "@/shared/ui/controls/Button";
import { EmptyState } from "@/shared/ui/feedback/EmptyState";
import { bsc } from "@/shared/lib/core/bsc";
import { ServiceGlyph } from "@/features/credentials/serviceGlyphs";
import {
  parseCredentials, sortCredentials, summarize, displayName,
  relativeAge, expiryLabel, STATUS_META, type Credential, type CredentialStatus,
} from "@/features/credentials/lib/credentials";

/** The command that registers a credential — shown in the empty state and the footer, because a
 *  screen that reports an empty store without saying how to fill it is a dead end. */
const REGISTER_CMD = `echo '{"id":"github-acme","service":"github","label":"GitHub"}' | bsc secret set`;

function StatusPill({ status }: { status: CredentialStatus }) {
  const meta = STATUS_META[status];
  // The tone rides a data attribute rather than the class name, so the CSS has one rule per tone
  // instead of one per status. More importantly the status is rendered as TEXT: colour alone would
  // make the entire content of this screen invisible to anyone who cannot tell the tones apart.
  return (
    <Text as="span" className="cred-pill" data-tone={meta.tone} title={meta.hint}>
      {meta.label}
    </Text>
  );
}

function CredentialRow({ credential, now }: { credential: Credential; now: number }) {
  const meta = STATUS_META[credential.status];
  const expiry = expiryLabel(credential.expiresAt, now);
  // Assembled from whatever the record actually has — every field but the id is optional, so a
  // sparse record renders a short line rather than a line full of "unknown".
  const details = [
    credential.service,
    credential.kind,
    credential.account,
    expiry,
    `checked ${relativeAge(credential.lastVerifiedAt, now)}`,
  ].filter((d): d is string => !!d && d.trim().length > 0);

  return (
    <li className="cred-row" data-tone={meta.tone}>
      <Text as="span" className="cred-glyph" aria-hidden="true">
        <ServiceGlyph service={credential.service} />
      </Text>
      <Stack gap={2} className="cred-body">
        <Text as="span" className="cred-name">{displayName(credential)}</Text>
        <Text as="span" mono className="cred-details">{details.join(" · ")}</Text>
        {/* The reason, when there is one. A red pill with no explanation makes the user go and
            reproduce the failure themselves to find out what it was. */}
        {credential.status === "failing" && credential.lastError && (
          <Text as="span" mono className="cred-reason">{credential.lastError}</Text>
        )}
        {credential.status === "missing" && (
          <Text as="span" mono className="cred-reason">{meta.hint}</Text>
        )}
      </Stack>
      <StatusPill status={credential.status} />
    </li>
  );
}

/** The Credentials rail Workspace. */
export function CredentialsWorkspace() {
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [error, setError] = useState<string | null>(null);
  // `loaded` rather than `loading`: the empty state and the still-fetching state look identical
  // otherwise, and flashing "no credentials" before the first response lands reads as data loss.
  const [loaded, setLoaded] = useState(false);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  const load = useCallback(async () => {
    try {
      // The credential store is GLOBAL, not per-project — a GitHub token is not owned by whichever
      // project happens to be open — so the bridge's project key is null, as it is for `bsc skill`.
      const raw = await bsc(null, ["secret", "list"]);
      // Every setState below happens AFTER the await. A synchronous one would run during the
      // effect's own pass, which is what `react-hooks/set-state-in-effect` exists to prevent.
      setCredentials(parseCredentials(raw));
      setNow(Math.floor(Date.now() / 1000));
      setError(null);
    } catch (e) {
      // Surfaced, never swallowed into an empty list: "the store could not be read" and "the store
      // is empty" are opposite facts, and this screen exists to say truthfully which one holds.
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const rows = useMemo(() => sortCredentials(credentials), [credentials]);
  const summary = useMemo(() => summarize(credentials), [credentials]);

  return (
    <Stack gap="md" className="cred-screen">
      <Row align="start" justify="between" gap="md" wrap className="cred-head">
        <Stack gap={0}>
          <h2 className="cred-title">Credentials</h2>
          <p className="cred-sub">
            The services this app is paired with. Values live in the OS keychain and are never shown
            here, or to an agent session.
          </p>
        </Stack>
        <Row align="center" gap="sm" className="cred-head-right">
          {loaded && !error && (
            <Text as="span" mono className="cred-count" data-attention={summary.attention > 0}>
              {summary.attention > 0
                ? `${summary.attention} of ${summary.total} need attention`
                : `${summary.total} credential${summary.total === 1 ? "" : "s"}`}
            </Text>
          )}
          <Button size="sm" className="cred-refresh" onClick={() => void load()} title="Re-read the credential store">
            <RefreshCw size={14} />
            Refresh
          </Button>
        </Row>
      </Row>

      {error && (
        <Stack gap="xs" className="cred-error" role="alert">
          <strong>The credential store could not be read.</strong>
          <Text as="span" mono>{error}</Text>
        </Stack>
      )}

      {!error && loaded && rows.length === 0 && (
        <EmptyState
          icon={<KeyRound size={20} />}
          title="No credentials registered"
          description="Register one to pair this app with a service. The value goes into the OS keychain separately, so it never enters the store — or an agent's context."
          extra={<code className="mono cred-cmd">{REGISTER_CMD}</code>}
        />
      )}

      {!error && rows.length > 0 && (
        <Box as="ul" className="cred-list">
          {rows.map((c) => (
            <CredentialRow key={c.id} credential={c} now={now} />
          ))}
        </Box>
      )}

      {!error && rows.length > 0 && (
        <p className="cred-foot hint">
          Add one with <code className="mono">bsc secret set</code>, store its value with{" "}
          <code className="mono">bsc secret put &lt;id&gt;</code>.
        </p>
      )}
    </Stack>
  );
}
