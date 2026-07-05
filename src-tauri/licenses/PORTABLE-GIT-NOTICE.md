# PortableGit (Windows) — GPL notice + written source offer

> TODO(#1277): This is a **placeholder**. Fill in the real license references and the written
> source offer before PortableGit is actually bundled. Do not fabricate license text.

The Windows build bundles a trimmed **PortableGit** (Git for Windows), which packages:

- **git** — GNU General Public License, version 2 (GPLv2)
- **bash** and **coreutils** — GNU General Public License, version 3 (GPLv3)

These are exec'd over a PTY (mere aggregation), not linked into the app. Redistribution is
permitted under the GPL, which requires shipping the license texts and a **written offer for the
corresponding source code**.

## TODO before bundling

1. Include the verbatim GPLv2 and GPLv3 license texts (or reference the copies inside the bundled
   PortableGit tree).
2. Written source offer: a URL to the exact upstream source for the **pinned** PortableGit version
   we ship (see `PORTABLE_GIT_VERSION` in `scripts/stage-sidecar.mjs`), e.g. the corresponding
   git-for-windows release source tag, valid for at least three years.
3. Keep this notice pinned in lockstep with `PORTABLE_GIT_VERSION`.

Upstream: https://github.com/git-for-windows/git/releases
