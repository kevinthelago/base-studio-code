/**
 * Is this `bsc` usable? — asked from OUTSIDE the binary, because the cases that matter cannot answer.
 *
 * # The mechanism, measured rather than assumed
 *
 * ```
 * : > fake.exe ; chmod +x fake.exe
 * ./fake.exe some args      ->  EXIT 0, no output
 * printf 'x' > bad.exe      ->  `bad.exe: line 1: x: command not found`, EXIT 127
 * ```
 *
 * Bash cannot exec a file with no valid PE header, so it falls back to running it as a SHELL SCRIPT. A
 * non-empty invalid file becomes a script that errors loudly. An **empty** one becomes an EMPTY SCRIPT,
 * which succeeds silently. So a zero-length binary — what a broken or interrupted link leaves behind —
 * is indistinguishable from every command passing.
 *
 * That happened on 2026-08-19: `target/debug/bsc.exe` sat at 0 bytes and produced three confident,
 * entirely wrong conclusions about fresh-clone behaviour before `ls -l` caught it.
 *
 * # Why this cannot live in the binary
 *
 * `bsc self version` exists and reports build time and path. It is useless here: asking a broken binary about
 * itself returns the same silent success as asking it anything else. Detection that runs INSIDE the
 * binary is unreachable exactly when it is needed, so these checks inspect the FILE and then demand a
 * real handshake.
 *
 * Everything here is injectable (`statSize`, `run`, `now`) so the decisions are unit-testable without a
 * binary, a filesystem, or a subprocess.
 */

export const EXE = process.platform === "win32" ? "bsc.exe" : "bsc";

/** Where a built or staged `bsc` may live, most-local first. */
export function candidatePaths(root, home, join) {
  return [
    join(root, "target", "debug", EXE),
    join(root, "target", "release", EXE),
    join(home, ".base-studio-code", "bin", EXE),
  ];
}

/**
 * Classify one candidate. `run(path)` must return `{ status, stdout }` for `<path> version`.
 *
 * The order is deliberate: SIZE first, because a zero-length file must never be executed — running it
 * is the thing that produces the misleading success.
 */
export function inspect(path, { statSize, run }) {
  const size = statSize(path);
  if (size === null) return { path, ok: false, state: "absent", detail: "no file at this path" };
  if (size === 0) {
    return {
      path,
      ok: false,
      state: "zero-byte",
      size,
      detail:
        "ZERO BYTES — a broken link. Through bash this exits 0 printing nothing, which is " +
        "indistinguishable from every command passing. Rebuild: cargo build -p bsc --bin bsc",
    };
  }
  const { status, stdout } = run(path);
  const line = String(stdout ?? "").trim();
  if (status !== 0 || !/^bsc\s/.test(line)) {
    return {
      path,
      ok: false,
      state: "no-handshake",
      size,
      detail:
        `ran but did not identify itself (exit ${status}, ${line ? `stdout ${JSON.stringify(line.slice(0, 60))}` : "no stdout"}) — ` +
        "an incoherent build. Rebuild: cargo build -p bsc --bin bsc",
    };
  }
  return { path, ok: true, state: "usable", size, version: line.split("\n")[0].trim() };
}

/**
 * Is `binaryMtime` behind the newest source change?
 *
 * This is the practical form of "which build am I?". The `built …` line `bsc self version` prints comes from
 * the exe's own MTIME (`current_exe()` + metadata), not a compile-time stamp — so a COPY reports when it
 * was copied, and a month-old binary staged today looks fresh. Comparing against the tree sidesteps that
 * entirely and costs no build change.
 */
export function freshness(binaryMtime, newestSourceMtime) {
  if (binaryMtime === null || newestSourceMtime === null) return { known: false };
  const behindMs = newestSourceMtime - binaryMtime;
  return { known: true, stale: behindMs > 0, behindMs };
}

/** `1m 12s` / `3d 4h` — a duration a reader can act on, rather than a millisecond count. */
export function humanizeMs(ms) {
  const s = Math.round(Math.abs(ms) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/**
 * The first USABLE candidate, or null.
 *
 * Existence is not enough and never was — that is the whole lesson of the zero-byte case.
 */
export function pickUsable(paths, deps) {
  for (const p of paths) {
    const r = inspect(p, deps);
    if (r.ok) return r;
  }
  return null;
}
