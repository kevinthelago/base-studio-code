// RUNTIME ATTESTATION (#runtime-attests-what-actually-ran) — record which record ACTUALLY served each
// module, at the moment the runtime decides it.
//
// ~930 of this app's frontend modules ship as RECORDS (epic #3604), and nothing could answer the first
// question anyone asks about that: is the record what is running? The loader already DECIDES — it
// declines a record that will not compile, whose closure needs a module that is neither registered nor a
// record, or that throws while evaluating, and serves the bundled platform module instead — but the only
// trace was a `graph-loader:` warn line. A migrated record could be inert in production and look exactly
// like a working one.
//
// WHY A SINK RATHER THAN A RETURN VALUE. The decisions happen at four different depths inside
// `loadComponentFromSource` and `GraphComponent`, several of them inside callbacks the caller never sees.
// Threading a result out of each would change five signatures to carry data none of those layers has any
// other use for. A module-level sink is a no-op until someone installs a writer, which is also what makes
// every test that touches the loader unaffected.
//
// COALESCED IN MEMORY, FLUSHED IN BATCHES. A page mount links a closure of hundreds of modules; a
// per-load message would be tens of thousands of IPC calls a session to answer a question that needs
// three numbers. Observations fold on `specifier|recordId|srcHash|outcome` here, exactly as the store
// folds them, and go out on a timer.
//
// IT MUST NEVER BREAK A RENDER. Every entry point swallows its own errors: attestation is an
// observation, and an observation that can fail the thing it observes is worse than no observation.
import { invoke } from "@tauri-apps/api/core";

/** What happened when the runtime resolved a module. Mirrors `Outcome` in `crates/bsc-runtime`. */
export type AttestOutcome =
  | "served"           // compiled, linked, evaluated, mounted — the record IS what ran
  | "declined-compile" // does not compile; the platform module served instead
  | "declined-closure" // needs a module that is neither registered nor a record
  | "declined-eval"    // compiled and linked, threw at module init
  | "fell-back"        // the current version failed to render; the last good one served
  | "render-threw"     // mounted, then threw during render
  | "linked";          // pulled into a closure that served — what an implementation record gets

/** One observation, before coalescing. */
export interface AttestInput {
  specifier: string;
  /** The record that served it. Omitted when a FILE served — the store keeps that as `''`, and it is
   *  what makes "this record was seen" false for a record that never existed. */
  recordId?: string;
  /** The hash of the source that actually ran. See {@link srcHash}. */
  srcHash?: string;
  outcome: AttestOutcome;
  /** Why it was declined — kept from the first occurrence, so pass the useful form. */
  reason?: string;
  /** Milliseconds this single observation took (compile, or render). */
  ms?: number;
}

/** The wire row, matching `NewAttestation` in `crates/bsc-runtime`. snake_case because Tauri passes it
 *  through to serde, and the Rust side is the schema's owner. */
interface AttestRow {
  specifier: string;
  record_id: string;
  src_hash: string;
  outcome: string;
  session: string;
  n: number;
  reason: string | null;
  ms_total: number;
  ms_max: number;
  at: number;
}

// ── The source hash — a CROSS-LANGUAGE CONTRACT ─────────────────────────────────────────────────────

const FNV_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const U64 = 0xffffffffffffffffn;

/**
 * Hash a module's source to the 16-char lowercase hex the Rust side produces (`bsc_runtime::src_hash`).
 *
 * THIS IS THE CONTRACT THE WHOLE STORE RESTS ON. The frontend hashes what it compiled; `doctor` hashes
 * what is in the store now; "is the record what is running" is the comparison. If the two languages
 * disagree, every answer becomes noise — delivered confidently, which is worse than no answer at all.
 * `data/runtime/hash.fixtures.json` pins them together and both sides assert against it.
 *
 * UTF-8 BYTES, not JavaScript's UTF-16 code units. A char-wise implementation agrees with Rust on ASCII
 * and diverges on the first non-ASCII source — and this repo's records are full of em dashes and arrows
 * in comments, so that divergence would be the normal case, not an edge case.
 *
 * BigInt, not Number: `Number` loses precision above 2^53 and FNV is a 64-bit rolling multiply, so a
 * Number implementation produces a stable-looking hash that simply is not FNV-1a. Cost is irrelevant
 * here — this runs once per compile, not per render.
 */
export function srcHash(source: string): string {
  let h = FNV_OFFSET_BASIS;
  for (const b of new TextEncoder().encode(source)) {
    h = (h ^ BigInt(b)) & U64;
    h = (h * FNV_PRIME) & U64;
  }
  return h.toString(16).padStart(16, "0");
}

// ── The sink ────────────────────────────────────────────────────────────────────────────────────────

/** One app run. Regenerated per page load, which is what makes a session the coalescing boundary — see
 *  the schema note on why folding across sessions would make "has not served since it changed"
 *  unanswerable. Not a uuid: no dependency, and collisions across two runs are harmless here. */
const SESSION = `s-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;

/** Pending observations, folded on the store's own key. */
const pending = new Map<string, AttestRow>();

/** How long to let observations accumulate before a flush. Long on purpose: a page mount produces its
 *  whole closure in one tick, so anything shorter just splits one batch into several. */
const FLUSH_MS = 5_000;

/** The largest batch we will hold before flushing early — a burst (a first page mount links hundreds of
 *  modules) should not wait out the timer holding memory. */
const MAX_PENDING = 500;

let timer: ReturnType<typeof setTimeout> | null = null;
/** Off until installed. Nothing attests in tests, in the preview sandbox, or before the app is ready —
 *  and a sink that is off costs one map lookup, not an IPC call. */
let enabled = false;

/** Turn attestation on. Called once by the app shell; a no-op everywhere else, which is why the loader
 *  can call {@link attest} unconditionally without every test needing a Tauri mock. */
export function enableAttestation(): void {
  enabled = true;
}

/** The session id this run's rows are written under — exposed so a caller can correlate a log line. */
export function attestSession(): string {
  return SESSION;
}

/** Record one observation. Cheap, synchronous, and never throws. */
export function attest(a: AttestInput): void {
  if (!enabled) return;
  try {
    const recordId = a.recordId ?? "";
    const hash = a.srcHash ?? "";
    const key = `${a.specifier}|${recordId}|${hash}|${a.outcome}`;
    const ms = typeof a.ms === "number" && Number.isFinite(a.ms) ? a.ms : 0;
    const existing = pending.get(key);
    if (existing) {
      existing.n += 1;
      existing.ms_total += ms;
      existing.ms_max = Math.max(existing.ms_max, ms);
      existing.at = Date.now();
      // `reason` is NOT overwritten — the first cause recorded is the diagnostic, and the store applies
      // the same rule, so the two halves cannot disagree about which one survived.
    } else {
      pending.set(key, {
        specifier: a.specifier,
        record_id: recordId,
        src_hash: hash,
        outcome: a.outcome,
        session: SESSION,
        n: 1,
        reason: a.reason ?? null,
        ms_total: ms,
        ms_max: ms,
        at: Date.now(),
      });
    }
    if (pending.size >= MAX_PENDING) {
      void flushAttestations();
    } else if (!timer) {
      timer = setTimeout(() => void flushAttestations(), FLUSH_MS);
    }
  } catch {
    // An observation must never break the thing it observes.
  }
}

/**
 * Send everything pending and clear it. Safe to call at any time; a no-op when nothing is pending.
 *
 * DRAINS BEFORE AWAITING. The map is emptied synchronously so observations arriving during the IPC land
 * in the next batch rather than being cleared unsent — the classic flush race, and here it would drop
 * exactly the evidence a slow page is generating.
 *
 * A failed flush drops its batch on purpose. Retrying would grow the queue while the app is already
 * unhappy, and attestation is a soft signal: a lost batch costs a slightly lower `n`, while a retry loop
 * costs the app.
 */
export async function flushAttestations(): Promise<void> {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (pending.size === 0) return;
  const rows = [...pending.values()];
  pending.clear();
  try {
    await invoke("record_attestations", { rows });
  } catch {
    // Swallowed: see above. The app is the point; the measurement is not.
  }
}

/** Drop everything pending WITHOUT sending — tests only, so one case cannot leak into the next. */
export function __resetAttestationsForTest(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  pending.clear();
  enabled = false;
}

/** The pending batch, for tests to assert coalescing without reaching into module state. */
export function __pendingAttestationsForTest(): AttestRow[] {
  return [...pending.values()];
}
