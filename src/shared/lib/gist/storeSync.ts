// Gist store sync — the pure decision core (epic #4202, slice 1).
//
// Gives the two graph stores GitHub's native version control: one gist per store (`algorithms.json`,
// `components.json`), one revision per curation, with real diffs and restore. What the in-app `history`
// cannot do on its own — an entry is `{at, by, changed:[…], rev}`, which records THAT a field changed and
// never what it held — so you cannot diff a curation or restore one.
//
// THE PRINCIPLE THIS MUST NOT BREAK (#2444): local stays authoritative; the gist is a synced remote. If
// the gist were THE store, a user with no GitHub connection would have no algorithms library and no
// component library, and both the Design Studio and the librarian would stop working. So every write
// lands locally first and syncs when connected, and disconnected behaviour is byte-identical to today.
// Nothing here fetches, writes, or requires a token: it is given three hashes and returns a verdict.
//
// WHY THREE HASHES AND NOT TWO. Comparing local to remote alone can tell you they DIFFER but never which
// side moved — and "differs" is not an action. The last-synced hash is the common ancestor that makes the
// difference readable: it is the content both sides agreed on, so whichever side no longer matches it is
// the side that changed. Two-way comparison would have to guess, and the safe guess (never overwrite)
// degenerates into "always diverged" the moment anything is edited anywhere.
//
// The verdict names mirror `bsc-cli-util::vendored::SyncVerdict` (#4192) deliberately: that is the
// vocabulary the emitters already speak, and `Diverged` means the same thing in both — STOP, report, and
// never clobber. Reusing the words keeps one mental model for "the store and its copy disagree".

/** The content fingerprint of one store document. SHA-256 hex, matching the `sha256_hex` in
 *  `bsc-cli-util::vendored` — the epic requires ONE content comparison across the app and the CLI
 *  (`bsc graph gist` / `bsc ui gist`, slice 3), not a second one invented here. */
export type ContentHash = string;

/** What the local side knows about its remote, persisted alongside the store.
 *
 *  `lastSyncedHash` is the ANCESTOR: the document content at the last successful push or pull. It is what
 *  makes a three-way decision possible, and it is why this is state and not a derived value. */
export interface GistSyncState {
  /** The gist id, once one exists. Absent ⇒ never published. */
  gistId?: string;
  /** The content hash at the last successful sync. Absent ⇒ never synced. */
  lastSyncedHash?: ContentHash;
}

/** What the sync should do. */
export type SyncAction =
  /** Identical on both sides — nothing to do. */
  | { kind: "up-to-date" }
  /** No gist yet: publish the local document as the first revision. */
  | { kind: "create" }
  /** Local moved, remote did not — push a new revision. */
  | { kind: "push" }
  /** Remote moved, local did not — take the remote copy. */
  | { kind: "pull" }
  /** BOTH moved, and they disagree. Stop and report; never overwrite either side. */
  | { kind: "diverged"; local: ContentHash; remote: ContentHash; base?: ContentHash }
  /** Connected to a gist whose content matches nothing we have a record of — we cannot tell which side
   *  is newer, so this is reported rather than resolved. Distinct from `diverged` because the cause is a
   *  MISSING ancestor (a fresh clone, a cleared cache, a gist adopted by url) rather than two real edits. */
  | { kind: "unrelated"; local: ContentHash; remote: ContentHash };

/** The inputs a decision needs. `remote` is `null` when the gist does not exist or could not be read. */
export interface SyncInputs {
  local: ContentHash;
  remote: ContentHash | null;
  state: GistSyncState;
}

/**
 * Decide what to do with one store document.
 *
 * Precedence, and every branch is a deliberate refusal to guess:
 *
 * | local vs remote | local vs base | remote vs base | action |
 * |---|---|---|---|
 * | — | — | — (no gist) | `create` |
 * | equal | — | — | `up-to-date` |
 * | differ | same | moved | `pull` — only local is unchanged, so nothing of ours is at risk |
 * | differ | moved | same | `push` — only remote is unchanged, so nothing of theirs is at risk |
 * | differ | moved | moved | `diverged` — both edited; STOP |
 * | differ | (no base) | (no base) | `unrelated` — no ancestor to reason from; STOP |
 *
 * The two STOP verdicts are the point of the whole function. A sync that resolves an ambiguity by picking
 * a side is a sync that silently deletes work, and which side it deletes depends on which machine ran it
 * last — the least predictable possible failure. Reporting is always available; undoing is not.
 */
export function decideSync({ local, remote, state }: SyncInputs): SyncAction {
  // No gist (or unreadable): the local document becomes the first revision. Deliberately BEFORE the
  // equality check — with no remote there is nothing to be equal to.
  if (!state.gistId || remote === null) return { kind: "create" };

  if (local === remote) return { kind: "up-to-date" };

  const base = state.lastSyncedHash;
  // No ancestor: a fresh checkout, a cleared cache, or a gist adopted by url. The two sides differ and
  // nothing says which came first — the one case where even "local wins" is a guess, because the local
  // copy may be the empty seed of a machine that has never synced.
  if (base === undefined) return { kind: "unrelated", local, remote };

  const localMoved = local !== base;
  const remoteMoved = remote !== base;
  if (localMoved && remoteMoved) return { kind: "diverged", local, remote, base };
  if (remoteMoved) return { kind: "pull" };
  // Only local moved. (Both unmoved is impossible here: `local === remote` already returned.)
  return { kind: "push" };
}

/** Is this an action the sync may perform unattended? The two STOP verdicts need a human, and the caller
 *  must not have to remember which those are. */
export function isAutomatic(a: SyncAction): boolean {
  return a.kind !== "diverged" && a.kind !== "unrelated";
}

/** A one-line explanation for the UI and for `bsc … gist status` (slice 3). States which side moved,
 *  because "out of sync" without a direction is not actionable. */
export function explainSync(a: SyncAction, store: string): string {
  switch (a.kind) {
    case "up-to-date": return `${store}: in sync with its gist.`;
    case "create":     return `${store}: not published yet — the next sync creates the gist.`;
    case "push":       return `${store}: local has changes the gist does not — the next sync pushes a revision.`;
    case "pull":       return `${store}: the gist has changes local does not — the next sync takes them.`;
    case "diverged":   return `${store}: BOTH sides changed since the last sync. Nothing was overwritten. Compare the gist's latest revision against local and pick a side.`;
    case "unrelated":  return `${store}: local and the gist differ and there is no record of a shared starting point, so neither can be called newer. Nothing was overwritten.`;
  }
}

/** SHA-256 hex of a document, via WebCrypto — byte-identical to `bsc-cli-util::vendored::sha256_hex`, so
 *  the app and the CLI (slice 3) compare content the same way. Async because `crypto.subtle` is. */
export async function sha256Hex(text: string): Promise<ContentHash> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The canonical serialization a store document is hashed and stored as.
 *
 *  Key order is normalized recursively: two machines that hold identical data must produce identical
 *  bytes, or every sync reads as `diverged` on key order alone. (`stableStringify` in `seedRefresh.ts`
 *  exists for the same reason one layer down — the seed hash — and this mirrors it deliberately rather
 *  than importing it, because `shared/` may not reach into a feature.) */
export function canonicalDocument(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? "null" : canonicalDocument(v))).join(",")}]`;
  const o = value as Record<string, unknown>;
  const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalDocument(o[k])}`).join(",")}}`;
}
