# Kickoff — build `plan-grader-mcp-server`

> Paste this whole file as the opening prompt for a fresh Claude Code session in an **empty
> directory**. It is self-contained: you do **not** need the `base-studio-code` repo to build
> this. When you're done you'll have a first-party MCP server, ready to push to
> `github.com/kevinthelago/plan-grader-mcp-server`.

---

## Mission

Build **`plan-grader-mcp-server`** — a stdio [Model Context Protocol](https://modelcontextprotocol.io)
server, in **Python + [uv](https://docs.astral.sh/uv/)**, that scores an AI-development **plan's
agent-readiness** and lints plan stages for gaps. It exposes the grading/linting as MCP **tools** so
a planning/orchestration agent can call them.

This server is **first-party tooling for [base-studio-code](https://github.com/kevinthelago/base-studio-code)**,
a desktop host that runs fleets of Claude coding agents against a generated plan. A "planner" agent
produces three artifacts in a project hub directory:

- `issues.json` — the granular, agent-ready work items
- `phases.json` — the milestones the issues are grouped into
- `repos.json` — the repos the project spans

The grader scores how ready those issues are for an autonomous agent to execute without asking
follow-up questions, and the linter flags plan stages that still have empty files or unresolved
placeholders. **This logic exists today inside the host as pure TypeScript; you are porting it to a
standalone MCP server, with exact output parity** (it will replace the in-app version, so the grades
must not change).

You are building **only this server**. Do not touch or clone `base-studio-code`.

---

## Conventions to match (sibling first-party servers)

The host already ships three first-party servers; match their shape so this one drops in identically:

| | |
|---|---|
| **Repo name** | `plan-grader-mcp-server` (owner `kevinthelago`) |
| **Language / build** | Python, packaged with **uv**. The host builds it by running **`python -m uv sync`** in the clone dir — so it MUST build with exactly that. |
| **Transport** | MCP **stdio** |
| **Launch command** (host writes this into `.mcp.json`) | `python -m uv run --directory {dir} plan-grader-mcp` — so expose a **console-script entry point named `plan-grader-mcp`** that starts the stdio server. |
| **Install line** (for the README/catalog) | "Downloads to `~/.base-studio-code/mcp/plan-grader-mcp-server`, then builds with `python -m uv sync`." |

> ⚠️ Invoke uv as **`python -m uv`**, never a bare `uv` — uv's console-script shim is often not on
> PATH on a fresh machine, and the host deliberately calls it as a module. Your `pyproject.toml`
> must therefore declare `uv` such that `python -m uv sync` works from a clean checkout (uv is the
> build front-end; the package itself depends on the `mcp` SDK).

Use the official **`mcp` Python SDK** (`FastMCP`). Keep the server **pure and deterministic**: no
network, no clock-dependent output, no randomness. Same inputs → byte-identical grade.

---

## Input data model (exact)

### `PlanIssue` (each element of `issues.json`)

```jsonc
{
  "ref":        "F1",                       // string. planner-local id (NOT the GitHub number)
  "title":      "Add POST /sessions endpoint",
  "phase":      1,                          // number | string | absent. milestone (1-based # or name)
  "acceptance": ["...", "..."],             // string[]. the done-when checklist
  "owns":       ["src/api/sessions.ts"],    // string[]. files/globs this issue owns
  "dependsOn":  ["F0"],                     // string[]
  "labels":     ["scope:core"],             // string[]
  "repo":       "kevinthelago/app",         // string | absent. owner/name; absent ⇒ default repo
  "stream":     "api",                      // string | absent. owning fleet stream id
  "parent":     "F0",                       // string | absent
  "body":       "extra prose"               // string | absent
}
```

`issues.json` is a JSON **array** of these. Tolerate missing optional fields.

### `phases.json`

An array of objects each with at least a `name` string: `[{ "name": "Phase 1 — Foundations" }, …]`.
(It may carry more fields; you only need `name`, in order.)

### `repos.json`

A JSON array of repo full-names: `["kevinthelago/app", "kevinthelago/api"]`.

---

## Tools to expose

### 1. `grade_plan(plan_dir: str = ".") -> PlanGrade`

Read `issues.json`, `phases.json`, `repos.json` from `plan_dir`, compute the grade, return it as a
JSON object. **This is the primary tool.** Also accept an optional override form where the three
arrays are passed directly (`issues`, `phases`, `repos`) for callers that don't have files on disk —
your choice whether that's a second tool or optional params, but `plan_dir` reading must work.

#### The rubric (reproduce EXACTLY — parity is the acceptance bar)

**Letter from a 0..1 score:**

```
score >= 0.90 → "A"
score >= 0.75 → "B"
score >= 0.60 → "C"
score >= 0.45 → "D"
else          → "F"
```

**Per-issue grade** (weights sum to 1.0; clamp final score to [0,1]):

| Dimension | Pass test | Points | On shortfall |
|---|---|---|---|
| Acceptance | `len(acceptance) >= 2` | **+0.35** | `== 1` → **+0.18** partial credit + reason "only 1 acceptance criterion (aim for ≥2)"; `0` → reason "no acceptance criteria" |
| Ownership | `len(owns) > 0` | **+0.20** | reason "no owned files/globs declared" |
| Milestone | `phase` is present (not absent/None) | **+0.20** | reason "not assigned to a milestone/phase" |
| Stream | `stream` truthy | **+0.15** | reason "no owning stream" |
| Title | `len(title.strip()) >= 10` | **+0.10** | reason "title too short" |

Return per issue: `{ ref, score, letter, reasons: string[] }`.

**Per-milestone grade** (`gradeMilestone(name, issues)`):
- Empty milestone → `{ score: 0, letter: "F", reasons: ["no issues in this milestone"], issueGrades: [] }`.
- Else: `avg = mean(issueGrade.score)`. Apply a **granularity bonus**: `len < 2` → ×0.75 (reason "only N issue — too few; consider decomposing further"); `len > 15` → ×0.85 (reason "N issues — unusually many; consider splitting the milestone"); otherwise ×1.0. `score = min(1, avg * bonus)`. (Constants: `MIN_ISSUES = 2`, `MAX_ISSUES = 15`.)

**Per-repo grade** (`gradeRepo(repo, issues, phases)`):
- Issues with a blank/absent `repo` are attributed to the **first repo in `repos.json`** (the fallback). Filter the repo's issues.
- No issues for the repo → `{ score: 0, letter: "F", reasons: ["no issues attributed to this repo"] }`.
- Group the repo's issues by `phase`; issues with no `phase` form an **"Unscheduled"** milestone (and add reason "N unscheduled issue(s)"). When matching a phase, match either the phase **name** or its **1-based index** as a string (issues may carry either).
- Grade each resulting milestone. Repo score = milestone scores **weighted by issue count**: `Σ(mScore × mIssueCount) / Σ(mIssueCount)`, clamped to [0,1].

**Whole-plan grade** (`gradePlan(issues, phases, repos)`):
- `issues` empty → `{ score: 0, letter: "F", reasons: ["no issues defined"], repoGrades: [], categories: [], suggestions: [] }`.
- `repos` empty → same shape with reason `"no repos linked"`.
- Normalise: blank `repo` → fallback (first repo). Compute a `repoGrade` per listed repo.
- If any issue references a repo **not** in `repos.json`, add reason "N issue(s) reference an unlinked repo".
- Plan score = repo scores **weighted by issue count** (same formula as repo rollup), clamped to [0,1].
- Then build **categories** and **suggestions** (below).

Return:
```jsonc
{ "score": 0.0..1.0, "letter": "A".."F", "reasons": string[],
  "repoGrades": RepoGrade[], "categories": CategoryGrade[], "suggestions": Suggestion[] }
```

#### Category breakdown (the renderable report)

Roll **each rubric dimension** up across all issues into a `CategoryGrade`:
`{ id, label, score, letter, weight, detail, examples }` where `score = (# issues that pass) / (# issues)`,
`detail = "{passed}/{n} issues {good-phrase}"`, and `examples` = up to **4** failing issue refs.

The five dimensions (id · label · weight · pass-test · good-phrase · fix-phrase · why):

```
acceptance  · "Acceptance criteria"     · 0.35 · len(acceptance) >= 2     ·
  good: "define ≥2 acceptance criteria"  · fix: "add ≥2 acceptance criteria"
  why:  "Acceptance criteria are the done-when contract — without them an agent can't tell when it's finished."

ownership   · "File ownership"          · 0.20 · len(owns) > 0           ·
  good: "declare owned files/globs"      · fix: "declare the files or globs they own"
  why:  "Owned globs are the boundary the agent works within, so parallel streams don't collide."

milestones  · "Milestone assignment"    · 0.20 · phase is present       ·
  good: "are assigned to a milestone"    · fix: "assign a milestone/phase"
  why:  "An unscheduled issue lands nowhere on the roadmap and never publishes under a milestone."

streams     · "Stream ownership"        · 0.15 · stream truthy          ·
  good: "name an owning stream"          · fix: "name an owning stream"
  why:  "Without an owning stream there's coordination ambiguity over which agent picks it up."

titles      · "Title clarity"           · 0.10 · len(title.strip()) >= 10 ·
  good: "have a descriptive title"       · fix: "give a descriptive (≥10 char) title"
  why:  "A one-word title is too vague for an agent to act on without re-reading the whole issue."
```

Plus a **sixth, milestone-shaped** category (weight **0**):
```
granularity · "Milestone granularity" · weight 0
  score   = (# milestones sized 2..15 issues) / (# milestones with ≥1 issue)   (0 if none)
  detail  = "{wellSized}/{total} milestones sized 2–15 issues"  (or "no milestones resolved")
  examples= up to 4 off-size milestones as "{name} (N)"
```
(Milestones come from the repoGrades' milestone lists, counting only those with ≥1 issue.)

#### Suggestions

For every category scoring **below 100%** (< 0.999), emit one `Suggestion`
`{ priority, category, title, detail }`:

- `shortfall = 1 - score`; `impact = (weight or 0.10) * shortfall`.
- `priority`: `impact >= 0.12` → **high**; `>= 0.05` → **medium**; else **low**.
- For the `granularity` category: title `"Re-scope K milestone(s) toward 2–15 issues"` (K = #examples),
  detail `"Milestones outside that range read as under- or over-scoped."` + ` (e.g. <examples>)` when any.
- For the five rubric dimensions: `K = round(shortfall * issueCount)`,
  title `"K issue(s): {fix-phrase}"`, detail `"{why}"` + ` (e.g. <examples>)` when any.
- **Sort** high → medium → low.

> Tip: the cleanest port keeps a pure module (`grade.py`) holding all of the above, with no MCP/IO,
> exactly mirroring the structure above — so it's trivially unit-testable for parity.

### 2. `grade_issue(issue: dict) -> IssueGrade`

Grade a single issue with the per-issue rubric above. Returns `{ ref, score, letter, reasons }`.

### 3. `lint_plan(files: dict[str, str]) -> { gaps: string[], blocked: bool }`

Scan a map of `filename → contents` for gaps. For each file: if `content.strip()` is empty →
gap `"{file}: empty"`; else if it contains an **unresolved placeholder** → gap
`"{file}: unresolved placeholder"`. `blocked = len(gaps) > 0`.

Placeholder test (case-insensitive), matching the host exactly:

```
\b(TODO|TBD|FIXME|XXX|TKTK|placeholder)\b   OR   literal "..."(not followed by a 4th dot)   OR   the "…" ellipsis char
```
Python: `re.search(r"\b(TODO|TBD|FIXME|XXX|TKTK|placeholder)\b|\.\.\.(?!\.)|…", text, re.IGNORECASE)`.

Optionally also offer `lint_stage(plan_dir, files=[...])` that reads named files from disk and calls
the same logic — but the dict form above is the canonical one.

---

## Deliverables (definition of done)

- [ ] `pyproject.toml` — package `plan-grader-mcp-server`, console-script `plan-grader-mcp = "plan_grader.server:main"`, dep on the `mcp` SDK, **builds clean with `python -m uv sync`**.
- [ ] `src/plan_grader/grade.py` — the pure rubric port (no IO/MCP). Functions: `grade_issue`, `grade_milestone`, `grade_repo`, `grade_plan`, `find_plan_gaps`, plus `letter_from_score`. JSON-serializable dataclasses/dicts.
- [ ] `src/plan_grader/server.py` — `FastMCP("plan-grader")` exposing `grade_plan`, `grade_issue`, `lint_plan`; `main()` runs the stdio server.
- [ ] `tests/` (pytest) — **parity fixtures**: at minimum (a) a strong plan that grades **A**, (b) a plan with thin/unscheduled/streamless issues that grades **C/D** and yields the expected suggestions in priority order, (c) empty-issues and empty-repos edge cases (both **F** with the exact reason strings), (d) lint cases for empty + each placeholder marker. Assert exact `score`/`letter`/`reasons`/category `detail`/suggestion ordering.
- [ ] `README.md` — what it is, the tool list, and the install line above; document running locally (`python -m uv run plan-grader-mcp`).
- [ ] Server **starts over stdio** and responds to `tools/list` with the three tools.
- [ ] `python -m uv run pytest` is green.

## Acceptance criteria

1. `python -m uv sync` then `python -m uv run plan-grader-mcp` launches a working stdio MCP server.
2. `grade_plan` over a `plan_dir` returns a `PlanGrade` whose `score`, `letter`, `reasons`,
   `categories[*].detail`, and `suggestions` ordering match the rubric above **exactly**.
3. `lint_plan` flags empty files and every placeholder marker; `blocked` reflects any gap.
4. All tests pass; no network or nondeterminism anywhere in the grade path.

---

## After this server exists (NOT this session — context for base-studio-code)

Back in `base-studio-code` we will: (a) add a **catalog entry** "Plan Grader" pointing at this repo
(mirroring Compliance: `command: "python", args: "-m uv run --directory {dir} plan-grader-mcp"`);
(b) **Phase 4 of #897** — delete the in-app pipeline runtime (`gradePlan.ts`, `lintPlan.ts`,
`renderPreview.ts`, `pipelineRuntime.ts`) and the blueprint `pipelines` field, now that grading lives
here; (c) **Phase 6** — rename the (separate) fleet conductor off the "pipeline" name. None of that
happens in this session.
