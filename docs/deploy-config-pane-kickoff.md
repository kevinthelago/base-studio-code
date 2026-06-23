# Claude Design kickoff — Deploy stage pane (REDESIGN)

Paste this whole brief into a Claude Design session. Deliverable: functionless React **JSX skeletons** (Babel-standalone style, no real logic) for the pane and its states, using the exact design tokens below, so it drops into base-studio-code with minimal rewiring.

> **This is a redesign.** A working version of this pane already ships — it's *functional but visually flat and busy*: seven near-identical stacked cards of dense mono text, weak hierarchy, no sense of the deploy "flow," and the newest concern (dependencies) bolted on at the bottom. **Keep every capability, but give it a fresh, cleaner take:** stronger visual hierarchy and grouping, more breathing room, a legible build→ship narrative, and clear primary vs secondary information. Stay dense and technical (it's a config surface) — just calmer and more designed. Don't feel bound to "one card per concern, all equal weight."

---

## 1. What you're designing

The **Deploy stage** pane inside base-studio-code's **project planner**. It's where the user — with the AI planner pre-filling proposals — defines the two halves of getting a project running: **how it ships** (hosting/target, environments, CI/CD pipeline, config + secrets, release/rollback + health) **and what it depends on** (the locked libraries each repo needs, and where they're sourced from). The output is *structured config*, not prose: completing it generates tracked GitHub issues and an owning agent "stream," and seeds each repo's dependency manifests — the same way the other planning stages produce real artifacts.

It is a **sibling to the existing Permissions/Structure stage panes** — same chrome, same gate/footer vocabulary — but its own configuration surface.

## 2. Product context (so the design fits)

- **base-studio-code** is a desktop app (Tauri + React, dark-first) for running many AI coding agents in parallel. Its flagship feature is the **project planner**: a pitch is turned into a plan **one stage at a time** — context → repos → **deploy** → features → UI → structure → permissions. The **deploy** stage is where both the shipping config *and* the project's locked dependencies are decided.
- The planning page is a **split**: a live Claude terminal session on the left, and a **focused pane** on the right that shows **one stage at a time**. The focused pane has a fixed vocabulary you must match:
  - a **stepper** (the stages, with status dots),
  - a **stage header** (title + a **gate pill** — "met" vs "N/M needed"),
  - a **scrolling body** (`.pp-scroll`, padding `14px 16px 18px`),
  - a **footer advance bar** (`← back` · `phase X of Y` · a primary **approve & continue →** action).
- This pane is the **body** of the new **Deploy** stage. Design the body; the stepper/header/footer already exist (show them lightly for context, but the focus is the body).
- **Multi-repo aware:** a project can span several repos/services; deployment config is **per service**, with shared/global pieces (environments, secrets policy) above.

## 3. Goal of the pane

Let the user, fast and with sensible planner-proposed defaults, answer: **where does each service run, through what pipeline, in which environments, with what release + rollback + health strategy — and what libraries does it depend on, from which registries** — to a level of detail an agent can then implement (write the CI workflow, provision config, wire health checks) and a fleet can build against (the deps are seeded into each repo before any agent starts). Everything is editable; the planner proposes, the user confirms/edits.

## 4. Sections of the pane (top to bottom)

Render these as **cards** (`--bg-panel`, `1px solid --border-soft`, `--r-lg`), each with a small mono uppercase section label. A subtle "✦ proposed by planner" affordance where the planner pre-filled a value (the user can accept/override).

1. **Target & hosting** *(per service)* — for each linked repo/service, choose a **deploy target**: a grid of platform tiles — **Vercel, Netlify, Cloudflare Pages/Workers, Fly.io, Railway, Render, AWS, GCP, Azure, GitHub Pages, self-hosted (Docker / Kubernetes)**. Selecting one reveals platform-relevant fields (region, build command, output dir / Dockerfile, runtime). Note the workload kind: **static · serverless · container · long-running service**.
2. **Environments** — manage the environment ladder: **dev → staging → prod** (add / remove / rename). Per env: domain/URL, the **branch → environment** mapping (e.g. `develop → staging`, `main → prod`), and the promotion flow between them.
3. **CI/CD pipeline** — provider (**GitHub Actions** default; allow others). A **visual staged pipeline**: `build → test → release/deploy`, with the trigger per stage (on push / on tag / manual / on-green) and a gate marker where a stage blocks promotion. This is the marquee element — make the build→test→deploy chain legible and editable.
4. **Config & secrets** — per-environment env vars + secret **names** (values are never entered here — show them as managed/blank, with a one-line "where secrets live" note: host vault / platform secret store). Distinguish plain config from secrets.
5. **Dependencies** *(NEW — design this well; it's the reason for the redesign)* — the libraries the project locks **once**, so the parallel agent fleet never each adds/redefines them and collides at integration. For each repo, a list of its locked deps; per dep show **name@version**, ecosystem (**npm** / **cargo**), a **dev** flag for test-only deps, an optional one-line **why**, and — when it doesn't come from the public default registry (npm registry / crates.io) — its **source** (a named private registry). Group by repo (with a "· all repos" group for ecosystem-wide deps). Below the deps, a small **registries / sources** subsection: each named registry → its URL, npm **scope**, and the **secret name** holding its auth token (the value lives in the vault — same model as Config & secrets above, so these two cards are visually related). Note inline that these become each repo's real `package.json` / `Cargo.toml` (+ `.npmrc` / `.cargo/config.toml` for private sources) at publish. The planner pre-fills the set; the user reviews/edits. **Empty state:** "No dependencies locked yet — the planner lists each repo's libraries here as it works this stage."
6. **Release & rollback** — strategy picker: **rolling · blue-green · canary** (+ a "recreate" simple option); the rollback policy (auto-rollback on failed health check; keep N previous releases); and a migrations-with-deploy toggle.
7. **Health & observability** — post-deploy checks: a smoke/health-probe URL, an SLO/uptime check, and where alerts go. Wire to the "Compliance/observability" story lightly.
8. **Readiness summary** — a compact recap of what's **defined vs missing** (this drives the stage's gate). The gate needs **both** shipping defined **and ≥1 dependency locked**, so show dependencies as one of the readiness lines (e.g. "✓ dependencies — 7 locked" / "○ dependencies — none yet"). Include a **preview of the deployment issues** this config generates at publish (e.g. "Add GitHub Actions deploy workflow for `web` → Vercel", "Provision staging environment + secrets", "Add prod health check + auto-rollback") plus the owning **`deploy` stream**.

## 5. States to design

1. **Empty / unconfigured** — nothing chosen yet. Friendly empty state with a primary CTA to pick the first target; the planner offers a **proposed starting config** based on the detected stack (e.g. "React + Vite → Vercel static, GitHub Actions, dev/staging/prod"). Show that proposal as an acceptable suggestion.
2. **Partially configured** — some sections done, others not. The readiness summary shows exactly what's missing; the footer's **approve & continue** is disabled with a "still needed: …" reason (matches the other stages' gate behavior).
3. **Configured (gate met)** — all required pieces defined **including ≥1 locked dependency**; readiness summary green; approve enabled; the deployment-issues preview is populated.
4. **Multi-service** — 2–3 services each with their own target/pipeline (tabs or stacked per-service blocks), with the shared Environments/Secrets/Release sections applying across them, and each repo's own dependency group in the Dependencies card.
5. **Dependencies — empty vs populated** — show the empty state (planner hasn't listed any yet) AND a populated one with a mix: several public deps, a couple of **dev** deps, and at least one dep from a **private source** (its registry shown in the registries subsection with a secret name). This card is the focus of the redesign — make it shine.

Also include the **stage in the stepper** in two states for context: *active/in-progress* and *complete*.

## 6. Design system — match these EXACTLY

Dark is the primary theme. Tokens (CSS custom properties — use them, don't hardcode hex):

```css
:root{
  --bg-canvas:oklch(0.13 0.005 250); --bg-panel:oklch(0.17 0.005 250);
  --bg-elev:oklch(0.21 0.006 250);   --bg-elev2:oklch(0.26 0.006 250);
  --border:oklch(0.30 0.006 250);    --border-soft:oklch(0.24 0.006 250);
  --fg:oklch(0.94 0.004 250); --fg-muted:oklch(0.66 0.008 250); --fg-dim:oklch(0.46 0.008 250);
  --accent:oklch(0.80 0.14 70); --accent-dim:oklch(0.55 0.10 70);
  --success:oklch(0.74 0.13 145); --info:oklch(0.72 0.10 230);
  --violet:oklch(0.72 0.12 300); --danger:oklch(0.68 0.18 25);
  --mono:"JetBrains Mono",ui-monospace,Menlo,monospace;
  --sans:"Inter",-apple-system,"Segoe UI",system-ui,sans-serif;
  --r-sm:4px; --r-md:6px; --r-lg:10px;
}
```

Conventions (the rest of the app follows these — match them so the pane is indistinguishable):
- **Type:** titles/labels in `--sans`; all metadata, counts, keys, status, and "code-ish" text in `--mono`. Section headers are small (10px) mono, uppercase, `letter-spacing:.08em`, `--fg-dim`.
- **Cards:** `background:var(--bg-panel)`, `border:1px solid var(--border-soft)`, `border-radius:var(--r-lg)`, ~`13–16px` padding. Nested rows on `--bg-elev` / `--bg-elev2`.
- **Pills/tags:** `border-radius:99px`, mono ~9.5px, tinted via `color-mix(in oklch, <hue>, transparent 88–90%)` background + `…transparent 70–78%` border. Use `--success` for "met/ready/active", `--accent` for "in progress/attention", `--info` for neutral/links, `--danger` for blocking, `--fg-dim` for inert.
- **Segmented toggles** (e.g. release strategy, trigger): the app's `Seg` pattern — a bordered row, the active segment on `--bg-elev2` + `--fg`, others transparent + `--fg-dim`.
- **Selectable tiles** (platforms): a tile grid; selected = `--accent` border + faint accent wash; hover lifts to `--bg-elev`.
- **Gate pill** in the header: "✓ ready to ship" (success, class-like `met`) vs "3/5 defined" (accent, `unmet`).
- **Footer advance bar:** `← back` · `phase X of Y` (mono, `--fg-dim`) · primary **approve & continue →** (accent fill, dark text; disabled = dim with a "still needed: …" tooltip).
- Keep it **dense and technical** but calm — this is a config surface, not marketing. No drop shadows except menus/modals. Pulse/animation only for genuinely-live status.
- Fonts via Google Fonts: `Inter` (400–700) + `JetBrains Mono` (400–600).

## 7. Data shape (use realistic sample data)

Design against a believable example so it reads true: a 2-service project — `web` (React/Vite → Vercel, static) and `api` (Rust → Fly.io, container) — with `dev/staging/prod`, GitHub Actions `build → test → deploy`, a few secret names (`DATABASE_URL`, `STRIPE_KEY`), blue-green release with auto-rollback, and a `/healthz` probe. Show the readiness summary as "missing: dependencies" in one state and fully green in another.

**Dependencies** for the same example (this is the live data shape — design to it):

```jsonc
{
  "registries": {
    // a private npm registry; auth is a SECRET NAME, value lives in the vault
    "internal": { "url": "https://npm.internal/", "scope": "@acme", "auth": "INTERNAL_NPM_TOKEN" }
  },
  "dependencies": [
    { "repo": "acme/web", "ecosystem": "npm",   "name": "zod",       "version": "^3.23", "why": "schema validation" },
    { "repo": "acme/web", "ecosystem": "npm",   "name": "@acme/ui",  "version": "^2",    "source": "internal", "why": "design system" },
    { "repo": "acme/web", "ecosystem": "npm",   "name": "vitest",    "version": "^2.0",  "dev": true, "why": "unit tests" },
    { "repo": "acme/api", "ecosystem": "cargo", "name": "serde",     "version": "1",     "why": "(de)serialization" },
    { "ecosystem": "npm", "name": "typescript", "version": "^5.5",  "dev": true }        // no `repo` ⇒ "· all repos"
  ]
}
```

So the Dependencies card renders an `acme/web` group (zod, @acme/ui ⛁internal, vitest·dev), an `acme/api` group (serde), a `· all repos` group (typescript·dev), and a registries subsection: `internal → https://npm.internal/ · @acme · secret INTERNAL_NPM_TOKEN`.

## 8. Deliverable

Functionless React JSX skeleton(s) (one file is fine, multiple screens/states stacked or via a `state` prop) using the tokens above — the redesigned **Deploy stage body** (all eight sections, with the **Dependencies** card given real care) plus the **empty / partial / configured / multi-service** states and the **dependencies empty-vs-populated** state, and the stepper/header/footer shown lightly for context. No real logic, no data fetching — just the structure, styling, and sample data, the way the rest of `design/` is built. Bring a fresher visual hierarchy than the current implementation — that's the point of the exercise.
