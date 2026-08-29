// The Credentials feature's pure domain — no React, no Tauri, so every rule below is unit-testable
// without a store, a keychain or a render.
//
// The app pairs agent sessions with external services, and the credentials authorizing those
// pairings used to be invisible: the keychain has no listing, so nothing could answer "which
// credentials do we hold, and are any of them broken?". `bsc secret list` answers it now, and this
// module is the shape of that answer plus the three presentation decisions that go with it —
// which icon a service gets, how a status reads, and what order the rows come in.
//
// THE STATUS ITSELF IS NOT COMPUTED HERE. It is derived in `crates/bsc-secret` (`status()`), because
// the keychain — which decides `missing` — is only reachable from the backend. Re-deriving it in the
// frontend would be a second implementation of the same rule, free to disagree with the first.

/** The status vocabulary, mirroring `bsc_secret::Status`. */
export const CREDENTIAL_STATUSES = ["ok", "unverified", "expiring", "expired", "failing", "missing"] as const;

export type CredentialStatus = (typeof CREDENTIAL_STATUSES)[number];

/** One row as `bsc secret list` emits it. Every field but `id` and `status` may be absent — this is a
 *  verbatim-JSON store with no schema migration, so an older record is a valid record. */
export interface Credential {
  id: string;
  status: CredentialStatus;
  hasSecret: boolean;
  needsAttention: boolean;
  service?: string;
  label?: string;
  kind?: string;
  account?: string;
  expiresAt?: number;
  lastVerifiedAt?: number;
  lastResult?: string;
  lastError?: string;
  note?: string;
}

/** How a status reads to a person: its label, the one-line reason, and the tone token its pill uses. */
export interface StatusMeta {
  label: string;
  /** Why the credential is in this state — shown under the row, so it is a sentence, not a word. */
  hint: string;
  /** Maps to a `--status-*` custom property in credentials.css. */
  tone: "good" | "warn" | "bad" | "muted";
}

/**
 * Status → how it presents.
 *
 * The tone split is the judgement worth stating: `expiring` is `warn` rather than `bad` because the
 * credential still works, and `unverified` is `muted` rather than `warn` because having no evidence
 * is not the same as having bad news. Colouring "we have not tried it yet" as a problem would make
 * every freshly-added credential look broken.
 */
export const STATUS_META: Record<CredentialStatus, StatusMeta> = {
  ok: { label: "OK", hint: "Last use succeeded.", tone: "good" },
  unverified: {
    label: "Unverified",
    hint: "Stored, but nothing has used it yet — no evidence either way.",
    tone: "muted",
  },
  expiring: { label: "Expiring", hint: "Still works, but expires within a week.", tone: "warn" },
  expired: { label: "Expired", hint: "Past its expiry date. Rotate it and store the new value.", tone: "bad" },
  failing: { label: "Failing", hint: "The last use was rejected by the service.", tone: "bad" },
  missing: {
    label: "No secret",
    hint: "This credential is registered but the keychain holds no value for it.",
    tone: "bad",
  },
};

/** The status of a row whose `status` the backend did not send (or sent as something we do not know).
 *  Unknown is closer to "no evidence" than to "fine", so it reads as unverified rather than ok. */
export const UNKNOWN_STATUS: CredentialStatus = "unverified";

/** Narrow an arbitrary string to a known status, falling back rather than rendering an unstyled row. */
export function asStatus(raw: unknown): CredentialStatus {
  return CREDENTIAL_STATUSES.includes(raw as CredentialStatus) ? (raw as CredentialStatus) : UNKNOWN_STATUS;
}

/**
 * Service slug → the icon key its row shows.
 *
 * Matched on a NORMALIZED slug (lowercased, non-alphanumerics stripped) so `Salesforce`,
 * `salesforce` and `sales-force` all land on the same glyph — a service name is typed by a human
 * into `bsc secret set`, and requiring an exact slug would mean a typo silently costs the row its
 * icon.
 *
 * Aliases are listed next to their canonical name rather than resolved elsewhere, so adding a
 * service is one entry in one place.
 */
export const SERVICE_ICONS: Record<string, string> = {
  github: "github",
  git: "github",
  gitlab: "github",
  salesforce: "cloud",
  sfdc: "cloud",
  aws: "server",
  gcp: "server",
  azure: "server",
  resend: "mail",
  sendgrid: "mail",
  mailgun: "mail",
  smtp: "mail",
  email: "mail",
  slack: "chat",
  discord: "chat",
  bluesky: "social",
  mastodon: "social",
  x: "social",
  twitter: "social",
  stripe: "payments",
  anthropic: "model",
  openai: "model",
  gemini: "model",
  google: "model",
  ollama: "model",
  postgres: "database",
  postgresql: "database",
  mysql: "database",
  duckdb: "database",
  snowflake: "database",
};

/** The glyph a service with no entry in {@link SERVICE_ICONS} gets — a key, which is what every one
 *  of these is. Never a blank cell: an unmapped service must still render a row. */
export const FALLBACK_ICON = "key";

/** Normalize a service name for icon lookup: lowercase, alphanumerics only. */
export function normalizeService(service: string | undefined): string {
  return (service ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** The icon key for a credential's service. */
export function serviceIcon(service: string | undefined): string {
  return SERVICE_ICONS[normalizeService(service)] ?? FALLBACK_ICON;
}

/** The row's display name — the label, else the id. Never blank: a row with no name is a row the
 *  user cannot act on. */
export function displayName(c: Credential): string {
  return c.label?.trim() || c.id;
}

/** Sort weight per status — lower sorts first. The list leads with what is broken, because the
 *  screen's whole job is to surface that; `ok` and `unverified` are the tail nobody needs to read. */
const STATUS_ORDER: Record<CredentialStatus, number> = {
  missing: 0,
  expired: 1,
  failing: 2,
  expiring: 3,
  unverified: 4,
  ok: 5,
};

/**
 * Order the list: worst status first, then by display name.
 *
 * Sorts a COPY — the caller's array is state, and an in-place sort of a React state array mutates
 * the object identity comparison depends on.
 */
export function sortCredentials(list: Credential[]): Credential[] {
  return [...list].sort((a, b) => {
    const byStatus = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
    if (byStatus !== 0) return byStatus;
    return displayName(a).localeCompare(displayName(b));
  });
}

/** The header's one-line count: how many rows, and how many of them want attention. */
export interface CredentialSummary {
  total: number;
  attention: number;
  byStatus: Record<CredentialStatus, number>;
}

/** Summarize a list for the header. `attention` is the backend's own `needsAttention`, not a second
 *  opinion computed here — the two must never be able to disagree about what is wrong. */
export function summarize(list: Credential[]): CredentialSummary {
  const byStatus = Object.fromEntries(CREDENTIAL_STATUSES.map((s) => [s, 0])) as Record<CredentialStatus, number>;
  for (const c of list) byStatus[c.status] = (byStatus[c.status] ?? 0) + 1;
  return { total: list.length, attention: list.filter((c) => c.needsAttention).length, byStatus };
}

/**
 * Parse `bsc secret list` output into rows.
 *
 * Tolerant on purpose: a non-array body, or a row that is not an object, yields an empty list rather
 * than throwing. This is a screen whose entire job is to report state, and a screen that white-screens
 * because the store returned something unexpected reports nothing at all.
 */
export function parseCredentials(raw: string): Credential[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((r): r is Record<string, unknown> => !!r && typeof r === "object" && !Array.isArray(r))
    .filter((r) => typeof r.id === "string" && r.id.length > 0)
    .map((r) => ({
      ...(r as object),
      id: r.id as string,
      status: asStatus(r.status),
      hasSecret: r.hasSecret === true,
      needsAttention: r.needsAttention === true,
    })) as Credential[];
}

/** A compact relative age for a unix-seconds instant (`3d ago`), or `never` when absent.
 *  Its own implementation rather than `timeAgo` from shared/lib, which takes an ISO string —
 *  `bsc secret` speaks unix seconds, and converting at the boundary just to convert back is a
 *  round trip that can only lose precision. */
export function relativeAge(at: number | undefined, now: number): string {
  if (at === undefined || !Number.isFinite(at)) return "never";
  const secs = Math.max(0, now - at);
  if (secs < 60) return "just now";
  const units: [number, string][] = [
    [60, "m"],
    [3600, "h"],
    [86400, "d"],
  ];
  if (secs < 3600) return `${Math.floor(secs / units[0][0])}${units[0][1]} ago`;
  if (secs < 86400) return `${Math.floor(secs / units[1][0])}${units[1][1]} ago`;
  return `${Math.floor(secs / units[2][0])}${units[2][1]} ago`;
}

/** How long until an expiry, for the row's detail line. Past expiries read as `expired`, not as a
 *  negative number. */
export function expiryLabel(expiresAt: number | undefined, now: number): string | null {
  if (expiresAt === undefined || !Number.isFinite(expiresAt)) return null;
  const secs = expiresAt - now;
  if (secs <= 0) return "expired";
  const days = Math.floor(secs / 86400);
  if (days >= 1) return `expires in ${days}d`;
  const hours = Math.floor(secs / 3600);
  if (hours >= 1) return `expires in ${hours}h`;
  return "expires within the hour";
}
