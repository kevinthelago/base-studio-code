//! The `bsc plan` subcommand (#1877) — the agent-facing CLI over a project's plan.db (#plan-db). The
//! planner writes issues one at a time; workers read their queue + drive their own status; the
//! director reads the `complete` queue and marks verified/failed after checking CI. Replaces having
//! every session read/rewrite issues.json by hand.
//!
//! Extracted from the old `bsc-plan` binary so the unified `bsc` umbrella dispatches into it via
//! [`run`]; the legacy `bsc-plan` shim still calls the same entrypoint.
//!
//! The DB is located via `--db <path>` or the `BSC_PLAN_DB` env var (set per-session at launch, so
//! the CLI resolves the hub's plan.db even from a worker's worktree). Default output is human text;
//! `--json` emits machine-readable JSON.
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
nothing is written. --force skips validation.",
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
  bsc plan feature list            # list features (· = title only, ✓ = fully defined)
  bsc plan feature get <slug>      # print one feature's full spec
  bsc plan feature remove <slug>   # delete a feature",
    },
    CmdDoc {
        name: "repo",
        summary: "repos linked to the project (durable in plan.db)",
        usage: "\
USAGE:
  bsc plan repo add <owner/repo>...   # link repo(s) to the project
  bsc plan repo list                  # list the linked repos
  bsc plan repo remove <owner/repo>   # unlink a repo",
    },
    CmdDoc {
        name: "fleet",
        summary: "streams + per-stream permissions/flows + director/topology",
        usage: "\
USAGE:
  bsc plan fleet set [--force]        # replace the fleet from a FleetPlan JSON on stdin
  bsc plan fleet get [<stream-id>]    # print the fleet (lean; --full for detail), or one stream
  bsc plan fleet stream set <id>      # upsert ONE stream's JSON on stdin (granular; keeps order)
  bsc plan fleet meta set             # upsert just the meta (director/topology/…) JSON on stdin
  bsc plan fleet remove <stream-id>   # drop one stream

`fleet get` is lean by default (id/name/dependsOn per stream); add --full for permissions/flows.
Writes are validated at set-time (#2395): `set` needs a \"streams\" array (an absent one would
silently wipe the fleet) and every stream a non-empty, unique \"id\" + a \"repo\"; `stream set`'s
blob id must match <id>; `meta set` must not carry \"streams\". --force skips validation.",
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
component graph renders the app, own = the project keeps its own UI stack), uiMode (custom = the
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
        name: "request",
        summary: "worker->director change requests (the project ask lane; #4000)",
        usage: "USAGE:
  bsc plan request new \"<what you need>\" [--command \"<cmd that failed>\"] [--from <stream>]
  bsc plan request list [--status open|claimed|resolved]      # the queue, OLDEST first
  bsc plan request show <id>
  bsc plan request claim <id>                                  # director takes it (exclusive)
  bsc plan request resolve <id> --note \"<what you did>\"        # close it with the answer

For an ask a worker cannot act on itself - no integration branch to target, a kickoff pointing at a
path that does not exist. PROJECT-scoped (this plan.db), worked by the DIRECTOR; distinct from the
global `bsc request` tooling queue, which project roles are denied. Pass --command: a request carrying
the exact command that failed is actionable without a conversation.",
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
    positional: Vec<String>,
    status: Option<String>,
    stream: Option<String>,
    rule: Option<String>,
    cause: Option<String>,
    from: Option<String>,
    /// The answer stamped on `request resolve <id> --note "<what was done>"` (#4000).
    note: Option<String>,
    /// Automation fields (#2009) — `automations add <name> --command … [--schedule …] [--description …]`.
    command: Option<String>,
    schedule: Option<String>,
    description: Option<String>,
    /// `discovery integration list --direction source|runtime` (#4024) — the declared-integration filter.
    direction: Option<String>,
    /// Startup-script fields (#2010) — `startup add <repo> --mode dev|triage --path <relpath>`.
    mode: Option<String>,
    path: Option<String>,
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
}

fn parse_args(raw: Vec<String>) -> Result<Args, String> {
    let mut a = Args {
        prog: String::new(), json: false, db: None, positional: Vec::new(), status: None, stream: None,
        rule: None, cause: None, from: None, note: None, command: None, schedule: None, description: None,
        mode: None, path: None, direction: None,
        full: false, fields: None, limit: None,
        since: None, pretty: false, force: false,
    };
    let mut it = raw.into_iter();
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--json" => a.json = true,
            "--db" => a.db = Some(it.next().ok_or("--db needs a path")?),
            "--status" => a.status = Some(it.next().ok_or("--status needs a value")?),
            "--stream" => a.stream = Some(it.next().ok_or("--stream needs a value")?),
            "--rule" => a.rule = Some(it.next().ok_or("--rule needs a value")?),
            "--cause" => a.cause = Some(it.next().ok_or("--cause needs a value")?),
            "--from" => a.from = Some(it.next().ok_or("--from needs a value")?),
            "--note" => a.note = Some(it.next().ok_or("--note needs a value")?),
            "--command" => a.command = Some(it.next().ok_or("--command needs a value")?),
            "--mode" => a.mode = Some(it.next().ok_or("--mode needs a value")?),
            "--direction" => a.direction = Some(it.next().ok_or("--direction needs a value")?),
            "--path" => a.path = Some(it.next().ok_or("--path needs a value")?),
            "--schedule" => a.schedule = Some(it.next().ok_or("--schedule needs a value")?),
            "--description" => a.description = Some(it.next().ok_or("--description needs a value")?),
            "--full" => a.full = true,
            "--pretty" => a.pretty = true,
            "--force" | "--no-validate" => a.force = true,
            "--fields" => a.fields = Some(it.next().ok_or("--fields needs a comma-separated list")?),
            "--limit" => {
                let v = it.next().ok_or("--limit needs a number")?;
                a.limit = Some(v.parse().map_err(|_| format!("--limit: '{v}' is not a number"))?);
            }
            "--since" => {
                let v = it.next().ok_or("--since needs an epoch-seconds value")?;
                a.since = Some(v.parse().map_err(|_| format!("--since: '{v}' is not an integer"))?);
            }
            // `-h`/`--help` route to the help command (handled in run()).
            "-h" | "--help" => a.positional.insert(0, "help".into()),
            other if other.starts_with("--") => return Err(format!("unknown flag '{other}'")),
            _ => a.positional.push(arg),
        }
    }
    Ok(a)
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
        "get" => issues::cmd_get(&args),
        "summary" => issues::cmd_summary(&args),
        "list" | "mine" => issues::cmd_list(&args),
        // #3842: the BATCHED read — every artifact the planner poll needs in one spawn.
        "snapshot" => snapshot::cmd_snapshot(&args),
        "status" => issues::cmd_status(&args),
        "remove" => issues::cmd_remove(&args),
        "render" => issues::cmd_render(&args),
        "feature" => nouns::cmd_feature(&args),
        "repo" => nouns::cmd_repo(&args),
        "fleet" => fleet::cmd_fleet(&args),
        "deploy" => nouns::cmd_deploy(&args),
        "deps" => nouns::cmd_deps(&args),
        "market" => nouns::cmd_market(&args),
        "classify" => nouns::cmd_classify(&args),
        "transformation" => nouns::cmd_transformation(&args),
        "mcp" => nouns::cmd_mcp(&args),
        "blueprint" => nouns::cmd_blueprint(&args),
        "ui" => nouns::cmd_ui(&args),
        "discovery" => nouns::cmd_discovery(&args),
        "confirm" => nouns::cmd_confirm(&args),
        "skip" => nouns::cmd_skip(&args),
        "integration" => nouns::cmd_integration(&args),
        "lesson" => nouns::cmd_lesson(&args),
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
        println!("{}", serde_json::to_string(items).unwrap_or_else(|_| "[]".into()));
    } else if items.is_empty() {
        println!("{empty}");
    } else {
        for (i, it) in items.iter().enumerate() {
            println!("{}", line_fn(i, it));
        }
    }
}

/// Echo a just-written set of `names` (refs/slugs/repos/topics): a JSON array (when `json`) or one
/// `<verb> <name>` line each — an empty `verb` prints the bare name (the ref/slug roster echo).
fn emit_set_result<T: Serialize + std::fmt::Display>(json: bool, names: &[T], verb: &str) {
    if json {
        println!("{}", serde_json::to_string(names).unwrap_or_else(|_| "[]".into()));
    } else if verb.is_empty() {
        for n in names {
            println!("{n}");
        }
    } else {
        for n in names {
            println!("{verb} {n}");
        }
    }
}

/// Emit an optional single blob: the JSON value (`--pretty`-aware) or, when absent, `null` (JSON
/// mode) / `none_text` (human mode). The shared shape behind `deploy/deps/blueprint get`.
fn emit_blob_or_null(json: bool, pretty: bool, blob: Option<serde_json::Value>, none_text: &str) {
    match blob {
        Some(v) => print_json(&v, pretty),
        None => println!("{}", if json { "null" } else { none_text }),
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
                println!("{}", msg_fn(&v));
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
fn resolve_db(flag: &Option<String>) -> Result<PathBuf, String> {
    bsc_cli_util::resolve_store_path(flag, "BSC_PLAN_DB", || {
        Err("no plan.db: pass --db <path> or set BSC_PLAN_DB".to_string())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

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
            "add", "get", "summary", "list", "mine", "status", "remove", "render", "snapshot", "feature", "repo",
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
    fn print_blob_compactness_is_the_default() {
        // We can't capture stdout cheaply here, but the format choice is the contract: compact unless pretty.
        let v = serde_json::json!({ "a": 1, "b": [2, 3] });
        assert_eq!(serde_json::to_string(&v).unwrap(), "{\"a\":1,\"b\":[2,3]}");
        assert!(serde_json::to_string_pretty(&v).unwrap().contains('\n'));
    }
}
