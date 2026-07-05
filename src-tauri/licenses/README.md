# Bundled third-party tool licenses (#1277)

When the app bundles the host toolchain (issue #1277), each bundled tool carries a
redistribution obligation. This directory is where those notices live so the installer can ship
them alongside the binaries.

> STATUS: **license text is real and complete** (slice 2, #1277). The notices below carry the
> actual upstream license texts + the GPL written source offer, pinned to the versions in
> `scripts/stage-sidecar.mjs`. What remains deferred is the *bundling wiring* — landing this
> directory in the installer via `bundle.resources` and shipping the actual binaries — not the
> license text. Do not fabricate or edit the verbatim GPL/MIT texts; only re-fetch them from
> upstream when a pinned version bumps.

## Tools and their obligations

| Tool | License | Obligation | Status |
|---|---|---|---|
| `gh` (GitHub CLI) | MIT | Ship the MIT license + copyright notice. Freely redistributable. | ✅ text included (`GH-LICENSE-MIT.txt`) |
| `git` (in PortableGit, Windows) | GPLv2 | Ship the license + a **written offer for source** (mere aggregation — exec'd over a PTY, not linked). | ✅ `GPLv2.txt` + offer in `PORTABLE-GIT-NOTICE.md` |
| `bash` + coreutils (in PortableGit, Windows) | GPLv3 | Ship the license + a **written offer for source**. | ✅ `GPLv3.txt` + offer in `PORTABLE-GIT-NOTICE.md` |

## Files

- `GH-LICENSE-MIT.txt` — the upstream `gh` MIT license text + copyright line (verbatim, from
  `cli/cli` v2.62.0 `LICENSE`).
- `GPLv2.txt` — the verbatim GNU GPL version 2 text (FSF canonical, `gnu.org/licenses/gpl-2.0.txt`),
  for the bundled `git`.
- `GPLv3.txt` — the verbatim GNU GPL version 3 text (FSF canonical, `gnu.org/licenses/gpl-3.0.txt`),
  for the bundled `bash` + coreutils / MSYS2 userland.
- `PORTABLE-GIT-NOTICE.md` — the GPLv2/GPLv3 license references + the **written offer for source**
  (URLs to the exact upstream source for the pinned PortableGit version we ship, valid ≥ 3 years).

## Where these get surfaced (bundling still deferred — the maintainer's release pass)

- **Intended:** included as `bundle.resources` in `src-tauri/tauri.conf.json` so they land in the
  installed app, and referenced from the in-app About / Diagnostics surface.
- **Why not wired yet:** adding these to `bundle.resources` is safe (the files exist), but the
  binaries they cover (`gh`, `portable-git/`) are only staged at release time
  (`BSC_STAGE_TOOLCHAIN=1 npm run stage:sidecar`) and are NOT committed. Wiring `externalBin`/
  `resources` for those binaries in a way that keeps a normal dev `tauri build` green (Tauri fails
  the build if a referenced binary/resource is missing) is the final release-time step — see the
  `#1277` PR notes and `scripts/stage-sidecar.mjs`.

Pinned versions live in `scripts/stage-sidecar.mjs` (`GH_VERSION`, `PORTABLE_GIT_VERSION`); keep the
notices in this directory in lockstep when those bump (the bundled tools are ours to patch — the
CVE/maintenance treadmill of #1189/#1254).
