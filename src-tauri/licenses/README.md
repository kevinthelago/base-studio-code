# Bundled third-party tool licenses (#1277)

When the app bundles the host toolchain (issue #1277), each bundled tool carries a
redistribution obligation. This directory is where those notices live so the installer can ship
them alongside the binaries.

> STATUS: **scaffolding only.** The placeholder files below are TODO markers — the real license
> text and the GPL written source offer must be filled in *before* the binaries are actually
> bundled (the deferred half of #1277). Do not fabricate license text.

## Tools and their obligations

| Tool | License | Obligation |
|---|---|---|
| `gh` (GitHub CLI) | MIT | Ship the MIT license + copyright notice. Freely redistributable. |
| `git` (in PortableGit, Windows) | GPLv2 | Ship the license + a **written offer for source** (mere aggregation — exec'd over a PTY, not linked). |
| `bash` + coreutils (in PortableGit, Windows) | GPLv3 | Ship the license + a **written offer for source**. |

## Files

- `GH-LICENSE-MIT.txt` — TODO: the upstream `gh` MIT license text + copyright line.
- `PORTABLE-GIT-NOTICE.md` — TODO: the GPLv2/GPLv3 license references + the written source offer
  (a URL to the exact upstream source for the pinned PortableGit version we ship).

## Where these get surfaced (deferred)

- Included as `bundle.resources` in `src-tauri/tauri.conf.json` so they land in the installed app.
- Referenced from the in-app About / Diagnostics surface.

Pinned versions live in `scripts/stage-sidecar.mjs` (`GH_VERSION`, `PORTABLE_GIT_VERSION`); keep the
notices in this directory in lockstep when those bump (the bundled tools are ours to patch — the
CVE/maintenance treadmill of #1189/#1254).
