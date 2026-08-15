// Coalesced `bsc` reads (#five-callers-one-spawn-for-the-same-plan-read) — many callers, one process.
//
// Every `bsc` call the app makes is a PROCESS LAUNCH. `bsc perf spawns` measured what that costs when one
// read has several independent consumers: `plan list --full` at 113 calls / 57.9s, because five hooks —
// useProjectComplete, useStreamProgress, useFleetHeld, resumeProject and AppBanners — each spawn their own
// process for the same bytes, on their own polling clocks, forever.
//
// This is a KNOWN class here. `bsc project progress` exists precisely so a caller wanting every project's
// progress makes one spawn instead of one per project, and its help records that spawning N processes "has
// repeatedly cost this app whole seconds (#3908 / #3912 / #3944 / #3954)". This is the same shape one level
// up: not N projects, but N callers of one read.
//
// TWO MECHANISMS, and they are not equally strong:
//
//   1. IN-FLIGHT JOIN — unconditionally correct and needs no TTL. Two identical reads happening at the same
//      moment should never be two processes; the second joins the first's promise.
//   2. TTL REUSE — a judgement the CALLER makes. A reading newer than `ttlMs` is served without spawning.
//
// WHAT IS SHARED IS THE RAW STDOUT, NOT A PARSED RESULT — and that is a correctness requirement, not a
// convenience. The first version cached whatever `bscJson` returned, which meant a joiner inherited the
// ORIGINATOR's fallback: `useStreamProgress` reads this list with a `null` fallback and `useProjectComplete`
// with `[]`, so a failed read started by the former handed `null` to the latter, which promptly did
// `.length` on it. The test suite caught it as an unhandled rejection. Sharing the raw bytes and letting
// each caller apply its OWN fallback removes the coupling entirely — and removes the need to guess whether
// a returned value "is" the fallback.
//
// WHY OPT-IN, NEVER BLANKET. A general cache over `bsc` would be wrong: writes must never be cached, and
// some reads must be fresh. The caller passes the TTL, so the staleness each site accepts is visible at
// that site rather than buried in a helper.
import { bsc } from "@/shared/lib/core/bsc";

interface Entry {
  /** The in-flight read, if one is running — what a second caller joins. Resolves to RAW stdout. */
  inflight?: Promise<string>;
  /** The last SUCCESSFUL stdout and when it landed. */
  out?: string;
  at?: number;
}

/** Keyed by project + the whole argument list: the same command for two projects is two different reads,
 *  and `plan list` is not `plan list --full`. */
const cache = new Map<string, Entry>();

const keyOf = (projectKey: string | null, args: string[]) => `${projectKey ?? ""} ${args.join(" ")}`;

/**
 * The shared raw read. THROWS on failure — deliberately, so each caller decides what a failure means to it
 * rather than inheriting whatever the first caller decided.
 */
async function sharedRaw(projectKey: string | null, args: string[], ttlMs: number): Promise<string> {
  const key = keyOf(projectKey, args);
  const entry = cache.get(key) ?? {};

  if (entry.at !== undefined && entry.out !== undefined && Date.now() - entry.at < ttlMs) {
    return entry.out;
  }
  if (entry.inflight) return entry.inflight;

  const inflight = bsc(projectKey, args)
    .then((raw) => {
      const out = raw.trim();
      cache.set(key, { out, at: Date.now() });
      return out;
    })
    .catch((e) => {
      // A failed read leaves NOTHING behind: a transient failure must not pin an answer for the window.
      cache.delete(key);
      throw e;
    });

  cache.set(key, { ...entry, inflight });
  return inflight;
}

/**
 * Read `bsc … --json` alongside other callers, spawning at most one process per `ttlMs` window.
 *
 * `fallback` is this CALLER's own — returned when the read fails or produces nothing, exactly as
 * {@link import("@/shared/lib/core/bsc").bscJson} does, and never shared with another caller.
 *
 * @param ttlMs How stale an answer this caller will accept. Pass a value it genuinely tolerates: a hook
 *              polling every 20s already accepts 20s-old data, so a 20s TTL costs it nothing and removes
 *              four process launches. `0` disables reuse and leaves only the in-flight join, which cannot
 *              serve stale data at all.
 */
export async function bscJsonShared<T>(
  projectKey: string | null,
  args: string[],
  fallback: T,
  ttlMs: number,
): Promise<T> {
  try {
    const out = await sharedRaw(projectKey, args, ttlMs);
    return out ? (JSON.parse(out) as T) : fallback;
  } catch {
    return fallback;
  }
}

/** Drop every cached reading — for tests, and for a caller that knows the underlying store just changed. */
export function clearBscShared(): void {
  cache.clear();
}
