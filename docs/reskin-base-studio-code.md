# Reskin base-studio-code (#1212)

A blueprint that re-themes **base-studio-code itself** to your taste — palette, fonts, roundness,
density, light/dark — by pointing a planning session at *your own clone/fork* and letting the agent
fleet edit the design tokens.

It ships as a **GitHub gist** (imported, not packaged): it's self-referential — only useful if you
have the base-studio-code source — and niche, so it stays out of the default catalog (keeping it lean)
while doubling as the flagship demo of the blueprint-authoring + gist-distribution lifecycle.

- **Gist:** https://gist.github.com/kevinthelago/1ebfa7469fee09ca8b4ef96ab8f2f201
- **Canonical source (versioned here):** [`docs/blueprints/bsc-reskin/extension.json`](blueprints/bsc-reskin/extension.json)
- **Category / mode:** `transform` / `operate` (restyle an existing repo in place)

## Use it

1. **Import** — in the planner's Blueprints library, choose **Import from gist** and paste the gist
   URL above. It lands in your library; it is **not** added to the packaged built-ins.
2. **Select** it as the blueprint for a new planning session.
3. **Link your clone** — in the Repos stage, link your local **base-studio-code** clone/fork (this is
   the repo the reskin edits).
4. **Run** — the session walks you through the look (palette, mode, typography, shape/density, scope),
   produces concrete oklch token values + font wiring, and the fleet lands the change on a branch/PR
   against your clone.

## What it edits (and what it never touches)

- **Edits:** `src/styles/tokens.css` — the `:root` (dark) palette + the `[data-theme="light"]` block,
  `--sans`/`--mono` and the fonts loaded in `index.html`, and the `--r-*` radii. Optional scoped
  per-surface overrides use the existing `.console-theme` pattern.
- **Never edits:** anything under `design/` — that's the reference prototype, **not** the live app.
  The bundled **"Reskin base-studio-code"** skill encodes this guardrail along with the token catalog,
  the oklch conventions, the light/dark mechanism, the scoped-override pattern, and the font-swap steps.

## Maintaining / re-publishing

The gist is published verbatim from the canonical source above. To update it, edit
`docs/blueprints/bsc-reskin/extension.json`, bump the manifest `version`, and update the gist
(`gh gist edit <id> docs/blueprints/bsc-reskin/extension.json`, or re-publish from the planner's
blueprint-authoring flow). A CI test (`src/features/planner/blueprints/bscReskinGist.test.ts`) keeps
the source valid against the same envelope + blueprint coercion the in-app import runs.
