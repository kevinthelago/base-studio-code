// Request #169: two callers each carried their own copy of this function — `promote-records.mjs`, and
// the since-deleted `sync-impl-seed.mjs` (ported to `bsc graph impl sync-seed`, #157) — and both copies'
// docstrings claimed the packaged seed (`src-tauri/data/knowledge/algorithms.json`)
// is written 1-space indented with non-ASCII escaped and no trailing newline — Python's
// `json.dumps(d, indent=1, ensure_ascii=True)`. Measured against the actual file: it is 2-space indented,
// non-ASCII left as literal UTF-8, WITH a trailing newline — i.e. `JSON.stringify(value, null, 2) + "\n"`.
// Reconstructing with the documented (wrong) format differs from the real file by 72,941 bytes on today's
// seed, which means `--apply` would have reformatted the entire 6.6 MB file on its next real run — the
// exact whole-file-reformat both docstrings said this function exists to prevent.
//
// One shared, tested function now, so the two call sites cannot drift from each other again the way they
// drifted from the file.
export function serializeSeed(value) {
  return JSON.stringify(value, null, 2) + "\n";
}
