//! `bsc session` (#architect-starts-and-stops-system-sessions) — start · stop · list the app-owned
//! SYSTEM SESSIONS.
//!
//! ## Why this verb exists
//! The architect is the funnel's first tier: it ingests the user's raw prose and hands work down. Epic
//! `architect-orchestrates-the-system-sessions` gives it the power to bring up the sessions that produce
//! the material a build runs on — the designer's kits, the librarian's algorithms, the integrator's
//! connectors — instead of only being able to describe them.
//!
//! ## Why the id is an ENUM and not a string
//! That grant widens the app's highest prompt-injection surface: the architect is `none` on git, github,
//! code, net and ui *because* it reads untrusted prose, and being the least capable session was the
//! mitigation. The replacement mitigation is one property — **the architect can only cause what a user
//! clicking in the app can already cause** — and this module is where its first clause lives:
//!
//! > Every argument is an id from a registry the app owns. No verb takes a command, a path, or prose
//! > that becomes execution.
//!
//! So [`SYSTEM_SESSIONS`] is a fixed table, [`resolve`] refuses anything outside it, and the refusal
//! names the valid set. Injected prose can at worst start a legitimate system session — a cheap,
//! reversible, visible act.
//!
//! ## Why stop cannot reach a director
//! Not by a check that could be forgotten: a director pane id is simply **not expressible** in this
//! verb's argument space. `stop` takes a system-session id, and `studio-code:director` is not one. The
//! epic settles the asymmetry — stopping a studio is cheap and reversible (a stable pane id means a
//! later start resumes the same conversation), while stopping a director ends coordination of a running
//! fleet whose workers have no route back except the user's click.
//!
//! ## Two routing kinds, on the `bsc fleet` precedent
//! [`KIND`] is answered in pure Rust (liveness lives in `PtyState`, exactly as `bsc fleet list` reads
//! it). [`LIFECYCLE_KIND`] is an emit-and-ack round trip, because bringing a studio up is a frontend
//! store action (`openStudio` → `StudioSessionHosts` mounts its `TerminalSlot`) that Rust cannot
//! perform.

use serde::{Deserialize, Serialize};


/// The READ verb's routing key — answered in Rust.
pub const KIND: &str = "session";

/// The START/STOP routing key. A different request shape AND a different path through the app
/// (frontend emit + ack), so it rides its own key the way `fleet-wake` does next to `fleet`.
pub const LIFECYCLE_KIND: &str = "session-lifecycle";

/// The DELIVER routing key (#an-ask-is-delivered-not-left-to-be-found).
///
/// Its own key rather than a flag on [`LIFECYCLE_KIND`] because it is a different question: lifecycle
/// asks "be running / stop running", delivery asks "take this request", and the answer names which of
/// three routes was taken. It can END in a lifecycle start (a stopped target is woken WITH the
/// request), which is exactly why it is the caller of that rather than a variant of it.
pub const DELIVER_KIND: &str = "session-deliver";

/// Ask the app to put `text` in front of a system session, whatever state it is in.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeliverRequest {
    /// A system-session id, re-resolved against [`SYSTEM_SESSIONS`] by the app — the same closed-set
    /// boundary every other verb here crosses.
    pub id: String,
    /// The request to put in front of it.
    pub text: String,
    /// Cut into work already in progress. Without it a working session is LEFT ALONE and the caller is
    /// told so; this is the maintainer's "ability to completely interrupt a session with a prompt".
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub interrupt: bool,
}

/// What the delivery did — never silent, because a request that vanished is the failure the whole
/// item exists to end.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeliverResult {
    pub session_id: String,
    pub pane_id: String,
    pub action: deliver::Action,
    /// Human-readable, and the line the CLI prints.
    pub detail: String,
}

/// One app-owned system session: the id the CLI takes, the fixed pane id its session runs on, and what
/// it is for (printed by `list`, and in the refusal — a caller that named the wrong one should be able
/// to pick the right one without a second command).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SystemSession {
    pub id: &'static str,
    pub pane_id: &'static str,
    pub summary: &'static str,
    /// Whether `stop` may name it. False for the ARCHITECT alone — see [`resolve_stoppable`].
    pub stoppable: bool,
}

/// **The closed set**, one entry per app-owned session — and since
/// #system-sessions-are-per-technology that is one per TECHNOLOGY for the two studios whose store is
/// partitioned (the librarian by `impl.tech`, the designer by `kit.tech`). A per-tech pane id takes a
/// HYPHEN, never a second colon: the pane grammar is `<key>:<tail>` and the key is read as
/// `paneId.split(":")[0]` in several places.
///
/// Mirrors `STUDIO_SESSIONS` in
/// `src/features/studio-sessions/lib/studioSessions.ts`; the ids and pane ids are the same strings on
/// both sides, and `systemSessionRegistry.test.ts` fails when they drift. Two authorities is one more
/// than ideal, but the alternative — Rust reading a TS module at runtime — trades a compile-time table
/// for a parse that can fail in the field, and a silently-diverged registry shows up as a *valid* id
/// being refused, which the drift test catches at gate time instead.
pub const SYSTEM_SESSIONS: &[SystemSession] = &[
    SystemSession {
        id: "designerReact",
        pane_id: "design-studio:designer-react",
        summary: "the Design Studio for REACT kits — components, pages and animations via `bsc ui`",
        stoppable: true,
    },
    SystemSession {
        id: "designerReactNative",
        pane_id: "design-studio:designer-react-native",
        summary: "the Design Studio for REACT-NATIVE kits",
        stoppable: true,
    },
    SystemSession {
        id: "librarianRust",
        pane_id: "algorithms-studio:librarian-rust",
        summary: "the Algorithms Studio for RUST — `bsc graph impl list --tech rust`",
        stoppable: true,
    },
    SystemSession {
        id: "librarianTypescript",
        pane_id: "algorithms-studio:librarian-typescript",
        summary: "the Algorithms Studio for TYPESCRIPT",
        stoppable: true,
    },
    SystemSession {
        id: "librarianPython",
        pane_id: "algorithms-studio:librarian-python",
        summary: "the Algorithms Studio for PYTHON",
        stoppable: true,
    },
    SystemSession {
        id: "architect",
        pane_id: "teams-studio:architect",
        summary: "the Teams Studio — personas and team graphs via `bsc teams` / `bsc persona`",
        stoppable: false,
    },
    SystemSession {
        id: "soundDesigner",
        pane_id: "sound-studio:sound-designer",
        summary: "the Sound Studio — synthesis descriptors via `bsc sound`",
        stoppable: true,
    },
    SystemSession {
        id: "integrator",
        pane_id: "integration-studio:integrator",
        summary: "the Integration Studio — connector manifests via `bsc data connector`",
        stoppable: true,
    },
];

/// Every valid id, for a refusal message.
pub fn valid_ids() -> Vec<&'static str> {
    SYSTEM_SESSIONS.iter().map(|s| s.id).collect()
}

/// The pane-id prefix every NETWORK's architect shares. A network is a domain that owns a set of
/// projects and exactly one architect session; its store id is already `network-<slug>`, so the pane
/// key IS the network id and the two cannot drift.
pub const NETWORK_PREFIX: &str = "network-";
/// The tail every network's architect pane carries. One colon, per the pane grammar: the key is read as
/// `pane_id.split(':')[0]`, so a per-network id takes a HYPHEN in the key and never a second colon.
pub const NETWORK_ARCHITECT_TAIL: &str = ":architect";
/// The tail every network's STEWARD pane carries (`a-steward-can-actually-be-started`).
///
/// A network holds up to two root sessions and they are different jobs: the ARCHITECT plans what the
/// network will build next, the STEWARD operates what it has already built. Both may run at once, so
/// this is a second tail rather than a mode on the first.
pub const NETWORK_STEWARD_TAIL: &str = ":steward";

/// A session the WRITE half may name, resolved — and OWNED, because not every one is a compile-time
/// registry row any more.
///
/// `resolve` used to hand back `&'static SystemSession`, which silently required every nameable session
/// to exist at compile time. A network's architect is minted when the user creates the network, so it
/// cannot be a `'static` row and the return type had to stop insisting it was.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedSession {
    pub id: String,
    pub pane_id: String,
    pub summary: String,
    pub stoppable: bool,
}

/// The network slug in `network-<slug>:architect`, or `None` when `id` is not one.
///
/// This is a GRAMMAR, not a lookup, and that is the whole safety argument. The closed registry made
/// `bsc session` safe to grant by ensuring every argument was an id the app owned; a grammar keeps that
/// property — `network-kitchen:architect` is a name the app defines — without requiring this crate to
/// depend on the network store to find out which slugs exist. Whether that network is real is answered
/// by whether a pane is live, which is the same question `stop` already asks.
///
/// The slug is validated rather than accepted: it becomes a pane key and a directory name, so a
/// separator or a space would reach somewhere it should not.
pub fn network_architect_slug(id: &str) -> Option<&str> {
    network_slug_with_tail(id, NETWORK_ARCHITECT_TAIL)
}

/// The network slug in `network-<slug>:steward`, or `None` when `id` is not one.
///
/// The steward's half of the same grammar — see [`network_architect_slug`] for why this is a grammar
/// and not a lookup. Sharing [`network_slug_with_tail`] rather than copying the parse is deliberate:
/// the VALIDATION is the safety property (a slug becomes a pane key and a directory name), and two
/// copies of a validation is how one of them ends up weaker than the other.
pub fn network_steward_slug(id: &str) -> Option<&str> {
    network_slug_with_tail(id, NETWORK_STEWARD_TAIL)
}

/// The shared parse behind both network-session grammars.
fn network_slug_with_tail<'a>(id: &'a str, tail: &str) -> Option<&'a str> {
    let rest = id.strip_prefix(NETWORK_PREFIX)?;
    let slug = rest.strip_suffix(tail)?;
    // VALIDATED, not accepted: this becomes a pane key and a directory name, so a separator or a space
    // would reach somewhere it should not.
    if slug.is_empty() || !slug.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-') {
        return None;
    }
    Some(slug)
}

/// The pane-id prefix every SURFACE session shares (`a-noun-and-its-verbs-launch-their-personas`):
/// the OPERATOR that drives one `bsc <noun>` and the MAINTAINER that owns one of its verbs.
pub const SURFACE_STUDIO_PREFIX: &str = "surface-studio:";

/// Which surface persona a `surface-studio:` pane names, paired with the tail that identifies it —
/// or `None` when `id` is not one.
///
/// A GRAMMAR, for the same reason [`network_architect_slug`] is one: the pane id is DERIVED from a
/// graph node, so this crate cannot enumerate the set without depending on the crate drill, and the
/// safety property that matters is that the name is one the app defines rather than one the caller
/// invented. The tail is validated, not accepted — it becomes a pane key, so a separator or a space
/// would reach somewhere it should not.
///
/// # Why this is the channel the operator uses
///
/// Its two alternatives do not reach a maintainer at all. `bsc request new` files onto the GLOBAL
/// tooling queue, which a DEBUG session works on a stronger model — the right lane for a gap in the
/// `bsc` surface itself, and the wrong one for "this verb costs too much". And `bsc-ask` is a coord
/// emitter that carries no addressee: it tags the ASKER's pane and broadcasts into `coord.log`, which
/// only a project's director pump reads, and a surface session belongs to no fleet. So the operator's
/// finding either went to the debugger or went nowhere. `ask` is delivered, and `reply` routes the
/// answer back, which is what makes noun -> verb an exchange rather than a hand-off into a log.
pub fn surface_session_kind(id: &str) -> Option<(&'static str, &str)> {
    let rest = id.strip_prefix(SURFACE_STUDIO_PREFIX)?;
    let (kind, tail) = match () {
        _ if rest.starts_with("noun-") => ("operator", &rest["noun-".len()..]),
        _ if rest.starts_with("verb-") => ("maintainer", &rest["verb-".len()..]),
        _ => return None,
    };
    if tail.is_empty()
        || !tail.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
    {
        return None;
    }
    Some((kind, tail))
}

/// Resolve an id to a session the write half may name.
///
/// **This is the injection boundary.** Everything downstream — the pane id, the emit, the store action —
/// works from the returned [`ResolvedSession`], never from the caller's string, so no argument reaches
/// the app as text. The error names the valid set rather than saying "unknown": a caller that guessed
/// `sound-designer` for `soundDesigner` should be corrected, not left to guess again.
///
/// Two spaces resolve, and they are different KINDS of thing rather than one list with an exception:
/// the fixed registry of app-owned studios, and the per-network architects, whose ids the app defines
/// by grammar because the user mints them at runtime.
pub fn resolve(id: &str) -> Result<ResolvedSession, String> {
    if let Some(row) = SYSTEM_SESSIONS.iter().find(|s| s.id == id) {
        return Ok(ResolvedSession {
            id: row.id.to_string(),
            pane_id: row.pane_id.to_string(),
            summary: row.summary.to_string(),
            stoppable: row.stoppable,
        });
    }
    if let Some(slug) = network_architect_slug(id) {
        // id == pane_id here, deliberately: the network's own store id is the pane key, so there is no
        // second short name to keep in step, and the thing a user types is the thing the app runs.
        return Ok(ResolvedSession {
            id: id.to_string(),
            pane_id: id.to_string(),
            summary: format!(
                "the architect for the '{slug}' network — discovery for its projects, and the director \
                 each one gets"
            ),
            // STOPPABLE, unlike the Teams Studio architect. That one holds the orchestration
            // conversation this verb is called from; a network's architect is an ordinary session the
            // user created, and a network deleted while its architect runs must not strand it.
            stoppable: true,
        });
    }
    if let Some(slug) = network_steward_slug(id) {
        // id == pane_id, exactly as the architect above: the network's store id IS the pane key, so
        // there is no second short name to keep in step.
        return Ok(ResolvedSession {
            id: id.to_string(),
            pane_id: id.to_string(),
            summary: format!(
                "the steward for the '{slug}' network — it USES what the network has already built, \
                 read-only unless you say otherwise"
            ),
            // Stoppable for the architect's reason: a network deleted while its steward runs must not
            // strand the session.
            stoppable: true,
        });
    }
    if let Some((kind, tail)) = surface_session_kind(id) {
        // id == pane_id, as with a network's architect: the pane id IS the name, derived from the
        // graph node, so there is no second short name to keep in step.
        return Ok(ResolvedSession {
            id: id.to_string(),
            pane_id: id.to_string(),
            summary: match kind {
                "operator" => format!("the operator driving `bsc {tail}` — it reports what the noun COSTS"),
                _ => format!("the maintainer of `bsc {tail}` — it owns that verb's code"),
            },
            // STOPPABLE. A surface session is one the user opened from a node, not an orchestration
            // conversation this verb is called from, so ending it strands nothing.
            stoppable: true,
        });
    }
    Err(resolve_error(id))
}

fn resolve_error(id: &str) -> String {
    format!(
        "'{id}' is not a system session. Valid ids: {}, a network's architect \
         (`network-<slug>:architect`), or a surface session \
         (`surface-studio:noun-<noun>` / `surface-studio:verb-<noun>-<verb>`).\n\
         This verb reaches the app-owned system sessions and the per-network architects — not fleet \
         workers, and not a project's director (a director owns a running fleet, so ending one is the \
         user's act, not the architect's).",
        valid_ids().join(" · ")
    )
}

/// Resolve an id that `stop` may act on.
///
/// The architect is the one exclusion, and it is a self-reference rather than a capability question.
/// The architect is the session that HOLDS the orchestration conversation and the one this verb is
/// granted to, so `bsc session stop architect` is a caller killing itself: the frontend kills the PTY,
/// the CLI process inside that PTY dies before it can read the reply, and the request looks like a
/// timeout while having actually succeeded. Making it inexpressible costs one field and removes the
/// only self-referential case in the set — the alternative is discovering it at runtime as a bug
/// report about a command that "fails" and works.
///
/// `start` deliberately has no such exclusion: starting an already-running architect is a no-op, and
/// starting a stopped one is the ordinary thing another actor might want.
pub fn resolve_stoppable(id: &str) -> Result<ResolvedSession, String> {
    let s = resolve(id)?;
    if !s.stoppable {
        return Err(format!(
            "'{}' cannot be stopped through this verb — it is the session that holds the \
             orchestration conversation, and stopping it here would kill the caller mid-request. \
             Close it from the app if that is really what you want.",
            s.id
        ));
    }
    Ok(s)
}

/// Which sessions to report on. Empty ⇒ all of them.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionListRequest {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub ids: Vec<String>,
}

/// One system session's real state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemSessionState {
    pub id: String,
    pub pane_id: String,
    /// A PTY session exists — `pty_create` would RECONNECT rather than launch.
    pub live: bool,
    /// The AGENT is running something — it has spawned a child of its own (a tool call, a build).
    ///
    /// This used to be the shell-level "has a live descendant" probe, and the doc here claimed an idle
    /// session would read false. It could not: for an agent session the agent IS a descendant of the
    /// shell, so the field was true for the whole life of the session and merely restated `live`.
    /// Measured on an idle designer whose entire tree was `bash → claude` sitting at its prompt.
    ///
    /// LIMIT: an agent waiting on a model response has no child either, so it reads false. This means
    /// "running something", not "occupied".
    pub busy: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    /// What this session IS, printed in the listing. For a registry row it is the registry's own
    /// summary; for a DISCOVERED one it says what the session is and why it exists, which is the
    /// question a caller actually has when an unexpected row appears.
    ///
    /// `#[serde(default)]` so a newer CLI reading an OLDER app's reply lists rather than failing the
    /// whole read — the binary is staged from `target/` at app boot, so the two are routinely a build
    /// apart.
    #[serde(default)]
    pub summary: String,
    /// Whether the WRITE half of this verb can name this session.
    ///
    /// True for the fixed registry. False for anything DISCOVERED, and that is not a check to be
    /// remembered: a per-request debug session's id is minted at runtime, so it is not expressible in
    /// the argument space `resolve` searches. The flag exists so a listing can SAY so rather than
    /// leaving the caller to find out by being refused.
    ///
    /// Defaults to `true` so an older app's reply — which predates the field and only ever contained
    /// registry rows — is read as exactly what it was.
    #[serde(default = "yes")]
    pub managed: bool,
}

/// The `serde` default for [`SystemSessionState::managed`] — see its doc for why it is `true`.
fn yes() -> bool {
    true
}

/// The pane-id prefix every Debug Studio session shares: the standing `debug-studio:debugger` and each
/// auto-spawned per-request `debug-studio:req-<n>`.
///
/// Mirrors `DEBUG_STUDIO_PANE_PREFIX` in `src/shared/lib/session/systemSessions.ts`. It is the one
/// class of app-owned session with a RUNTIME id, which is exactly why it cannot join [`SYSTEM_SESSIONS`]
/// and why it has to be discovered instead.
pub const DEBUG_STUDIO_PREFIX: &str = "debug-studio:";

/// The ONE debug-studio pane id that is fixed: the standing debugger, which genuinely resumes across
/// app restarts. Every other session under [`DEBUG_STUDIO_PREFIX`] is a per-request
/// `debug-studio:req-<n>` that resumes nothing.
///
/// It lives here rather than in [`SYSTEM_SESSIONS`] because that table is the argument space of
/// `bsc session start|stop|ask`, and the debug studio is toggled from Settings rather than named to
/// the CLI — see the prefix's doc above. But the standing id IS a stable, app-owned fact, and callers
/// that need the full app-owned pane registry (rather than the CLI's argument space) need it by name:
/// `startup_prompt_fresh_only` is the first, and reaching for the PREFIX there instead of this
/// constant is precisely the bug that stranded every per-request debug session at an empty prompt.
///
/// Mirrors `DEBUG_STUDIO_SESSION_ID` in `src/shared/lib/session/systemSessions.ts`.
pub const DEBUG_STUDIO_STANDING_PANE_ID: &str = "debug-studio:debugger";

/// The short id and summary for a DISCOVERED session — one the app is running that this verb does not
/// manage.
///
/// Returns `None` for a pane that is not a discovered session, so the caller has one predicate rather
/// than a prefix test at each site.
///
/// The summary is the whole point of the row. "Two debug sessions started and I'm not sure where they
/// came from" is answerable only if the listing says which REQUEST a session belongs to; a row that
/// only proved something was running would restate the mystery.
pub fn discovered(pane_id: &str) -> Option<(String, String)> {
    // A NETWORK's architect is reported by its full pane id, because that is also its resolvable id —
    // there is no short name to keep in step. Unlike a debug session it IS nameable by the write half,
    // and `list` derives `managed` by asking `resolve` rather than asserting it here, so the two halves
    // cannot disagree about which rows those are.
    // …and its STEWARD alongside it, for the same reason. Both, or `list` would show one of a
    // network's two root sessions and silently omit the other.
    if network_architect_slug(pane_id).is_some() || network_steward_slug(pane_id).is_some() {
        let (id, summary) = (
            pane_id.to_string(),
            resolve(pane_id).ok()?.summary,
        );
        return Some((id, summary));
    }
    let tail = pane_id.strip_prefix(DEBUG_STUDIO_PREFIX)?;
    if tail.is_empty() {
        return None;
    }
    let summary = match tail.strip_prefix("req-") {
        // The per-request session (#one-request-one-debug-session): spawned because a request exists,
        // which is a decision nobody makes — see `the-director-triages-requests-instead-of-auto-spawning`.
        Some(n) => format!(
            "a per-request debug session for request {n} — `bsc request get {n}` says what it is for              (auto-spawned; NOT started by this verb)"
        ),
        None => "the standing Debug Studio session — full capability in the app's own source tree                  (NOT started by this verb)"
            .to_string(),
    };
    Some((tail.to_string(), summary))
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionListResult {
    pub sessions: Vec<SystemSessionState>,
}

/// What to do to a system session's lifecycle.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LifecycleAction {
    Start,
    Stop,
}

/// Ask the app to start or stop one system session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LifecycleRequest {
    /// Already resolved against [`SYSTEM_SESSIONS`] by the CLI — but the app resolves it AGAIN before
    /// acting. The channel is a directory any process can write to, so the app cannot treat the CLI as
    /// the only writer; re-resolving is what keeps the closed set closed rather than merely tidy.
    pub id: String,
    pub action: LifecycleAction,
    /// Set by `bsc session ask` when this start exists to SERVE a request: the request ITSELF, which
    /// becomes the started session's launch prompt.
    ///
    /// It used to be a loop id, and the app turned that into prose telling the session to go run
    /// `bsc loop watch <n>`. That was an indirection to a rendezvous the callee had to opt into, and
    /// across 23 loops it opted in zero times. The request is right here, so it can simply BE the
    /// prompt — and a session born holding its request cannot miss it.
    ///
    /// A launch ARGUMENT, not a write into a live terminal: it goes exactly where the persona prompt
    /// goes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request: Option<String>,
}

/// What actually happened — distinguished, not collapsed into a bare success.
///
/// `bsc fleet wake` earned this the hard way (#4025): a false success left a caller acting on a session
/// that was not running. Here the interesting cases are the no-ops — starting something already up, or
/// stopping something that was never up — because a caller told "started" when nothing changed will
/// wait for a session it thinks it just created.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum LifecycleOutcome {
    /// It was not running; it is now.
    Started,
    /// It was already running — nothing was done, and nothing needed to be.
    AlreadyRunning,
    /// It was running; it has been stopped.
    Stopped,
    /// It was not running — nothing to stop.
    NotRunning,
}

impl LifecycleOutcome {
    /// Whether this outcome CHANGED anything, for a caller that wants the one-bit answer.
    pub fn changed(self) -> bool {
        matches!(self, Self::Started | Self::Stopped)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LifecycleResult {
    pub id: String,
    pub pane_id: String,
    pub outcome: LifecycleOutcome,
}

// ── Where a session's conversation lives ───────────────────────────────────────────────────────────
//
// ONE definition, shared by the app and `bsc session`. It sits in this Tauri-free crate rather than in
// `src-tauri` because the CLI cannot reach a `pub(crate)` there — and re-deriving these paths on the
// CLI side is the one thing that must not happen. `launch.rs` already documents that exact bug: the
// launcher bound `<root>/home/bsc-agent` while the probe asked the per-cwd host path, "so a caged
// worker reported `has_history=false` with eleven messages sitting in its cage and restarted from
// nothing on every launch". A second copy of a path IS that bug, waiting.

/// Claude Code's on-disk directory name for a launch `cwd`: every non-alphanumeric character replaced
/// by `-`, no cap (`C:\Users\Kevin\foo` → `C--Users-Kevin-foo`).
///
/// SEMANTICS ARE FROZEN — this must match what Claude Code itself writes under `~/.claude/projects`,
/// so it is not ours to tidy. Not to be confused with the app's `claude_project_key`, which
/// slash-normalises the same cwd for the `projects` map in `~/.claude.json`: a different transform for
/// a different on-disk contract, deliberately kept separate.
pub fn claude_project_dir_name(cwd: &str) -> String {
    cwd.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect()
}

/// Where `bsc-agent` persists (and resumes) the conversation for `cwd` on the HOST:
/// `~/.base-studio-code/agent-sessions/<cwd-key>/conversation.json`.
///
/// Empty `cwd` ⇒ `None`: no cwd means no persistence, and a path built from an empty slug would at
/// the parent directory itself.
pub fn agent_session_path(cwd: &str) -> Option<std::path::PathBuf> {
    if cwd.is_empty() {
        return None;
    }
    Some(
        bsc_util::bsc_base_dir()?
            .join("agent-sessions")
            .join(claude_project_dir_name(cwd))
            .join("conversation.json"),
    )
}

/// Where a caged `bsc-agent` keeps its conversation, as the GUEST sees it.
pub const CAGED_AGENT_SESSION_GUEST: &str = "/home/agent/.bsc-agent/conversation.json";

/// The HOST directory backing [`CAGED_AGENT_SESSION_GUEST`] for a pane whose sandbox stores live at
/// `stores_root`.
pub fn caged_agent_conversation_dir(stores_root: &std::path::Path) -> std::path::PathBuf {
    stores_root.join("home").join("bsc-agent")
}

/// The HOST path of a caged `bsc-agent`'s conversation file.
///
/// Derived from the guest path's own file name rather than repeating the literal, so the two cannot
/// drift apart silently.
pub fn caged_agent_conversation_path(stores_root: &std::path::Path) -> std::path::PathBuf {
    let name = std::path::Path::new(CAGED_AGENT_SESSION_GUEST)
        .file_name()
        .map(std::ffi::OsStr::to_os_string)
        .unwrap_or_else(|| std::ffi::OsString::from("conversation.json"));
    caged_agent_conversation_dir(stores_root).join(name)
}

// This crate's modules are IN THE GRAPH, not in this directory.
// src/ask.rs, src/cli.rs do not exist — they are records in the
// committed graph/algorithms.json, materialized into $OUT_DIR by the shared build script.
// To change one, edit the RECORD and promote it; editing a file here would be editing nothing:
//     bsc graph impl get bsc-session--<module>.rs
//     bsc graph impl set --id bsc-session--<module>.rs --code-file <f>
//     bsc graph promote --id bsc-session--<module>.rs
//
// This header is still a file because this root holds crate-level code of its own. A root
// down to its //! docs and this include is migrated too: the docs become the
// `bsc-session--lib.rs` doc record and [lib] path points at crates/graph-materialize/crate_root.rs.
include!(concat!(env!("OUT_DIR"), "/crate.rs"));

/// The DELIVERY policy for an ask (#an-ask-is-delivered-not-left-to-be-found).
///
/// Lives in this Tauri-free crate rather than in the app because BOTH ends need it: the app decides
/// and carries it out, and the CLI reports what happened. A stringly-typed action on the wire would
/// have the two disagree about the one thing the caller reads.
pub mod deliver {
    use serde::{Deserialize, Serialize};

    /// What delivering an ask to a session should DO, given the state that session is in.
    #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(rename_all = "kebab-case")]
    pub enum Action {
        /// The session is not running: start it with the request in its launch prompt.
        ///
        /// The path that has never failed, and the reason it is kept rather than replaced — a session born
        /// with the request cannot miss it.
        StartWith,
        /// The session is up and its agent is at a prompt: write the request in.
        Inject,
        /// The session is up and its agent is running something: interrupt it, then write the request in.
        /// Only ever chosen when the caller explicitly asked for it.
        InterruptWith,
        /// The session is working and the caller did not ask to interrupt. The request stays queued and
        /// the caller is TOLD, because a delivery that silently did nothing is the failure this whole item
        /// exists to end.
        LeaveWorking,
    }

    impl Action {
        /// Whether this action writes into a session that is already running.
        ///
        /// The two that do are exactly the two that cross `#only-the-user-resumes-a-session`, so they are
        /// nameable as a set rather than spelled out at each call site.
        pub fn writes_into_a_live_session(self) -> bool {
            matches!(self, Action::Inject | Action::InterruptWith)
        }

        /// A short phrase for the caller's report — what actually happened to their request.
        pub fn describe(self) -> &'static str {
            match self {
                Action::StartWith => "the session was started with your request in its launch prompt",
                Action::Inject => "your request was delivered to the idle session",
                Action::InterruptWith => "the session was interrupted and given your request",
                Action::LeaveWorking => {
                    "the session is working, so the request was left queued — re-send with \
                     `--on-busy wait` to have it delivered the moment the session frees up, or \
                     `--on-busy interrupt` (`--interrupt`) to cut in now"
                }
            }
        }
    }

    /// Decide how to deliver, from the target's measured state.
    ///
    /// `live` is "a PTY session exists"; `working` is the AGENT-level probe (`busy::agents_doing_work`) —
    /// the agent has spawned a child of its own. Deliberately NOT the shell-level `busy`, which for an
    /// agent session is permanently true because the agent is itself a descendant, and would therefore
    /// route every single ask to [`Action::LeaveWorking`].
    ///
    /// `interrupt` is the caller's explicit request to cut into work in progress. It is honoured ONLY when
    /// the session is actually working: interrupting an idle agent would send a stray interrupt key for no
    /// reason, and starting a stopped one is not an interruption at all.
    pub fn plan(live: bool, working: bool, interrupt: bool) -> Action {
        match (live, working) {
            (false, _) => Action::StartWith,
            (true, false) => Action::Inject,
            (true, true) if interrupt => Action::InterruptWith,
            (true, true) => Action::LeaveWorking,
        }
    }

    /// The keystroke that interrupts an agent mid-turn, and the pause after it.
    ///
    /// ESC is what a Claude Code TUI reads as "stop the current turn"; the pause gives it time to unwind
    /// before the next line arrives, so the request is typed at a prompt rather than into a turn that is
    /// still tearing down. Ctrl-C is deliberately NOT used: in a TUI it is as likely to kill the agent as
    /// to interrupt its turn, and this verb is meant to redirect a session, not end it.
    pub const INTERRUPT_KEY: &str = "\x1b";
    pub const INTERRUPT_SETTLE_MS: u64 = 250;

    /// The bytes that deliver `text` to an agent sitting at its prompt — WITHOUT its terminator.
    ///
    /// Any interior CR/LF is flattened to a space: a multi-line request would otherwise submit at its
    /// first newline and send the remainder as a second, truncated turn.
    ///
    /// **The Enter is deliberately not here — see [`SUBMIT_KEY`].** It used to be, as a trailing `\r`
    /// on this string, and that is exactly why a delivered prompt sat in the input box unsent.
    pub fn submission(text: &str) -> String {
        text.chars()
            .map(|c| if c == '\r' || c == '\n' { ' ' } else { c })
            .collect::<String>()
            .trim()
            .to_string()
    }

    /// The keystroke that SUBMITS a delivered request, written SEPARATELY from the text.
    ///
    /// # Why it cannot ride on the text
    ///
    /// One `write_pane` call puts the text and the terminator in a single read on the PTY, and Claude's
    /// TUI reads a large single-read burst as a PASTE — inside which a carriage return is a newline in
    /// the buffer, not a submit. The request is delivered and never sent, which looks identical to a
    /// working delivery right up until nobody answers.
    ///
    /// MEASURED by replaying the app's exact byte pattern against a real PTY master. SIZE is the
    /// trigger, which is why every short probe submitted happily and only a real director prompt showed
    /// it:
    ///
    /// ```text
    /// 494 chars, `text + \r` in ONE write   -> text sits in the input, no turn runs
    /// 494 chars, `text`, 150ms, then `\r`   -> the turn runs and the model answers
    /// ```
    ///
    /// The interrupt route above already separates its keystroke from the text for a kindred reason;
    /// this is the same move at the other end of the delivery.
    pub const SUBMIT_KEY: &str = "\r";

    /// How long to let the pasted text settle before the Enter, so the two land in different reads.
    ///
    /// 150ms is the measured-good value, not a guess at a threshold — the TUI's paste heuristic is
    /// its own business and may change, so the margin is deliberately generous relative to the cost
    /// (a delivery already crossed a process boundary to get here).
    pub const SUBMIT_SETTLE_MS: u64 = 150;

    #[cfg(test)]
        mod tests {
        use super::*;

        #[test]
        fn a_stopped_session_is_started_with_the_request() {
            // The path that has never failed. `interrupt` is irrelevant here — there is nothing to cut in
            // on, and a stopped session cannot miss a request it is born holding.
            assert_eq!(plan(false, false, false), Action::StartWith);
            assert_eq!(plan(false, false, true), Action::StartWith);
            assert_eq!(plan(false, true, true), Action::StartWith, "not live wins over any staleness in `working`");
        }

        #[test]
        fn an_idle_session_is_given_the_request_rather_than_asked_to_look_for_it() {
            // THE REGRESSION. This is the state all four stranded asks were in: up, idle, and never told.
            assert_eq!(plan(true, false, false), Action::Inject);
        }

        #[test]
        fn an_idle_session_is_never_interrupted_even_when_interrupt_is_asked_for() {
            // There is nothing to interrupt, and a stray ESC into an idle agent is a keystroke nobody sent.
            assert_eq!(plan(true, false, true), Action::Inject);
        }

        #[test]
        fn a_working_session_is_left_alone_by_default_and_cut_into_only_on_request() {
            assert_eq!(plan(true, true, false), Action::LeaveWorking);
            assert_eq!(plan(true, true, true), Action::InterruptWith);
        }

        #[test]
        fn leaving_a_working_session_alone_still_tells_the_caller_what_to_do() {
            // A delivery that silently did nothing is the failure this item exists to end, so the one
            // action that delivers nothing has to carry BOTH ways through — the caller who stood off
            // by default is exactly the caller who does not know the other two exist.
            let msg = Action::LeaveWorking.describe();
            assert!(msg.contains("--on-busy wait"), "it names the route that waits: {msg}");
            assert!(msg.contains("--interrupt"), "and the one that cuts in: {msg}");
        }

        #[test]
        fn exactly_two_actions_write_into_a_live_session() {
            // These two are what cross #only-the-user-resumes-a-session. Naming them as a set is what lets
            // the guard and the audit line agree about which they are.
            assert!(Action::Inject.writes_into_a_live_session());
            assert!(Action::InterruptWith.writes_into_a_live_session());
            assert!(!Action::StartWith.writes_into_a_live_session(), "a launch prompt is not an injection");
            assert!(!Action::LeaveWorking.writes_into_a_live_session());
        }

        /// THE PROMPT THAT ARRIVED AND WAS NEVER SENT. The terminator used to be fused onto this
        /// string, so one `write_pane` put text and Enter in a single read — which Claude's TUI reads
        /// as a PASTE, and a carriage return inside a paste is a newline in the buffer. The request
        /// appeared in the input box and no turn ever ran.
        ///
        /// MEASURED against a real PTY master with the app's exact byte pattern: 494 chars plus `\r`
        /// in ONE write does not submit; the same text with the `\r` 150ms later does. Short probes
        /// submit either way, which is why only a real director prompt ever showed it.
        #[test]
        fn the_submission_carries_no_terminator_of_its_own() {
            let s = submission("review the kickoff");
            assert_eq!(s, "review the kickoff");
            assert!(!s.ends_with('\r'), "the Enter is a SEPARATE write: {s:?}");
            // ...and the key that submits it is its own thing, so the two cannot be re-fused by
            // accident.
            assert_eq!(SUBMIT_KEY, "\r");
            const { assert!(SUBMIT_SETTLE_MS > 0, "they must land in different reads") };
        }

        #[test]
        fn interior_newlines_are_flattened_so_a_request_cannot_submit_itself_halfway() {
            // A multi-line request would submit at its FIRST newline and send the rest as a second,
            // truncated turn — the receiving agent would answer half a question.
            let s = submission("line one\nline two\r\nline three");
            assert_eq!(s, "line one line two  line three");
            assert_eq!(s.matches('\r').count(), 0, "no terminator anywhere in the text");
        }

        #[test]
        fn surrounding_whitespace_is_trimmed_but_the_text_is_otherwise_verbatim() {
            assert_eq!(submission("  spaced  "), "spaced");
            // Not mangled: the request is prose the receiving agent has to read.
            assert_eq!(submission("use `bsc ui set` — and check --coverage"), "use `bsc ui set` — and check --coverage");
        }
    }
}
