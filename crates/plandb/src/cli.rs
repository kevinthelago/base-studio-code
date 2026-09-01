//! The `bsc plan` subcommand (#1877) — the agent-facing CLI over a project's plan.db (#plan-db). The
//! planner writes issues one at a time; workers read their queue + drive their own status; the
//! director reads the `complete` queue and marks verified/failed after checking CI. Replaces having
//! every session read/rewrite issues.json by hand.
//!
//! Extracted from the old `bsc-plan` binary so the unified `bsc` umbrella dispatches into it via
//! [`run`]; the legacy `bsc-plan` shim still calls the same entrypoint.
//!
//! The DB is located via `--project <key>` (its NAME), `--db <path>` (its PATH), the `BSC_PLAN_DB` env
//! var (set per-session at launch, so the CLI resolves the hub's plan.db even from a worker's
//! worktree), or — last — derived from a cwd inside `projects/<key>` or `worktrees/<key>`. Precedence
//! is exactly that order with `--db` first, since a written-out path is the most explicit thing on the
//! line. Default output is human text; `--json` emits machine-readable JSON.
//!
//! Reads are **lean by default** (#1562): plural reads (`list`/`mine`) emit a compact, body-free TSV
//! (value-lists as counts) and `--json` a compact summary array, so an embedded plan.db read is cheap
//! on the agent token budget. Escalate only when needed — `get <ref>` for one full issue, or the list
//! flags `--full` / `--fields` / `--limit` / `--since` (and `--pretty` to re-indent a JSON read).
//!
//! Help is per-command so a model loads only what it needs (#1762):
//!   bsc plan help            # compact menu (the small "what commands exist" prompt)
//!   bsc plan fleet help      # detailed help for ONE command
//!   bsc plan <cmd> help      # same, after any command
//!
//! The per-noun command handlers live in focused submodules (#1864): the issue table in [`issues`],
//! the fleet in [`fleet`], the plan.db/connector nouns in [`nouns`], and the hub-doc nouns in [`hub`].
//! This module keeps the arg-parse + dispatch + help, the DB/hub path resolution, and the shared
//! output-shape helpers (`emit_*`/`cmd_blob_noun`); the pure renderers live in [`render`].

use crate::Store;
use bsc_cli_util::CmdDoc;
use bsc_sqlite_util::{print_json, read_stdin_json_one};
use serde::Serialize;
use std::path::PathBuf;

mod render;
mod snapshot;
mod issues;
mod fleet;
mod nouns;
mod hub;
mod changes;
mod integrate;

const TAGLINE: &str = "the project plan store — issues, features, fleet, stages (#plan-db)";

/// The command catalog — drives the shared help system. One detailed `usage` block per top-level
/// command keeps the overview tiny and the detail one-fetch-away; the multi-verb nouns document their
/// subcommands in their own block. Reads are lean by default (#1562); `--json`/`--pretty` for JSON.
const COMMANDS: &[CmdDoc] = &[
    CmdDoc {
        name: "snapshot",
        summary: "EVERY artifact the planner poll needs, in ONE read (#3842)",
        usage: "USAGE:
  bsc plan snapshot --json

The BATCHED read. Emits one object keyed by artifact — issues · features · fleet · deploy · market ·
classify · transformations · automations · startup · repos · deps · mcp · confirm · skip · discovery —
from a single store open.

Exists because the planner's poll used to issue 17 separate `bsc plan <noun>` reads every 2s, each its
own process spawn at 150-660ms, which oversubscribed the command queue and stalled the user's typing
behind it (#3842; #3666 stopped ticks stacking but never shrank the per-tick fan-out).

Each key carries exactly the shape its standalone `--json` read emits, with the same absent value
(`null` for a blob noun, `[]` for a list noun), so a consumer swaps the source without touching its
coercion. Read-only. Without --json, prints a per-artifact count summary.",
    },
    CmdDoc {
        name: "add",
        summary: "upsert issue(s) from JSON on stdin; prints ref(s)",
        usage: "\
USAGE:
  bsc plan add [--force]   # one issue object, or an array, as JSON on stdin

Upserts each issue by its (required, non-empty) \"ref\" (and \"title\"). Prints the ref(s) written.
Validated at set-time (#2395): a non-empty ref + title per issue, and a known \"status\" when set
(open | in_progress | blocked | complete | verified | failed). A bad batch is rejected whole —
nothing is written. --force skips validation.

WARNING (#request-107): on an EXISTING ref this REPLACES the content fields — any field the object
omits (body, acceptance, owns, dependsOn, labels, …) is cleared, not left as-is. For a partial edit
(fix one acceptance criterion, append to a body) use `bsc plan amend <ref>` instead, which merges.
\"status\" and the gh* identity are the two fields `add` never touches on an existing ref even when
the object carries them — they're owned by `bsc plan status` / `bsc plan link`.",
    },
    CmdDoc {
        name: "amend",
        summary: "merge partial JSON onto ONE issue, preserving every other field",
        usage: "\
USAGE:
  bsc plan amend <ref>   # a JSON object of just the fields to change, on stdin

Merges the patch onto the existing issue: a field the patch does not name is left exactly as it was,
a `null` value CLEARS an optional field (mirrors `bsc graph impl set --clear`), and any other value
overwrites that one field. Array fields (acceptance/owns/dependsOn/labels) replace whole when supplied
— correcting one entry means sending the corrected array, still only ONE field of the issue.

Use this instead of `add` when changing part of an existing issue: `add` needs the WHOLE object, so a
one-field correction otherwise means reading the full record, editing it in an interpreter, and
writing it back — and a slip in that round trip can silently drop the rest of a long body.

Refuses to touch \"ref\" / \"status\" / \"ghNumber\" / \"ghNodeId\" / \"syncedAt\" — each is owned by a
different verb (`status`, `link`) or is the issue's identity; the error names which one to use.",
    },
    CmdDoc {
        name: "get",
        summary: "print one issue's FULL spec",
        usage: "\
USAGE:
  bsc plan get <ref> [--json] [--pretty]

One issue's full spec — the detail the lean `list` omits. --json is compact; --pretty re-indents.",
    },
    CmdDoc {
        name: "summary",
        summary: "plan overview: totals + per-status/stream counts",
        usage: "\
USAGE:
  bsc plan summary [--json] [--pretty]

The cheapest \"where does the plan stand\" read: totals plus per-status, per-stream counts.",
    },
    CmdDoc {
        name: "list",
        summary: "the issue table (lean by default; escalation flags)",
        usage: "\
USAGE:
  bsc plan list [--status S] [--stream S] [--full] [--fields a,b] [--limit N] [--since EPOCH] [--json|--pretty]

Lean by default (#1562): a compact TSV (counts, no body) / compact --json summary. Escalate only
when needed:
  --full              every field (TSV lines, or full --json)
  --fields a,b,...    project just these columns as TSV (body reachable here)
  --limit N           cap to N rows (plan order)
  --since EPOCH       only rows changed after EPOCH seconds (resume-delta read)
  --pretty            re-indent a --json read",
    },
    CmdDoc {
        name: "mine",
        summary: "your stream's issues (alias for list --stream)",
        usage: "\
USAGE:
  bsc plan mine --stream S [--status S] [--full|--fields a,b|--limit N|--since EPOCH] [--json|--pretty]

An alias for `list --stream S` — the same lean table + escalation flags, scoped to one stream.",
    },
    CmdDoc {
        name: "status",
        summary: "set an issue's status",
        usage: "\
USAGE:
  bsc plan status <ref> <status>

Sets one issue's status. <status> is one of: open | in_progress | blocked | complete | verified | failed.",
    },
    CmdDoc {
        name: "note",
        summary: "append an observation to an issue (no change record needed)",
        usage: "\
USAGE:
  bsc plan note <ref> <text> [--from AUTHOR]

Appends an append-only observation directly to the issue (#146) — unlike `bsc plan change note`, this
never requires a change record to already exist. Opening a change on an issue nobody has started work
on would misrepresent it as in-flight; `note` is where an observation goes before that, or when no
change will ever exist for it. `--from` names the author; omitted is recorded as empty, never guessed.",
    },
    CmdDoc {
        name: "link",
        summary: "record the GitHub issue an issue was published as",
        usage: "\
USAGE:
  bsc plan link <ref>   # {\"ghNumber\": 3898, \"ghNodeId\": \"I_x\"} as JSON on stdin

Records the GitHub identity a publish/sync established for one issue. `ghNodeId` is optional and a
known one is kept when omitted. This is the durable plan↔GitHub link: it is how a re-publish knows an
issue already exists (rather than comparing titles, which a rename defeats) and how a sync knows which
rows still need creating. A content edit via `add` never touches it.",
    },
    CmdDoc {
        name: "remove",
        summary: "delete an issue",
        usage: "\
USAGE:
  bsc plan remove <ref>

Deletes one issue by ref.",
    },
    CmdDoc {
        name: "render",
        summary: "print the issues.json projection (full, unchanged)",
        usage: "\
USAGE:
  bsc plan render

Prints the full issues.json projection to stdout (the durable shape, unchanged).",
    },
    CmdDoc {
        name: "feature",
        summary: "the features roster + detail-fill (titles-first)",
        usage: "\
USAGE:
  bsc plan feature add <name>...   # register feature title(s) — the roster (slug from name)
  bsc plan feature add             # (no names) merge details from a feature object/array on stdin
  bsc plan feature list            # list features (· = title only, ✓ = fully defined — incl. `requires`)
  bsc plan feature get <slug>      # print one feature's full spec
  bsc plan feature remove <slug>   # delete a feature",
    },
    CmdDoc {
        name: "repo",
        summary: "repos linked to the project (durable in plan.db)",
        usage: "\
USAGE:
  bsc plan repo add <name>...   # link repo(s) to the project
  bsc plan repo list            # list the linked repos
  bsc plan repo remove <name>   # unlink a repo

THE NAME'S SHAPE FOLLOWS THE PROJECT. `owner/repo` for a project that ships to GitHub — that is the
identity publish and clone both address it by. A project classified `usesGithub: false` ships nowhere,
so a bare local name (`api`, `web`) is the right link and always was: an owner names an account this
project will never have, and `bsc fleet clone` materializes such a repo with `git init` rather than
going to github.com for it.

A repo must be linked before `bsc fleet clone` can materialize it, and it must be materialized before
any worker can be given a worktree — an unlinked repo is the first of the three walls between a fresh
plan and a running fleet.",
    },
    CmdDoc {
        name: "fleet",
        summary: "streams + per-stream permissions/flows + director/topology",
        usage: "\
USAGE:
  bsc plan fleet set [--force]        # replace the fleet from a FleetPlan JSON on stdin
  bsc plan fleet get [<stream-id>]    # print the fleet (lean; --full for detail), or one stream
  bsc plan fleet get --kind <k>       # filter to streams of one lifecycle kind (see below)
  bsc plan fleet stream set <id>      # upsert ONE stream's JSON on stdin (granular; keeps order)
  bsc plan fleet meta set             # upsert just the meta (director/topology/…) JSON on stdin
  bsc plan fleet model <id> <model>   # the model ONE stream launches on (--clear to unset)
  bsc plan fleet remove <stream-id>   # drop one stream

`fleet get` is lean by default (id/name/kind/dependsOn per stream); add --full for permissions/flows.
Writes are validated at set-time (#2395): `set` needs a \"streams\" array (an absent one would
silently wipe the fleet) and every stream a non-empty, unique \"id\" + a \"repo\"; `stream set`'s
blob id must match <id>; `meta set` must not carry \"streams\". --force skips validation.

Each stream carries an optional \"kind\" (#152): \"feature\" (default, a durable lane) | \"cleanup\" |
\"temporary\" (a one-shot lane meant to be REMOVED once its work lands — e.g. a stream that deletes
orphaned code and has nothing left to own once those paths are gone). Absent reads as \"feature\", so
existing streams need no backfill. `fleet get --kind cleanup` filters the streams array to that one
kind (case-insensitive) — the way a director finds every temporary/cleanup stream across a project
without reading each one's free-text name. An unrecognized --kind is rejected, not silently empty.

`fleet model` is the DIRECTOR's level of the model precedence chain, nearest-first:
    a fleet stream's own model > a team placement's (`bsc teams model`) >
    the persona's default (`bsc persona model`) > the harness's own default
Unset is the default and means Claude Code decides — nothing changes for a fleet you never touch.
A Claude tier (haiku-4.5 | sonnet-4.5 | opus-4.5) becomes `claude --model <tier>`; any other value
is passed to whatever harness the session runs, so a local (bsc-agent) worker can be pointed at an
installed model by name. The verb REFUSES an unknown stream id rather than creating one — a stream
holding only an id and a model is a stream the fleet would try to launch.",
    },
    CmdDoc {
        name: "deploy",
        summary: "the Deploy stage's structured config (one blob)",
        usage: "\
USAGE:
  bsc plan deploy set [--force]   # replace the deploy config from a DeployConfig JSON on stdin
  bsc plan deploy get             # print the deploy config (DeployConfig JSON)

`set` validates the shape before storing (#2395) — a malformed config is rejected with a
field-level error and the stored config is untouched. Mode-aware target rules: mode:\"cloud\"
(or no mode) needs a known \"platform\"; mode:\"local\" needs \"localKind\" — \"application\"
(buildTargets + artifact) or \"library\" (publishRegistry + packageName). A successful set echoes
the pane's \"N of M deploy-ready\" readiness. --force stores a work-in-progress blob unvalidated.",
    },
    CmdDoc {
        name: "deps",
        summary: "the locked dependency manifest (one blob)",
        usage: "\
USAGE:
  bsc plan deps set [--force]   # replace the manifest from a DependencyManifest JSON on stdin
  bsc plan deps get             # print the manifest (a `dependencies` array + a `registries` map)

`set` validates before storing (#2395): every dependency needs a non-empty \"name\" and an
\"ecosystem\" of \"npm\"/\"cargo\" (anything else is silently dropped by the readers); every
registry needs a \"url\". A rejected write leaves the stored manifest untouched. --force skips.",
    },
    CmdDoc {
        name: "classify",
        summary: "the project's classification: UI mode + which optional stages it needs (one blob)",
        usage: "USAGE:
  bsc plan classify set [--force]   # replace the classification from a JSON object on stdin
  bsc plan classify get             # print the stored classification

The planner's discovery output (#3783/#3784/#3806/#4115) that shapes the plan — recorded as the closing
step of Discovery (there is no separate Configure stage). Fields, all optional: uiSystem (studio = our
component graph renders the app, own = the project keeps its own UI stack), algorithmSystem (studio =
the algorithms graph supplies the computation and our host executes its vizCode, own = the project
writes its own) — the two axes are independent and both say whether our host RUNS the project's code,
uiMode (custom = the
in-app designer preview, external = the Claude-Design drop-files intake — only meaningful when
uiSystem is studio), appType, lifecycle, and the booleans
needsMarket / needsSource / needsMcp / needsSkills / needsAutomations marking which optional stages
(market / source / mcp / skills / automations) the project shows. `set` validates before storing; --force stores an unvalidated blob.",
    },
    CmdDoc {
        name: "market",
        summary: "the Market stage's scored assessment (one blob)",
        usage: "\
USAGE:
  bsc plan market set [--force]   # replace the assessment from a market-assessment JSON on stdin
  bsc plan market get             # print the stored assessment

The Market stage's structured artifact (#2430) — the `marketDefined` gate reads it. Shape:
{ \"summary\", \"scores\": { problemSeverity | problemFrequency | reachableMarket | competitiveGap |
timing | moat: { \"score\": 1-5, \"rationale\", \"sources\": [\"...\"] } }, \"sizing\"?, \"competitors\"?,
\"verdict\": { \"recommendation\": go|caution|no-go, \"rationale\" } }.
`set` validates before storing (#2395): EXACTLY the six rubric dimensions, each an integer score
1-5 with a non-empty rationale and ≥1 fetched source (citation discipline — an uncited score is
rejected). A rejected write leaves the stored assessment untouched; a successful set echoes the
\"N of 6 dimensions scored, cited\" readiness. --force stores a work-in-progress blob unvalidated.",
    },
    CmdDoc {
        name: "transformation",
        summary: "the Transformations stage's list — the modification counterpart to features (#2509)",
        usage: "\
USAGE:
  bsc plan transformation add [--force]         # upsert row(s) from JSON on stdin (one object or an
                                                # array); prints the id(s) written
  bsc plan transformation list [--json]         # the list, position-ordered (the bottom-up confirm queue)
  bsc plan transformation get <id> [--pretty]   # print one transformation (JSON)
  bsc plan transformation update <id> [--force] # replace one row from JSON on stdin; the item re-presents
  bsc plan transformation confirm <id>          # the USER's confirm (sets confirmed: true in the row)
  bsc plan transformation remove <id>           # drop one row

Each row is one transformation — verb + target + delta + invariants + blast radius:
{ \"verb\": rename|extract|split|merge|move|replace|upgrade|restyle|remove|optimize|harden,
  \"title\", \"target\": { \"description\", \"files\"? }, \"delta\", \"invariants\": [...],
  \"owns\": [...], \"dependsOn\"?, \"tier\": 0.., \"provenance\"?: { \"recipe\", \"evidence\" },
  \"kitContribution\"?, \"spec\"?, \"confirmed\"? }
Rows are keyed by \"id\" (derived from the title when omitted); `tier` is the composition tier the
bottom-up confirm queue orders by (0 = primitives … N = pages); `owns` is the blast radius. Targets
are DISCOVERED by scanning the linked repos, never invented. `spec` is the render spec the
pane previews live — REQUIRED on a gap-fill row (kitContribution: true) so the user SEES the proposed
component. Writes are validated at set-time (#2395) with field-level errors — a bad batch is rejected
whole; --force skips. HARD RULE: the USER confirms each item in the pane — the planner NEVER runs
`confirm`.",
    },
    CmdDoc {
        name: "mcp",
        summary: "catalog MCP servers scoped to the project",
        usage: "\
USAGE:
  bsc plan mcp add <name>...   # assign MCP server(s) by catalog name
  bsc plan mcp list            # list the assigned servers
  bsc plan mcp remove <name>   # unassign a server",
    },
    CmdDoc {
        name: "blueprint",
        summary: "the blueprint an authoring project is designing (one blob)",
        usage: "\
USAGE:
  bsc plan blueprint set [--force]   # replace the blueprint from a Blueprint JSON on stdin
  bsc plan blueprint get             # print the blueprint (Blueprint JSON)

`set` validates before storing (#2395): a non-empty \"id\" + \"name\" (without them the reader
silently ignores the whole blob), and every stage/section entry needs a \"key\" + \"name\". A
rejected write leaves the stored blueprint untouched. --force skips validation.",
    },
    CmdDoc {
        name: "ui",
        summary: "the app's UI pairing — the {kit, theme} the planned app ships on (one blob)",
        usage: "\
USAGE:
  bsc plan ui set [--force]   # replace the pairing from JSON on stdin
  bsc plan ui get             # print the pairing (or null)

The planned application's {kit, theme} pair (#2489), e.g.
  {\"kit\": {\"id\": \"bsc/react-ui\", \"version\": \"1.0.0\"}, \"themeId\": \"soft\"}
`kit` is the blueprint's pinned id@version into the released-kit store; `themeId` is a
`bsc ui theme list` id (absent = \"default\"). Recorded in the Test UI stage after choosing the
theme WITH the user; the generated app's palette is emitted FROM it — `bsc ui emit-css --theme
<themeId>` produces tokens.css (the semantic contract layer, read-only) + theme.css (the one
swappable palette file), resolved by id at emission time (never snapshotted). `set` validates
before storing (#2395): a present \"kit\" needs a non-empty \"id\" + \"version\", a present
\"themeId\" must be a non-empty string, and an empty pairing is rejected. --force skips.",
    },
    CmdDoc {
        name: "discovery",
        summary: "the Discovery stage's dynamic required-set",
        usage: "\
USAGE:
  bsc plan discovery require <topic>...     # mark topic(s) required for this project
  bsc plan discovery unrequire <topic>...   # drop topic(s) from the required set
  bsc plan discovery list                   # show the required topic set

  bsc plan discovery integration set        # declare integration(s) from JSON on stdin (object or array)
  bsc plan discovery integration list [--direction source|runtime]
  bsc plan discovery integration remove <id>

An INTEGRATION is an existing application or API this project integrates with, declared during the
Discovery `integrations` topic. `direction` is `source` (data migrates FROM it — this is what the
Source pane offers) or `runtime` (the built app talks to it while running); it cannot be inferred
later, so it is asked for, not guessed. Fields: id (required) · name · direction · docs · baseUrl ·
auth (the SCHEME in prose, never a secret) · purpose.
  e.g.  echo '{\"id\":\"stripe\",\"name\":\"Stripe\",\"direction\":\"runtime\",
              \"docs\":\"https://docs.stripe.com/api\",\"purpose\":\"charge cards\"}' \\
          | bsc plan discovery integration set
NOT `bsc plan integration` — that is the DEPRECATED connector-manifest alias (#1721 → `bsc data
connector`). A manifest is HOW to talk to a system; this is WHICH systems the project needs and why.

Prose lives in discovery/<topic>.md; these files gate on GENERATION (written, not confirmed).",
    },
    CmdDoc {
        name: "confirm",
        summary: "the durable stage-confirmation set (+ content fingerprints)",
        usage: "\
USAGE:
  bsc plan confirm add <stage> [<fingerprint>]   # confirm a stage (records the content fingerprint)
  bsc plan confirm remove <stage>                # unconfirm a stage (the per-stage reset)
  bsc plan confirm list [--json]                 # the confirmed set: {stage, fingerprint} rows

Durable record (#2256) of which stages the USER confirmed. The fingerprint is the stage content's
signature at confirm time; the app resets ONE stage when its content changes (fingerprint mismatch).",
    },
    CmdDoc {
        name: "skip",
        summary: "the durable skipped-stage set (optional stages the user skipped)",
        usage: "\
USAGE:
  bsc plan skip add <stage>...      # skip optional stage(s) — a deliberate user decision (#921)
  bsc plan skip remove <stage>...   # unskip stage(s)
  bsc plan skip list                # show the skipped set

Durable record (#2267) of the OPTIONAL stages the user skipped. Unlike a confirmation this is a plain
decision (not content-based), so there is no fingerprint / reset-on-change.",
    },
    CmdDoc {
        name: "integration",
        summary: "DEPRECATED (#1721) → use `bsc data connector`",
        usage: "\
USAGE:
  bsc plan integration add|list|get <id>|remove <id>

DEPRECATED (#1721): native REST connector presets are DATA-platform state — use `bsc data connector`
instead. This verb still works (same store) but prints a deprecation note to stderr.",
    },
    CmdDoc {
        name: "change",
        summary: "local change records — the PR analogue, paired 1:1 with an issue by ref",
        usage: "USAGE:
  bsc plan change new <ref> [--note TITLE] [--description BODY] [--fields REF,REF] [--from BASE] [--command SHA]
  bsc plan change note <ref> \"<text>\" [--from AUTHOR]      # append a work note (append-only)
  bsc plan change gate <ref> <gate> <result>                # record what a gate observed
  bsc plan change status <ref> draft|open|merged|abandoned [--command SHA] [--from REVIEWER]
  bsc plan change link <ref>                                # {ghNumber, ghNodeId} on stdin
  bsc plan change get|render [<ref>] | list [--status S] | remove <ref>

The change that satisfies an issue lives in git as a branch and a merge commit; this records what git
cannot — gate evidence, the reviewer's verdict as an actor distinct from the author, notes written
while the reasoning was live, and the GitHub identity once published. `--fields` is the --closes list.

`render` emits markdown serving as BOTH the PR body when connected and the CHANGELOG entry at release,
so neither is hand-maintained separately from the work. GitHub is never written to.",
    },
    CmdDoc {
        name: "integrate",
        summary: "merge <ref> into the current tree, serialized against every other integrate call on it (#185)",
        usage: "USAGE:
  bsc plan integrate <ref> [--dir <path>]
  bsc plan integrate --release [--dir <path>]

Wraps `git merge --no-ff <ref>` in the given working tree (default: the current directory) with a
named file lock (bsc_util::filelock, under ~/.base-studio-code/locks/), so a second `bsc plan
integrate` call on the SAME tree — e.g. two sessions both merging into wt-integrate — waits its turn
instead of racing the first one's git state.

A clean merge releases the lock immediately. A REAL CONFLICT (MERGE_HEAD present) leaks the lock past
this process exiting — a conflict is resolved by hand across several separate commands — and the error
names the exact `--release` command to run once resolved, which frees the tree for the next caller.
Does not touch plan.db; it lives under `bsc plan` because it is step 7 of the plan workflow.",
    },
    CmdDoc {
        name: "lesson",
        summary: "self-correction candidates (the review queue; #1362)",
        usage: "\
USAGE:
  bsc plan lesson add \"<mistake>\" --rule \"<rule>\" [--cause <c>] [--from <prov>]   # capture a candidate
  bsc plan lesson list [--status pending|confirmed|discarded]                  # list candidates (JSON)
  bsc plan lesson confirm <id> | discard <id>                                  # set the user's verdict
  bsc plan lesson remove <id>                                                  # delete a candidate

Usually captured via the `bsc-learned` helper. Candidates de-dupe on a normalized mistake|rule key.",
    },
    CmdDoc {
        name: "brief",
        summary: "hand a plan update DOWN a tier — the architect's one outbound channel (#2377)",
        usage: "USAGE:
  echo \"<what changed and why>\" | bsc plan brief <projectKey>:director [--ref <ref>]
  bsc plan brief list                                    # awaiting YOUR acknowledgement
  bsc plan brief ack <id> --note \"<what you reconciled>\"

Writes a `brief` to the coordination log addressed to <target>. This is how a requirement, or a
mid-build change of mind, reaches the tier that acts on it — the ARCHITECT's only way to talk
downward, and the planner's runtime voice into a running fleet.

DIRECTORS ONLY. An architect naming a WORKER is refused rather than re-routed: relationships between
projects are the architect's, anything inside one is the director's, and silently redirecting a
mis-addressed brief would look like it worked while crossing that line.

A BRIEF IS INFORMATION, NOT A QUESTION. Nothing answers it and nothing is waiting on a reply — the
receiver reconciles the running plan against it (update the board/issues, route new work onward with
bsc-assign) and carries on. Send another whenever the requirement moves again.

  --ref <ref>   the issue/feature this update concerns, when it names one.

The body is read from STDIN so a multi-line update needs no quoting gymnastics; an empty body is an
error rather than an empty brief.

NOT DELIVERED TO A SESSION'S SCREEN. The app pushes nothing into a session, so nothing announces a
brief — `bsc plan brief list` is where the receiver finds one, scoped to the pane it is addressed to.

ACKNOWLEDGE WHAT YOU RECONCILE. `bsc plan brief ack <id> --note \"...\"` closes it, and the note is the
only way the SENDER learns what its brief caused — briefing is otherwise fire-and-forget, a poor
property for the channel carrying authoritative plan changes. An unacked brief stays listed
indefinitely and is never expired: a director that was busy when one arrived is the one that most
needs to still see it.

The id is printed when the brief is sent, and by `list`. It is DERIVED from the row (sender,
timestamp, target), so there is no second store to fall out of step with the log.",
    },
    CmdDoc {
        name: "request",
        summary: "tier-upward change requests (the project ask lane; #4000)",
        usage: "USAGE:
  bsc plan request new \"<what you need>\" [--command \"<cmd that failed>\"] [--from <stream>]
                                        [--to director|architect] [--ref <item>]
  bsc plan request list [--status open|claimed|resolved] [--to <tier>]   # the queue, OLDEST first
  bsc plan request show <id>
  bsc plan request claim <id>                                  # the receiver takes it (exclusive)
  bsc plan request resolve <id> --note \"<what you did>\"        # close it with the answer

For an ask a worker cannot act on itself - no integration branch to target, a kickoff pointing at a
path that does not exist. PROJECT-scoped (this plan.db), worked by the tier it NAMES (--to, default director); distinct from the
global `bsc request` tooling queue, which project roles are denied. Pass --command: a request carrying
the exact command that failed is actionable without a conversation.

THE LANE GOES UP A TIER. --to defaults to `director`, which is what a request has always meant. A
DIRECTOR uses `--to architect` for what only the tier above can settle: a requirement that does not
cover the work, a re-scope, a cross-project dependency. That is the upward twin of `bsc plan brief`,
which goes DOWN and is information rather than a question.

  --to <tier>   director (default) | architect
  --ref <item>  the plan item this concerns

WHAT A TIER OWES IS ITS OPEN REQUESTS. `bsc plan request list --to architect --status open` is the
set of items handed up and not yet settled - the architect's responsibilities for this project, as a
query rather than a second ownership field beside `stream`. `list` with no --to is the whole queue.",
    },
    CmdDoc {
        name: "triage",
        summary: "per-repo triage-run markers + the since-marker issue delta (#1004)",
        usage: "\
USAGE:
  bsc plan triage record <owner/repo>                # mark a triage launch at now; prints the epoch-seconds
  bsc plan triage last <owner/repo>                  # the last triage-launch timestamp (JSON number, or null)
  bsc plan triage changed <owner/repo> --since <ts>  # issues whose status changed since <ts> (repo-scoped; JSON)

A per-repo \"last triage launch\" marker so the next triage resumes from the delta (issues changed
since T) instead of re-ingesting the whole project. Empty repo on `changed` = the whole project.",
    },
    CmdDoc {
        name: "stage",
        summary: "the project's flat prose files (goal/scope/stack/…)",
        usage: "\
USAGE:
  bsc plan stage list          # list the present prose .md files
  bsc plan stage get <name>    # print one stage doc (e.g. goal, scope, stack) verbatim
  bsc plan stage set <name>    # write a stage doc from stdin

Stage docs live beside plan.db in the hub dir. The `.md` is implied; the name is path-safe (a bare
name, no traversal).",
    },
    CmdDoc {
        name: "automations",
        summary: "assign/list/remove project automations (+ the automations.md recipe doc)",
        usage: "\
USAGE:
  bsc plan automations add <name> --command <cmd> [--schedule <cron>] [--description <text>]
                             # assign an automation (upsert by name); omit --schedule = on-demand
  bsc plan automations list  # list assigned automations (--json for the full objects)
  bsc plan automations remove <name>
                             # unassign an automation
  bsc plan automations get   # read the prose automations.md recipe doc
  bsc plan automations set   # write automations.md from stdin",
    },
    CmdDoc {
        name: "startup",
        summary: "assign/list/remove per-repo startup (dev/triage) prompt scripts",
        usage: "\
USAGE:
  bsc plan startup add <owner/repo> --mode <dev|triage> --path <relpath>
                        # assign a repo's kickoff (dev) or triage script (upsert by repo+mode)
                        # --path is relative to the project hub dir, e.g. prompts/web-kickoff.md
  bsc plan startup list # list assigned startup scripts (--json for the full objects)
  bsc plan startup remove <owner/repo> --mode <dev|triage>
                        # unassign a repo's startup script",
    },
    CmdDoc {
        name: "github-context",
        summary: "read github_context.md (app-generated; read-only)",
        usage: "\
USAGE:
  bsc plan github-context get   # read github_context.md (app-generated; read-only)",
    },
    CmdDoc {
        name: "artifact",
        summary: "planner OUTPUT artifacts — durable content in plan.db, keyed by (kind, name) (#2997)",
        usage: "\
USAGE:
  bsc plan artifact set <kind> <name>      # write an artifact's content from stdin (upsert by kind+name)
  bsc plan artifact get <kind> <name>      # print the content (--json → the Artifact JSON, or null on a miss)
  bsc plan artifact list [<kind>]          # list artifacts (all, or one kind); --json for the full objects
  bsc plan artifact remove <kind> <name>   # delete one artifact

Durable store (#2997) for planner-produced CONTENT keyed by (kind, name) — the substrate for moving
that content off flat hub files and into plan.db. `set` reads the content on stdin; a non-JSON `get`
of an absent artifact is an error, while `--json` emits `null`.",
    },
];

/// One command's detailed help — shown at the foot of an unknown-subcommand error (via
/// [`unknown_sub`]). `prog` is the display name (`"bsc plan"` from the umbrella, `"bsc-plan"` from
/// the legacy shim). The top-level help/menu is handled by [`bsc_cli_util::handle_help`].
fn cmd_help(prog: &str, name: &str) -> String {
    bsc_cli_util::help_for(prog, TAGLINE, COMMANDS, name)
}

/// The shared unknown-subcommand error: `unknown <noun> command '<other>'` followed by the noun's
/// detailed help. `noun` is the message noun (e.g. `"fleet stream"`); its FIRST word selects the
/// [`cmd_help`] block, so a multi-word noun like `fleet stream` / `fleet meta` still shows the
/// `fleet` help. Centralizes the string every noun handler used to build inline (#2068).
fn unknown_sub(args: &Args, noun: &str, other: &str) -> String {
    let cmd = noun.split_whitespace().next().unwrap_or(noun);
    format!("unknown {noun} command '{other}'\n\n{}", cmd_help(&args.prog, cmd))
}

/// Parsed global flags + leftover positional args.
struct Args {
    /// The display name threaded into help/error text (`"bsc plan"` or the legacy `"bsc-plan"`).
    prog: String,
    json: bool,
    db: Option<String>,
    /// `--project <key>` — name the project whose plan store to use, instead of its PATH.
    ///
    /// Normalized into `db` at the end of [`parse_args`], so every handler keeps reading one field and
    /// the precedence falls out: an explicit `--db` wins, then `--project`, then `$BSC_PLAN_DB`, then
    /// the cwd derivation. Kept as its own field so an error can name the flag the caller actually
    /// typed rather than a path it never wrote.
    project: Option<String>,
    positional: Vec<String>,
    status: Option<String>,
    stream: Option<String>,
    rule: Option<String>,
    cause: Option<String>,
    from: Option<String>,
    /// The answer stamped on `request resolve <id> --note "<what was done>"` (#4000).
    note: Option<String>,
    /// The optional coordination REF carried by `brief <target> --ref <ref>`
    /// (#funnel-generalize-brief-channel) — an issue/contract/file the brief is about.
    brief_ref: Option<String>,
    /// `--to <tier>` — the tier a request is addressed to (`director` | `architect`). The name is
    /// generic because the lane is: `brief` goes down a tier, `request` goes up one.
    to: Option<String>,
    /// Automation fields (#2009) — `automations add <name> --command … [--schedule …] [--description …]`.
    command: Option<String>,
    schedule: Option<String>,
    description: Option<String>,
    /// `discovery integration list --direction source|runtime` (#4024) — the declared-integration filter.
    direction: Option<String>,
    /// Startup-script fields (#2010) — `startup add <repo> --mode dev|triage --path <relpath>`.
    mode: Option<String>,
    path: Option<String>,
    /// Decision-ledger fields (#funnel-unattended-director) —
    /// `decision add "<what>" --clause <id> [--stage features|plan] [--why "<rationale>"]`.
    stage: Option<String>,
    clause: Option<String>,
    why: Option<String>,
    /// Plural reads (`list`/`mine`) escalate from the lean default to every field (#1562).
    full: bool,
    /// Explicit column projection for `list`/`mine`, e.g. `--fields ref,title,status` → TSV.
    fields: Option<String>,
    /// Cap the number of rows a plural read returns (newest in plan order).
    limit: Option<usize>,
    /// Delta read: only rows whose `updated_at > <epoch-seconds>` (resume-aware).
    since: Option<i64>,
    /// Re-expand a JSON read to indented form (the default is compact, to save agent tokens).
    pretty: bool,
    /// Skip set-time validation on a structured write (#2395) — the deliberate
    /// store-a-work-in-progress-blob escape hatch. Validation is otherwise strict-reject.
    force: bool,
    /// Unset an optional field instead of setting it (`fleet model <id> --clear`), so a stream can
    /// fall back to the next level of the precedence chain rather than being pinned forever.
    clear: bool,
    /// `fleet get --kind cleanup` (#152) — filter the streams array to one lifecycle kind, so a
    /// director can find every temporary/cleanup stream without reading each one's free-text name.
    kind: Option<String>,
    /// `integrate <ref> --dir <path>` (#185) — the working tree to merge into, when it is not the
    /// current directory (e.g. a director resolving `wt-integrate` by an absolute path).
    dir: Option<String>,
    /// `integrate --release` (#185) — free a lock a prior conflicted `integrate` call LEAKED, once
    /// the conflict is resolved by hand.
    release: bool,
}

fn parse_args(raw: Vec<String>) -> Result<Args, String> {
    let a = Args {
        prog: String::new(), json: false, db: None, project: None, positional: Vec::new(), status: None, stream: None,
        rule: None, cause: None, from: None, note: None, brief_ref: None, to: None, command: None, schedule: None, description: None,
        mode: None, path: None, direction: None, stage: None, clause: None, why: None,
        full: false, fields: None, limit: None,
        since: None, pretty: false, force: false, clear: false, kind: None,
        dir: None, release: false,
    };
    let (mut a, positional) = bsc_cli_util::args::walk(raw, a, |flag, a: &mut Args, v| {
        match flag {
            "--json" => a.json = true,
            "--db" => a.db = Some(v.value("--db needs a path")?),
            "--project" => a.project = Some(v.value("--project needs a project key")?),
            "--status" => a.status = Some(v.value("--status needs a value")?),
            "--stream" => a.stream = Some(v.value("--stream needs a value")?),
            "--rule" => a.rule = Some(v.value("--rule needs a value")?),
            "--cause" => a.cause = Some(v.value("--cause needs a value")?),
            "--from" => a.from = Some(v.value("--from needs a value")?),
            "--stage" => a.stage = Some(v.value("--stage needs a value")?),
            "--clause" => a.clause = Some(v.value("--clause needs a value")?),
            "--why" => a.why = Some(v.value("--why needs a value")?),
            "--note" => a.note = Some(v.value("--note needs a value")?),
            "--ref" => a.brief_ref = Some(v.value("--ref needs a value")?),
            "--to" => a.to = Some(v.value("--to needs a value")?),
            "--command" => a.command = Some(v.value("--command needs a value")?),
            "--mode" => a.mode = Some(v.value("--mode needs a value")?),
            "--direction" => a.direction = Some(v.value("--direction needs a value")?),
            "--path" => a.path = Some(v.value("--path needs a value")?),
            "--schedule" => a.schedule = Some(v.value("--schedule needs a value")?),
            "--description" => a.description = Some(v.value("--description needs a value")?),
            "--full" => a.full = true,
            "--pretty" => a.pretty = true,
            "--force" | "--no-validate" => a.force = true,
            // `--clear` removes an optional field rather than setting it — the counterpart every
            // `set` verb needs so a value can be UNSET, not just overwritten (`fleet model --clear`).
            "--clear" => a.clear = true,
            "--kind" => a.kind = Some(v.value("--kind needs a value")?),
            "--dir" => a.dir = Some(v.value("--dir needs a path")?),
            "--release" => a.release = true,
            "--fields" => a.fields = Some(v.value("--fields needs a comma-separated list")?),
            "--limit" => {
                let raw = v.value("--limit needs a number")?;
                a.limit = Some(raw.parse().map_err(|_| format!("--limit: '{raw}' is not a number"))?);
            }
            "--since" => {
                let raw = v.value("--since needs an epoch-seconds value")?;
                a.since = Some(raw.parse().map_err(|_| format!("--since: '{raw}' is not an integer"))?);
            }
            _ => return Ok(false),
        }
        Ok(true)
    })?;
    a.positional = positional;
    // `--project <key>` becomes the resolved path, so every handler keeps reading one field. Only when
    // `--db` was NOT given: a path the caller wrote out is the most explicit thing on the line, and it
    // wins. Doing this here rather than in `resolve_db` is what keeps the ~3 `open_store` call sites —
    // and any future one — from having to thread a second argument they do not care about.
    if a.db.is_none() {
        if let Some(key) = &a.project {
            a.db = Some(plan_db_for_key(key)?.to_string_lossy().into_owned());
        }
    }
    Ok(a)
}

/// The plan store path for a project KEY — `~/.base-studio-code/plans/<key>.db`.
///
/// WHY THIS EXISTS. `resolve_db` was `--db` → `$BSC_PLAN_DB` → the cwd derivation, and all three
/// answer "which project" with a LOCATION. That leaves the architect unable to run the two commands
/// its charter names as its whole job: it stands in its own studio directory, which is under neither
/// `projects/<key>` nor `worktrees/<key>`, so the derivation declines and no env var is exported for
/// it — `bsc plan requirement set` and `bsc plan classify set` simply failed for the one session
/// expected to write them. `bsc errors` already had `--project` for the same reason.
///
/// The key is validated, not just interpolated: it names a file under a shared directory, so a key
/// carrying a separator would reach outside `plans/`. Mirrors `sanitize_project_key`'s containment
/// role without pulling that crate in for one check.
fn plan_db_for_key(key: &str) -> Result<PathBuf, String> {
    let key = key.trim();
    if key.is_empty() {
        return Err("--project needs a project key (list them with `bsc project list`)".into());
    }
    if !key.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err(format!(
            "--project: '{key}' is not a project key — keys are [A-Za-z0-9-_] (list them with \
             `bsc project list`)"
        ));
    }
    let base = bsc_util::bsc_base_dir()
        .ok_or("--project: no home dir ($HOME / $USERPROFILE unset), so pass --db <path>")?;
    Ok(base.join("plans").join(format!("{key}.db")))
}

/// The `plan` subcommand entrypoint: `args` is everything after `bsc plan`; `prog` is the display
/// name for help/errors (`"bsc plan"` from the umbrella, `"bsc-plan"` from the legacy shim). Handles
/// help (no command / `help` / `help <cmd>` / `<cmd> help`) before any handler opens the DB.
pub fn run(args: Vec<String>, prog: &str) -> Result<(), String> {
    let mut args = parse_args(args)?;
    args.prog = prog.to_string();
    let cmd = args.positional.first().cloned().unwrap_or_default();

    // Top-level + per-command help (no command / `help` / `help <cmd>` / `<cmd> help`) — the shared
    // dispatch in bsc-cli-util, run before any handler opens the DB (help works without a plan.db).
    if bsc_cli_util::handle_help(prog, TAGLINE, COMMANDS, &args.positional) {
        return Ok(());
    }

    // Each arm is a one-line dispatch to the verb's / noun's handler (in its focused submodule); the
    // handler resolves the DB and owns its own `match sub`. Shared output shapes live in the `emit_*`
    // helpers below.
    match cmd.as_str() {
        "add" => issues::cmd_add_cmd(&args),
        "amend" => issues::cmd_amend(&args),
        "get" => issues::cmd_get(&args),
        "summary" => issues::cmd_summary(&args),
        "list" | "mine" => issues::cmd_list(&args),
        // #3842: the BATCHED read — every artifact the planner poll needs in one spawn.
        "snapshot" => snapshot::cmd_snapshot(&args),
        "status" => issues::cmd_status(&args),
        "note" => issues::cmd_note(&args),
        "link" => issues::cmd_link(&args),
        "remove" => issues::cmd_remove(&args),
        "render" => issues::cmd_render(&args),
        "feature" => nouns::cmd_feature(&args),
        "repo" => nouns::cmd_repo(&args),
        "fleet" => fleet::cmd_fleet(&args),
        "deploy" => nouns::cmd_deploy(&args),
        "deps" => nouns::cmd_deps(&args),
        "market" => nouns::cmd_market(&args),
        "requirement" => nouns::cmd_requirement(&args),
        "classify" => nouns::cmd_classify(&args),
        "transformation" => nouns::cmd_transformation(&args),
        "mcp" => nouns::cmd_mcp(&args),
        "blueprint" => nouns::cmd_blueprint(&args),
        "ui" => nouns::cmd_ui(&args),
        "discovery" => nouns::cmd_discovery(&args),
        "confirm" => nouns::cmd_confirm(&args),
        "skip" => nouns::cmd_skip(&args),
        "integration" => nouns::cmd_integration(&args),
        "change" => changes::cmd_change(&args),
        "integrate" => integrate::cmd_integrate(&args),
        "lesson" => nouns::cmd_lesson(&args),
        "decision" => nouns::cmd_decision(&args),
        "brief" => nouns::cmd_brief(&args),
        "request" => nouns::cmd_request(&args),
        "triage" => nouns::cmd_triage(&args),
        "stage" => hub::cmd_stage(&args),
        "automations" => hub::cmd_automations(&args),
        "startup" => hub::cmd_startup(&args),
        "github-context" => hub::cmd_github_context(&args),
        "artifact" => hub::cmd_artifact(&args),
        other => Err(bsc_cli_util::unknown_command(prog, TAGLINE, COMMANDS, other)),
    }
}

/// Open the project's plan.db (resolved from `--db` / `BSC_PLAN_DB`). Every DB-backed handler opens
/// it lazily so a pure error path (unknown sub, bad usage) never touches the disk.
fn open_store(db: &Option<String>) -> Result<Store, String> {
    let path = resolve_db(db)?;
    Store::open(&path).map_err(|e| format!("opening {}: {e}", path.display()))
}

/// Emit `items` as a JSON array (when `json`) or one `line_fn(index, item)` line each, with `empty`
/// shown for an empty non-JSON read. The shared shape behind every plural human/JSON `list` read.
fn emit_json_or_lines<T: Serialize>(json: bool, items: &[T], empty: &str, line_fn: impl Fn(usize, &T) -> String) {
    if json {
        bsc_cli_util::print_raw(&serde_json::to_string(items).unwrap_or_else(|_| "[]".into()));
    } else if items.is_empty() {
        bsc_cli_util::print_raw(empty);
    } else {
        bsc_cli_util::print_raw_lines(items.iter().enumerate().map(|(i, it)| line_fn(i, it)));
    }
}

/// Echo a just-written set of `names` (refs/slugs/repos/topics): a JSON array (when `json`) or one
/// `<verb> <name>` line each — an empty `verb` prints the bare name (the ref/slug roster echo).
fn emit_set_result<T: Serialize + std::fmt::Display>(json: bool, names: &[T], verb: &str) {
    if json {
        bsc_cli_util::print_raw(&serde_json::to_string(names).unwrap_or_else(|_| "[]".into()));
    } else if verb.is_empty() {
        bsc_cli_util::print_raw_lines(names.iter().map(|n| n.to_string()));
    } else {
        bsc_cli_util::print_raw_lines(names.iter().map(|n| format!("{verb} {n}")));
    }
}

/// Emit an optional single blob: the JSON value (`--pretty`-aware) or, when absent, `null` (JSON
/// mode) / `none_text` (human mode). The shared shape behind `deploy/deps/blueprint get`.
fn emit_blob_or_null(json: bool, pretty: bool, blob: Option<serde_json::Value>, none_text: &str) {
    match blob {
        Some(v) => print_json(&v, pretty),
        None => bsc_cli_util::print_raw(if json { "null" } else { none_text }),
    }
}

/// Count the elements of an array-valued field of a blob (`services`/`dependencies`/`sections`/
/// `streams`) for the human-mode `set` echo; a missing/non-array field counts as 0.
fn blob_count(v: &serde_json::Value, key: &str) -> usize {
    v.get(key).and_then(|x| x.as_array()).map(|a| a.len()).unwrap_or(0)
}

/// The validate-then-persist seam every structured write goes through (#2395): run `validate` on
/// the parsed blob (skipped by `--force`), and only call `set_fn` when it passes — so a rejected
/// write returns `Err` WITHOUT touching the store and the previously-stored good blob survives.
fn validated_set(
    v: &serde_json::Value,
    force: bool,
    validate: impl Fn(&serde_json::Value) -> Result<(), String>,
    set_fn: impl FnOnce(&serde_json::Value) -> Result<(), String>,
) -> Result<(), String> {
    if !force {
        validate(v)?;
    }
    set_fn(v)
}

/// The shared `set`/`get` handler for the singleton-blob nouns (`deploy`/`deps`/`blueprint`/`ui`). `set`
/// reads one JSON object on stdin, validates it via `validate` (#2395 — strict-reject unless
/// `--force`), replaces the blob via `set_fn`, and echoes `msg_fn(&value)` in human mode; `get`
/// emits the stored blob via `get_fn` or `null`/`none_text`. `verb` names the noun in the
/// unknown-subcommand error; `parse_noun` names the value in the stdin parse error. (`fleet` keeps
/// its own match for `get <stream-id>`/`--full`/lean — only its `set` shares this read shape.)
// One flat parameter per per-noun behavior (validate/set/get/msg) — four call sites, and a
// builder/struct would just re-spell the same four closures with more ceremony.
#[allow(clippy::too_many_arguments)]
fn cmd_blob_noun(
    args: &Args,
    verb: &str,
    parse_noun: &str,
    none_text: &str,
    validate: impl Fn(&serde_json::Value) -> Result<(), String>,
    set_fn: impl Fn(&Store, &serde_json::Value) -> Result<(), String>,
    get_fn: impl Fn(&Store) -> Result<Option<serde_json::Value>, String>,
    msg_fn: impl Fn(&serde_json::Value) -> String,
) -> Result<(), String> {
    let s = open_store(&args.db)?;
    match args.positional.get(1).map(String::as_str).unwrap_or("") {
        "set" => {
            let v: serde_json::Value = read_stdin_json_one(parse_noun)?;
            validated_set(&v, args.force, validate, |v| set_fn(&s, v))?;
            if !args.json {
                bsc_cli_util::print_raw(&msg_fn(&v));
            }
            Ok(())
        }
        "get" => {
            emit_blob_or_null(args.json, args.pretty, get_fn(&s)?, none_text);
            Ok(())
        }
        other => Err(unknown_sub(args, verb, other)),
    }
}

/// Resolve the plan.db path via the shared `--db` → `$BSC_PLAN_DB` → default precedence
/// ([`bsc_cli_util::resolve_store_path`]). There is no default location for a project's plan.db, so
/// the default is a hard error.
/// The project key a path sits inside, or `None` for a path outside every project.
///
/// Mirrors the app's `project_key_from_cwd`: an ALLOW-LIST of the two project roots — `projects/`
/// (the hub, where a director and the studio sessions run) and `worktrees/` (where every worker runs)
/// — then the first component beneath it. Not "anything under the base dir", because a session in the
/// base dir itself belongs to no project and must resolve to nothing rather than to a guess.
///
/// Pure over `(path, base)` so both roots and the negative cases are testable without a project on disk.
fn project_key_at(path: &std::path::Path, base: &std::path::Path) -> Option<String> {
    [base.join("projects"), base.join("worktrees")]
        .iter()
        .find_map(|root| path.strip_prefix(root).ok())
        .and_then(|rel| rel.components().next())
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .filter(|k| !k.is_empty())
}

/// The plan store for the project the CWD sits in — the fallback when nothing was passed or exported.
///
/// WHY THIS EXISTS. `resolve_db` was `--db` → `$BSC_PLAN_DB` → error, so the one actor standing IN the
/// project directory was the one that had to be told where the project is. Reported: a director having
/// to `export BSC_PLAN_DB=…` before `bsc plan` would run.
///
/// The env var does not always arrive. The app sets it only when `plan_db_for_cwd` resolves, so an
/// empty or recovered cwd yields none (see `an-empty-cwd-launches-the-director-permission-less-in-the-app-home`);
/// a shell opened by hand never had it; and a namespace-caged session gets neither the var nor the
/// `bsc` binary, since the cage projects the stores as `/plan` instead. A single missing export should
/// not be a wall when the answer is derivable from where the process is standing.
///
/// Deliberately LAST in the chain: `--db` and `$BSC_PLAN_DB` still win, so this can only add an answer
/// where there was an error, never override an explicit one.
fn plan_db_from_cwd() -> Option<PathBuf> {
    let base = bsc_util::bsc_base_dir()?;
    let cwd = std::env::current_dir().ok()?;
    let key = project_key_at(&cwd, &base)?;
    Some(base.join("plans").join(format!("{key}.db")))
}

/// What a caller reads when no route to a plan.db resolved.
///
/// NAMED, rather than built inline, so a test can assert its content without depending on the
/// environment. Asserting it through `resolve_db` cannot work: `resolve_store_path` returns EARLY on
/// `$BSC_PLAN_DB`, and this repo's own CLAUDE.md tells developers to export it — so on a configured
/// machine the call SUCCEEDS and there is no message to check. The test that tried was guarded with
/// `if !msg.is_empty()` and therefore asserted nothing on exactly the machines it ran on.
///
/// Still names both explicit routes: the derivation covers a session inside a project, and this is
/// what is left — a cwd that belongs to no project, where guessing would be worse. Cheapest first:
/// `--project <key>` leads because it is the one a caller can act on without knowing a path — and
/// because the session most likely to hit this error, the architect, stands outside both project
/// roots by design.
fn no_plan_db_error() -> String {
    "no plan.db: this directory is not inside a project (…/projects/<key> or \
     …/worktrees/<key>), so pass --project <key>, or --db <path>, or set BSC_PLAN_DB"
        .to_string()
}

fn resolve_db(flag: &Option<String>) -> Result<PathBuf, String> {
    bsc_cli_util::resolve_store_path(flag, "BSC_PLAN_DB", || {
        plan_db_from_cwd().ok_or_else(no_plan_db_error)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A session standing IN a project must not have to be told where the project is.
    ///
    /// Reported: a director having to `export BSC_PLAN_DB=…/plans/network-monitor.db` before
    /// `bsc plan` would run. `resolve_db` was `--db` → `$BSC_PLAN_DB` → error, and the env var does
    /// not always arrive — the app sets it only when the launch cwd resolves under a project root, a
    /// shell opened by hand never had it, and a caged session gets neither the var nor the binary.
    #[test]
    fn a_project_key_is_derived_from_either_project_root() {
        let base = std::path::Path::new("/home/u/.base-studio-code");

        // The hub — where a director runs.
        assert_eq!(
            project_key_at(std::path::Path::new("/home/u/.base-studio-code/projects/network-monitor"), base).as_deref(),
            Some("network-monitor"),
        );
        // ...and deeper inside it, since a session may `cd` into a linked repo.
        assert_eq!(
            project_key_at(std::path::Path::new("/home/u/.base-studio-code/projects/network-monitor/networkmonitor/crates/x"), base).as_deref(),
            Some("network-monitor"),
        );
        // A worktree — where every worker runs. The whole fleet shares the project's ONE store, so
        // this must resolve to the same key the hub does.
        assert_eq!(
            project_key_at(std::path::Path::new("/home/u/.base-studio-code/worktrees/network-monitor/networkmonitor--switch-cli-adapter"), base).as_deref(),
            Some("network-monitor"),
        );
    }

    /// The architect's problem, and the reason `--project` exists.
    ///
    /// Every other route answers "which project" with a LOCATION, and the architect stands in its own
    /// studio directory — under neither project root — so the derivation declines and the app exports
    /// no env var for it. `bsc plan requirement set` and `bsc plan classify set`, the two commands its
    /// charter names as its entire job, simply failed. Naming the project is the missing route.
    #[test]
    fn a_project_key_names_the_store_without_a_path() {
        let a = parse_args(vec!["--project".into(), "network-monitor".into(), "list".into()]).unwrap();
        let db = a.db.expect("--project resolved to a path");
        assert!(db.ends_with("plans/network-monitor.db") || db.ends_with("plans\\network-monitor.db"), "{db}");
        assert_eq!(a.positional, vec!["list".to_string()], "the flag is consumed, the verb survives");
    }

    /// `--db` is a path the caller wrote out — the most explicit thing on the line — so it wins over a
    /// key. Silently preferring the key would send a write to a different store than the one named.
    #[test]
    fn an_explicit_db_path_beats_a_project_key() {
        let a = parse_args(
            vec!["--db".into(), "/tmp/explicit.db".into(), "--project".into(), "network-monitor".into()],
        )
        .unwrap();
        assert_eq!(a.db.as_deref(), Some("/tmp/explicit.db"));
        assert_eq!(a.project.as_deref(), Some("network-monitor"), "and the key is still readable for errors");
    }

    /// The key names a FILE under a shared directory, so it is validated rather than interpolated. A
    /// separator would reach outside `plans/` — the containment `sanitize_project_key` provides for
    /// hub paths, applied here for the same reason.
    #[test]
    fn a_project_key_that_could_escape_the_plans_dir_is_refused() {
        for bad in ["../../etc/passwd", "a/b", "a\\b", "", "   ", "has space", "semi;colon"] {
            let err = plan_db_for_key(bad).err().unwrap_or_default();
            assert!(!err.is_empty(), "'{bad}' is refused rather than interpolated");
        }
        // …while the shapes a real key takes are accepted.
        for good in ["network-monitor", "studio-code", "a_b", "p-1741"] {
            assert!(plan_db_for_key(good).is_ok(), "'{good}' is a legal key");
        }
    }

    /// A missing value is an error rather than swallowing the next token as the key — otherwise
    /// `bsc plan --project list` would look up a project named "list" and report it empty.
    #[test]
    fn project_needs_a_value() {
        assert!(parse_args(vec!["--project".into()]).is_err());
    }

    #[test]
    fn a_path_outside_every_project_resolves_to_nothing_rather_than_a_guess() {
        let base = std::path::Path::new("/home/u/.base-studio-code");
        // An ALLOW-LIST of the two roots, not "anything under the base dir" — these siblings hold no
        // project, and answering with the first component would point `bsc plan` at a store named
        // after a directory that is not a project.
        for p in [
            "/home/u/.base-studio-code",
            "/home/u/.base-studio-code/plans",
            "/home/u/.base-studio-code/design-studio",
            "/home/u/.base-studio-code/bin",
            "/home/u/some/repo",
            "/",
        ] {
            assert_eq!(project_key_at(std::path::Path::new(p), base), None, "{p} is not in a project");
        }
        // The roots THEMSELVES name no project — there is no component beneath them.
        assert_eq!(project_key_at(&base.join("projects"), base), None);
        assert_eq!(project_key_at(&base.join("worktrees"), base), None);
    }

    #[test]
    fn an_explicit_store_still_wins_over_the_derivation() {
        // The fallback is a FALLBACK. `--db` is the most explicit thing a caller can say, and it must
        // outrank both the env var and the cwd — otherwise a director inspecting another project's
        // plan from inside its own would silently read its own.
        let flag = Some("/tmp/explicit.db".to_string());
        assert_eq!(resolve_db(&flag).unwrap(), PathBuf::from("/tmp/explicit.db"));
    }

    #[test]
    fn a_cwd_outside_a_project_names_every_explicit_route() {
        // The error is what a session reads when the derivation cannot help, so it has to say what to
        // do next — and WHY the automatic answer did not apply.
        //
        // Asserted on the MESSAGE, not through `resolve_db`. This test used to call `resolve_db(&None)`
        // and guard every assertion with `if !msg.is_empty()` — and `resolve_store_path` returns early
        // on `$BSC_PLAN_DB`, which this repo's CLAUDE.md tells developers to export. So on a configured
        // machine the call SUCCEEDED, the message was empty, and the test asserted NOTHING in exactly
        // the environment it runs in. A guard that makes a test environment-tolerant makes it
        // environment-blind; naming the message removes the dependence instead of excusing it.
        let msg = no_plan_db_error();
        assert!(msg.contains("--project"), "names the route a caller can use without a path: {msg}");
        assert!(msg.contains("--db"), "names the flag: {msg}");
        assert!(msg.contains("BSC_PLAN_DB"), "names the env var: {msg}");
        assert!(msg.contains("not inside a project"), "says why the fallback did not apply: {msg}");
    }

    #[test]
    fn with_no_flag_and_no_env_the_resolver_falls_through_to_the_derivation() {
        // The BEHAVIOUR half, made deterministic without touching process env: a name nothing sets
        // stands in for "the env var is absent". Mutating the real `BSC_PLAN_DB` would race every
        // other test in the binary — the ordering hazard `narrowed to ENV_LOCK ordering` records —
        // and `resolve_store_path` treats any unset name identically, so this proves the same thing.
        let sentinel = "BSC_PLAN_DB_UNSET_IN_TESTS_A9F3";
        assert!(std::env::var(sentinel).is_err(), "the sentinel must really be unset");
        let err = bsc_cli_util::resolve_store_path(&None, sentinel, || Err(no_plan_db_error()))
            .expect_err("with no flag and no env, the derivation decides");
        assert_eq!(err, no_plan_db_error(), "the fall-through surfaces the derivation's own error");

        // …and a flag still outranks it, so the fall-through is reached only when there is no route.
        let flag = Some("/tmp/explicit.db".to_string());
        let got = bsc_cli_util::resolve_store_path(&flag, sentinel, || Err(no_plan_db_error()))
            .expect("an explicit --db always wins");
        assert_eq!(got, PathBuf::from("/tmp/explicit.db"));
    }

    /// End-to-end through `run()` — the ONLY level that exercises `parse_args`, and therefore the only
    /// level that can catch an unregistered flag. A store-level test calls `request_resolve(id, note)`
    /// directly and passes happily while `--note` is rejected as an unknown flag at the CLI boundary;
    /// that exact bug has shipped here before (`bsc loop reap --dry-run`).
    #[test]
    fn the_request_verbs_and_their_flags_are_registered() {
        // A real file, because `run()` resolves a --db PATH — the in-memory store the unit tests use
        // is not reachable through the CLI boundary this test exists to exercise.
        let db = test_db_path("request-verbs");
        let go = |a: Vec<&str>| {
            let mut v: Vec<String> = a.into_iter().map(String::from).collect();
            v.push("--db".into());
            v.push(db.clone());
            run(v, "bsc plan")
        };

        go(vec!["request", "new", "no develop branch to target",
                "--command", "git push -u origin develop", "--from", "cli-platform"])
            .expect("`new` with --command and --from");
        go(vec!["request", "list", "--status", "open"]).expect("`list --status`");
        go(vec!["request", "show", "1"]).expect("`show <id>`");
        go(vec!["request", "claim", "1"]).expect("`claim <id>`");
        go(vec!["request", "resolve", "1", "--note", "created develop from main"])
            .expect("`resolve --note` — the flag a store-level test cannot check");

        // Exclusivity and idempotence surface as CLI errors, not silent successes: two directors must
        // never both believe they hold the same ask.
        assert!(go(vec!["request", "claim", "1"]).is_err(), "a resolved request cannot be claimed");
        assert!(go(vec!["request", "resolve", "1", "--note", "again"]).is_err(), "resolve is not repeatable");
        assert!(go(vec!["request", "show", "999"]).is_err(), "an unknown id is an error");
        assert!(go(vec!["request", "claim", "not-a-number"]).is_err(), "a non-numeric id is rejected");
        assert!(go(vec!["request", "frobnicate"]).is_err(), "an unknown sub is an error");
        let _ = std::fs::remove_file(&db);
    }

    /// #146, through `run()` — the CLI boundary, so `--from` is checked as a registered flag, not just
    /// a store parameter. Reproduces the exact failing command on request 146: an observation on an
    /// issue with no change record, which `bsc plan change note` refuses ("no change with ref").
    #[test]
    fn the_note_verb_works_on_an_issue_with_no_change_record() {
        let db = test_db_path("note-verb");
        let go = |a: Vec<&str>| {
            let mut v: Vec<String> = a.into_iter().map(String::from).collect();
            v.push("--db".into());
            v.push(db.clone());
            run(v, "bsc plan")
        };

        // Seed the issue directly (no change record — nobody has claimed this work yet).
        let s = open_store(&Some(db.clone())).unwrap();
        s.upsert(&crate::PlanIssue {
            r#ref: "4208-two-tests-fail-only-under-full-suite-load-and-pa".into(),
            title: "Two tests fail only under full-suite load".into(),
            ..Default::default()
        })
        .unwrap();

        // What request 146 actually tried and got "no change with ref" for — now succeeds directly.
        go(vec![
            "note", "4208-two-tests-fail-only-under-full-suite-load-and-pa",
            "reproduces only under cargo nextest run --workspace", "--from", "kevin",
        ])
        .expect("`note --from` — the flag a store-level test cannot check");

        let issue = s.get("4208-two-tests-fail-only-under-full-suite-load-and-pa").unwrap().unwrap();
        assert_eq!(issue.notes.len(), 1);
        assert_eq!(issue.notes[0].author, "kevin");
        assert_eq!(issue.status, "open", "recording an observation does not claim the work as started");

        // `bsc plan change note` on the same ref still refuses — this verb is deliberately separate.
        assert!(
            go(vec!["change", "note", "4208-two-tests-fail-only-under-full-suite-load-and-pa", "x"]).is_err(),
            "change note still requires an existing change record"
        );
        assert!(go(vec!["note", "nope-no-such-issue", "x"]).is_err(), "an unknown ref is an error");
        assert!(go(vec!["note", "4208-two-tests-fail-only-under-full-suite-load-and-pa", "  "]).is_err(), "empty text is rejected");
        let _ = std::fs::remove_file(&db);
    }

    /// The decision-ledger verbs + their flags, through `run()` (#funnel-unattended-director). Same
    /// reasoning as the request test above: `decision_add` passes at the store level while `--clause`
    /// is rejected as an unknown flag at the CLI boundary, and the boundary is where the director
    /// actually calls it from.
    #[test]
    fn the_decision_verbs_and_their_flags_are_registered() {
        let db = test_db_path("decision-verbs");
        let go = |a: Vec<&str>| {
            let mut v: Vec<String> = a.into_iter().map(String::from).collect();
            v.push("--db".into());
            v.push(db.clone());
            run(v, "bsc plan")
        };

        // With no requirement there is no authority, so the ledger REFUSES rather than accumulating
        // decisions nobody permitted — the "a run with no authority parks" rule, enforced in the store.
        assert!(go(vec!["decision", "add", "chose Postgres", "--clause", "a1"]).is_err(),
            "a decision cannot be recorded before any authority is granted");

        // Seal a requirement granting one clause. Through the STORE, not the CLI: `requirement set`
        // reads its JSON from stdin, which a unit test has no way to supply — and this test is about
        // the DECISION flags, not that one.
        {
            let store = crate::Store::open(std::path::Path::new(&db)).expect("store");
            store
                .requirement_set(&serde_json::json!({
                    "statement": "build it",
                    "discovery": {},
                    "authority": [{ "id": "a1", "scope": "datastore choice", "grant": "choose freely under 10k rows" }],
                }))
                .expect("requirement set");
        }

        go(vec!["decision", "authority"]).expect("`decision authority` lists the granted clauses");
        go(vec!["decision", "add", "chose Postgres over SQLite",
                "--clause", "a1", "--stage", "features", "--why", "row count passes 10k"])
            .expect("`add` with --clause/--stage/--why — the three flags a store test cannot check");
        go(vec!["decision", "list", "--stage", "features"]).expect("`list --stage`");

        // A citation that the requirement does not grant is refused at the boundary too, so the
        // director cannot write itself a permission by naming a clause that does not exist.
        assert!(go(vec!["decision", "add", "chose Mongo", "--clause", "a9"]).is_err(),
            "an ungranted clause id is refused");
        assert!(go(vec!["decision", "add", "chose Mongo"]).is_err(), "a decision must cite a clause");
        assert!(go(vec!["decision", "frobnicate"]).is_err(), "an unknown sub is an error");
        let _ = std::fs::remove_file(&db);
    }

    /// A uniquely-named scratch db under the temp dir (mirrors the `plandb-busy-{pid}` convention in
    /// `lib.rs`). Named per test as well as per process, so tests running as threads of one binary
    /// cannot share a file.
    fn test_db_path(name: &str) -> String {
        let p = std::env::temp_dir().join(format!("plandb-cli-{}-{}.db", name, std::process::id()));
        let _ = std::fs::remove_file(&p);
        p.to_string_lossy().to_string()
    }

    /// A request must carry text — the director cannot act on an empty ask.
    #[test]
    fn a_request_with_no_text_is_rejected_at_the_cli() {
        let db = test_db_path("request-empty");
        let r = run(
            vec!["request".into(), "new".into(), "--db".into(), db.clone()],
            "bsc plan",
        );
        assert!(r.is_err(), "empty text is rejected");
        let _ = std::fs::remove_file(&db);
    }

    #[test]
    fn help_overview_lists_commands_and_per_command_help_drills_in() {
        let ov = bsc_cli_util::help_overview("bsc plan", TAGLINE, COMMANDS);
        // Every top-level command appears in the compact menu.
        for c in [
            "add", "amend", "get", "summary", "list", "mine", "status", "link", "remove", "render", "snapshot", "feature", "repo",
            "fleet", "deploy", "deps", "market", "classify", "transformation", "mcp", "blueprint", "ui", "discovery",
            "confirm", "skip", "integration", "lesson", "request", "triage", "stage", "automations", "startup",
            "github-context", "artifact",
        ] {
            assert!(ov.contains(c), "overview lists {c}");
        }
        // `fleet help` shows the fleet subcommands, not the whole menu.
        let f = cmd_help("bsc plan", "fleet");
        assert!(f.contains("bsc plan fleet"));
        assert!(f.contains("stream set"));
        assert!(!f.contains("lesson"));
        // An unknown command falls back to the overview.
        assert!(cmd_help("bsc plan", "nope").contains("COMMANDS:"));
    }

    #[test]
    fn validated_set_rejects_before_persisting_and_force_bypasses() {
        // The keep-previous-value contract (#2395): a rejected write must not clobber a good blob.
        let s = Store::open_in_memory().unwrap();
        let good = serde_json::json!({ "services": [{
            "id": "web", "repo": "o/web", "platform": "vercel",
            "release": { "strategy": "rolling" }
        }]});
        validated_set(&good, false, crate::validate::validate_deploy_config, |v| {
            s.deploy_set(v).map_err(|e| e.to_string())
        })
        .unwrap();
        // The #2392 regression shape: mode:"local" + a stray workload + no localKind → rejected,
        // and the previously-stored good config survives untouched.
        let bad = serde_json::json!({ "services": [{
            "id": "eno", "repo": "o/eno", "mode": "local", "workload": "application"
        }]});
        let err = validated_set(&bad, false, crate::validate::validate_deploy_config, |v| {
            s.deploy_set(v).map_err(|e| e.to_string())
        })
        .unwrap_err();
        assert!(err.contains("localKind"), "field-level message: {err}");
        let stored = s.deploy_get().unwrap().unwrap();
        assert_eq!(stored["services"][0]["id"], serde_json::json!("web"), "good blob kept");
        // --force is the documented escape hatch: the same bad blob stores unvalidated.
        validated_set(&bad, true, crate::validate::validate_deploy_config, |v| {
            s.deploy_set(v).map_err(|e| e.to_string())
        })
        .unwrap();
        assert_eq!(s.deploy_get().unwrap().unwrap()["services"][0]["id"], serde_json::json!("eno"));
    }

    #[test]
    fn market_validated_set_rejects_before_persisting_and_force_bypasses() {
        // The same keep-previous-value contract (#2395) through the market seam (#2430).
        let s = Store::open_in_memory().unwrap();
        let cell = || serde_json::json!({ "score": 3, "rationale": "cited", "sources": ["https://x.example"] });
        let good = serde_json::json!({
            "summary": "good",
            "scores": {
                "problemSeverity": cell(), "problemFrequency": cell(), "reachableMarket": cell(),
                "competitiveGap": cell(), "timing": cell(), "moat": cell()
            },
            "verdict": { "recommendation": "go", "rationale": "gap is real" }
        });
        validated_set(&good, false, crate::validate::validate_market_config, |v| {
            s.market_set(v).map_err(|e| e.to_string())
        })
        .unwrap();
        // An uncited partial rubric is rejected with a field-level message; the good blob survives.
        let bad = serde_json::json!({
            "summary": "bad",
            "scores": { "timing": { "score": 9, "rationale": "", "sources": [] } },
            "verdict": { "recommendation": "maybe" }
        });
        let err = validated_set(&bad, false, crate::validate::validate_market_config, |v| {
            s.market_set(v).map_err(|e| e.to_string())
        })
        .unwrap_err();
        assert!(err.contains("scores.timing.score") && err.contains("verdict.recommendation"), "field-level: {err}");
        assert_eq!(s.market_get().unwrap().unwrap()["summary"], serde_json::json!("good"), "good blob kept");
        // --force stores the work-in-progress blob unvalidated.
        validated_set(&bad, true, crate::validate::validate_market_config, |v| {
            s.market_set(v).map_err(|e| e.to_string())
        })
        .unwrap();
        assert_eq!(s.market_get().unwrap().unwrap()["summary"], serde_json::json!("bad"));
    }

    #[test]
    fn parse_args_reads_force_and_no_validate() {
        let a = parse_args(vec!["deploy".into(), "set".into(), "--force".into()]).unwrap();
        assert!(a.force);
        let b = parse_args(vec!["deps".into(), "set".into(), "--no-validate".into()]).unwrap();
        assert!(b.force);
        let c = parse_args(vec!["deploy".into(), "set".into()]).unwrap();
        assert!(!c.force);
    }

    #[test]
    fn parse_args_reads_kind() {
        // #152: `fleet get --kind cleanup` — the flag is generic on Args (parsed once, read by the
        // `fleet` noun handler), so this only pins the parse, not the filter behavior.
        let a = parse_args(vec!["fleet".into(), "get".into(), "--kind".into(), "cleanup".into()]).unwrap();
        assert_eq!(a.kind.as_deref(), Some("cleanup"));
        let b = parse_args(vec!["fleet".into(), "get".into()]).unwrap();
        assert!(b.kind.is_none());
    }

    #[test]
    fn print_blob_compactness_is_the_default() {
        // We can't capture stdout cheaply here, but the format choice is the contract: compact unless pretty.
        let v = serde_json::json!({ "a": 1, "b": [2, 3] });
        assert_eq!(serde_json::to_string(&v).unwrap(), "{\"a\":1,\"b\":[2,3]}");
        assert!(serde_json::to_string_pretty(&v).unwrap().contains('\n'));
    }

    // ── output must be CAPTURE-SAFE (#project-scoped-reads-spawn-a-process-because-the-db-path-rides-the-environment)
    //
    // `bsc serve` answers over a line-delimited JSON stream on stdout and runs each verb under
    // `bsc_util::capture_output`, so a verb's output lands in its response instead of the stream. That
    // works only for output flowing through the shared print helpers — a raw `println!` writes past the
    // capture sink and straight into the protocol, corrupting every later reply on that child.
    //
    // `is_servable_warm`'s own doc says it: "adding a verb without reading its crate is the one mistake
    // that breaks the warm child for every later request on it". This crate had EIGHT raw `println!`
    // sites, all reachable from `plan list` — the highest-volume spawn in the app at 675 calls / 342.8s
    // in one measured session. These pin the property so `plan list` CAN be served warm, and so a later
    // edit cannot quietly put the landmine back.

    #[test]
    fn the_list_emitter_is_captured_in_every_branch() {
        let items = vec!["alpha".to_string(), "beta".to_string()];

        let ((), out) = bsc_util::capture_output(|| emit_json_or_lines(true, &items, "(none)", |_, s| s.clone()));
        assert_eq!(out, "[\"alpha\",\"beta\"]\n", "the JSON branch must be captured verbatim");

        let ((), out) =
            bsc_util::capture_output(|| emit_json_or_lines(false, &items, "(none)", |i, s| format!("{i}\t{s}")));
        assert_eq!(out, "0\talpha\n1\tbeta\n", "the line branch must be captured, one LF-terminated line each");

        let empty: Vec<String> = Vec::new();
        let ((), out) =
            bsc_util::capture_output(|| emit_json_or_lines(false, &empty, "(none)", |_, s: &String| s.clone()));
        assert_eq!(out, "(none)\n", "the empty branch must be captured too");
    }

    #[test]
    fn the_set_echo_emitter_is_captured() {
        let names = vec!["one".to_string(), "two".to_string()];

        let ((), out) = bsc_util::capture_output(|| emit_set_result(false, &names, ""));
        assert_eq!(out, "one\ntwo\n");

        let ((), out) = bsc_util::capture_output(|| emit_set_result(false, &names, "added"));
        assert_eq!(out, "added one\nadded two\n");

        let ((), out) = bsc_util::capture_output(|| emit_set_result(true, &names, "added"));
        assert_eq!(out, "[\"one\",\"two\"]\n");
    }

    /// A raw `println!` leaves the captured string EMPTY while the bytes go to the real handle — the
    /// failure is invisible unless asserted, which is why this asserts it directly.
    #[test]
    fn no_emitter_leaves_the_capture_empty() {
        let items = vec![1u32, 2, 3];
        let ((), out) = bsc_util::capture_output(|| emit_json_or_lines(false, &items, "(none)", |_, n| n.to_string()));
        assert!(!out.is_empty(), "output escaped the capture sink — a raw println! is back");
        assert!(out.ends_with('\n'), "each emitted line must be LF-terminated: {out:?}");
    }
}

