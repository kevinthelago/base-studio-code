# PortableGit (Windows) — GPL notice + written offer for source

The Windows build of base-studio-code bundles a trimmed **PortableGit** (Git for Windows),
which packages a POSIX userland the agent sessions need:

- **git** — GNU General Public License, version 2 (GPLv2). See `GPLv2.txt` in this directory.
- **bash**, **coreutils**, and the rest of the MSYS2/MinGW userland — GNU General Public
  License, version 3 (GPLv3). See `GPLv3.txt` in this directory.

These tools are executed as separate processes over a PTY (**mere aggregation** — they are not
linked into the application). Redistribution is permitted under the GPL, which requires that we
ship the license texts (done — `GPLv2.txt` / `GPLv3.txt` here, and the copies inside the bundled
PortableGit tree under `portable-git/usr/share/doc/` and `portable-git/mingw64/share/doc/git-doc/`)
and make a **written offer for the corresponding source code** (below).

Pinned version: **PortableGit 2.47.1** (`git-for-windows/git` release `v2.47.1.windows.1`).
See `PORTABLE_GIT_VERSION` in `scripts/stage-sidecar.mjs`; keep this notice in lockstep when it bumps.

## Written offer for source

The complete corresponding source code for the GPL-licensed components bundled with this
application (the pinned Git for Windows / PortableGit release above, which itself packages git,
bash, coreutils, and the MSYS2 runtime) is available from the upstream project at the exact
pinned tag:

- Git for Windows release (binaries + notes): https://github.com/git-for-windows/git/releases/tag/v2.47.1.windows.1
- Git for Windows source (this release's tag): https://github.com/git-for-windows/git/tree/v2.47.1.windows.1
- Upstream Git source: https://github.com/git/git
- MSYS2 / bash / coreutils source: https://github.com/git-for-windows/MSYS2-packages and https://github.com/msys2/MSYS2-packages

For a period of at least three (3) years from the date this build was distributed, on request we
will also provide the complete corresponding machine-readable source code for the GPL-licensed
components in this build, on a medium customarily used for software interchange, for no more than
our cost of physically performing the source distribution. Requests may be sent through the
project's GitHub repository (https://github.com/kevinthelago/base-studio-code) issue tracker.

## Where these get surfaced

- Shipped in the installed app via `bundle.resources` in `src-tauri/tauri.conf.json`
  (this `licenses/` directory) — see `README.md` here for the current wiring status.
- Referenced from the in-app About / Diagnostics surface.
