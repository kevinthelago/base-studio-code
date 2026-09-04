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

#[cfg(test)]
mod tests {

    /// THE FROZEN CONTRACT, pinned with the app's own vectors so the extraction is provably
    /// behaviour-preserving. These are the exact assertions `launch.rs` carried before this function
    /// moved; if they ever need changing, Claude Code changed first and the app must follow — this is
    /// not ours to tidy.
    #[test]
    fn the_claude_project_slug_matches_the_dir_claude_code_creates() {
        assert_eq!(
            claude_project_dir_name(r"C:\Users\Kevin\Projects\rust\base-studio-code"),
            "C--Users-Kevin-Projects-rust-base-studio-code"
        );
        // Consecutive specials (`\` then `.`) each map to their OWN dash — not collapsed.
        assert_eq!(
            claude_project_dir_name(r"C:\Users\Kevin\.base-studio-code\documents"),
            "C--Users-Kevin--base-studio-code-documents"
        );
        // A posix path, and the empty case.
        assert_eq!(claude_project_dir_name("/home/u/p"), "-home-u-p");
        assert_eq!(claude_project_dir_name(""), "");
    }

    #[test]
    fn an_empty_cwd_has_no_conversation_path_rather_than_one_at_the_parent() {
        assert!(agent_session_path("").is_none());
        let p = agent_session_path("/home/u/p").expect("a real cwd resolves");
        assert!(p.ends_with("conversation.json"));
        assert!(p.to_string_lossy().contains("/agent-sessions/"));
        assert!(p.to_string_lossy().contains("-home-u-p"), "keyed by the frozen slug: {}", p.display());
    }

    /// The bind and the probe must agree. They did not once, and a caged worker reported
    /// `has_history=false` with eleven messages sitting in its cage.
    #[test]
    fn the_caged_conversation_path_is_the_guest_file_under_the_host_dir() {
        let root = std::path::Path::new("/stores/pane");
        assert_eq!(caged_agent_conversation_dir(root), std::path::Path::new("/stores/pane/home/bsc-agent"));
        assert_eq!(
            caged_agent_conversation_path(root),
            std::path::Path::new("/stores/pane/home/bsc-agent/conversation.json")
        );
        // The file name is DERIVED from the guest constant, so the two cannot drift.
        assert!(CAGED_AGENT_SESSION_GUEST.ends_with("conversation.json"));
    }
    use super::*;

    /// The routing keys must not collide with each other or with any sibling verb's — one channel,
    /// routed by kind, so a collision silently sends a request to the wrong handler.
    #[test]
    fn the_two_routing_keys_are_distinct() {
        assert_eq!(KIND, "session");
        assert_eq!(LIFECYCLE_KIND, "session-lifecycle");
        assert_ne!(KIND, LIFECYCLE_KIND);
    }

    /// The closed set is the mitigation, so its shape is pinned: unique ids, unique pane ids, and every
    /// pane id in the `<key>:<tail>` grammar the app's studio registry uses.
    #[test]
    fn the_registry_is_a_well_formed_closed_set() {
        let mut ids: Vec<_> = SYSTEM_SESSIONS.iter().map(|s| s.id).collect();
        let n = ids.len();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), n, "duplicate id in the registry");

        let mut panes: Vec<_> = SYSTEM_SESSIONS.iter().map(|s| s.pane_id).collect();
        panes.sort_unstable();
        panes.dedup();
        assert_eq!(panes.len(), n, "two sessions sharing a pane id would fight over one PTY");

        for s in SYSTEM_SESSIONS {
            assert_eq!(s.pane_id.matches(':').count(), 1, "{}: pane id is `<key>:<tail>`", s.id);
            assert!(!s.summary.is_empty(), "{}: needs a summary — it is printed in the refusal", s.id);
        }
    }

    #[test]
    fn resolve_accepts_the_registry_and_the_network_architect_grammar() {
        for s in SYSTEM_SESSIONS {
            assert_eq!(resolve(s.id).unwrap().pane_id, s.pane_id);
        }
    }

    /// A network's architect is nameable by the WRITE half, unlike a discovered debug session.
    ///
    /// The closed registry made this verb safe to grant by ensuring every argument was an id the app
    /// owned. A grammar keeps that property — `network-<slug>:architect` is a name the app defines —
    /// while letting the user mint networks at runtime, which a compile-time table cannot express.
    #[test]
    fn a_network_architect_resolves_by_grammar_and_is_stoppable() {
        let s = resolve("network-kitchen:architect").expect("the grammar resolves");
        assert_eq!(s.id, "network-kitchen:architect");
        assert_eq!(s.pane_id, s.id, "id and pane id are the same string — no short name to keep in step");
        assert!(s.summary.contains("kitchen"), "the summary names its network: {}", s.summary);

        // STOPPABLE, unlike the Teams Studio architect — that one holds the conversation this verb is
        // called from, whereas a network's architect is an ordinary session the user created. A network
        // deleted while its architect runs must not strand it.
        assert!(resolve_stoppable("network-kitchen:architect").is_ok());
        assert!(resolve_stoppable("architect").is_err(), "the Teams Studio architect is still unstoppable");
    }

    /// The grammar is not a hole. It admits exactly one shape, and everything the closed set refused
    /// before is still refused — a director above all, which is the guarantee the module doc makes.
    #[test]
    fn the_network_grammar_widens_nothing_else() {
        for bad in [
            "network-:architect", "network-kitchen", "network-kitchen:director",
            "network-Kitchen:architect", "network-kit chen:architect", "network-../etc:architect",
            "kitchen:architect", "studio-code:director", "director", "worker", "",
            "debug-studio:req-158", "debug-studio:debugger",
        ] {
            assert!(resolve(bad).is_err(), "{bad} must not resolve");
        }
        assert!(network_architect_slug("network-kitchen:architect") == Some("kitchen"));
    }

    /// THE NOUN CAN NOW REACH THE VERB'S OWN SESSION (`the-noun-asks-the-verbs-own-session`).
    ///
    /// The operator had two channels and neither arrived at a maintainer. `bsc request new` files onto
    /// the GLOBAL tooling queue, worked by a DEBUG session on a stronger model — the right lane for a
    /// gap in the `bsc` surface, the wrong one for "this verb costs too much". And `bsc-ask` carries no
    /// addressee at all: it tags the asker's own pane and broadcasts into `coord.log`, read only by a
    /// project's director pump, and a surface session belongs to no fleet. So a finding went to the
    /// debugger or went nowhere, while `ask`/`reply` — the one channel that DELIVERS — refused the ids.
    #[test]
    fn a_surface_session_resolves_by_grammar_so_ask_can_reach_it() {
        let op = resolve("surface-studio:noun-studio").expect("the operator resolves");
        assert_eq!(op.pane_id, op.id, "the pane id IS the name — nothing to keep in step");
        assert!(op.summary.contains("bsc studio"), "the summary names its noun: {}", op.summary);
        assert!(op.stoppable);

        let mt = resolve("surface-studio:verb-logs-summary").expect("the maintainer resolves");
        assert!(mt.summary.contains("bsc logs-summary"), "{}", mt.summary);
        assert!(mt.stoppable);

        // The two personas are told apart, because the charter each gets depends on which it is.
        assert_eq!(surface_session_kind("surface-studio:noun-studio").map(|(k, _)| k), Some("operator"));
        assert_eq!(surface_session_kind("surface-studio:verb-logs-summary").map(|(k, _)| k), Some("maintainer"));
    }

    /// The surface grammar admits exactly one shape. It is the injection boundary, so a tail that
    /// could reach a directory or a second pane key must be refused, not sanitized.
    #[test]
    fn the_surface_grammar_widens_nothing_else() {
        for bad in [
            "surface-studio:", "surface-studio:noun-", "surface-studio:verb-",
            "surface-studio:noun-Studio", "surface-studio:noun-my studio", "surface-studio:noun-../etc",
            "surface-studio:noun-a:b", "surface-studio:other-studio", "surface-studioX:noun-studio",
            "noun-studio", "studio",
        ] {
            assert!(resolve(bad).is_err(), "{bad} must not resolve");
            assert!(surface_session_kind(bad).is_none(), "{bad} must not parse");
        }
        // ...and the refusal still names every space, so a caller who guessed is corrected.
        let err = resolve("surface-studio:noun-").unwrap_err();
        assert!(err.contains("surface-studio:noun-<noun>"), "the error teaches the grammar: {err}");
    }

    /// A discovered session is READ-ONLY here, and the two halves have to agree about which rows those
    /// are — the listing marks them `managed: false`, and `resolve` must actually refuse them.
    #[test]
    fn a_discovered_session_is_listable_but_not_nameable() {
        for pane in ["debug-studio:debugger", "debug-studio:req-158"] {
            let (id, summary) = discovered(pane).expect("{pane} is a discovered session");
            assert!(!summary.is_empty());
            // It says it is not this verb's to start, so the listing does not read as an invitation.
            assert!(summary.contains("NOT started by this verb"), "{pane}: {summary}");
            // ...and the write half agrees, by the id simply not being in the space it searches.
            assert!(resolve(&id).is_err(), "{id} must not resolve");
            assert!(resolve(pane).is_err(), "{pane} must not resolve either");
        }
    }

    /// The per-request row has to name its REQUEST. Without that number, a listing proves a session is
    /// running and leaves "where did it come from" exactly where it was — which is the whole reason
    /// this row exists.
    #[test]
    fn a_per_request_row_names_the_request_it_belongs_to() {
        let (id, summary) = discovered("debug-studio:req-158").unwrap();
        assert_eq!(id, "req-158");
        assert!(summary.contains("158"), "the request number is the answer: {summary}");
        assert!(summary.contains("bsc request get 158"), "…and the command that reads it: {summary}");

        let (id, summary) = discovered("debug-studio:debugger").unwrap();
        assert_eq!(id, "debugger");
        assert!(!summary.contains("request"), "the standing session belongs to no request: {summary}");
    }

    /// Discovery is a PREFIX match, so anything that is not a debug-studio pane must fall through
    /// rather than being listed as one. A registry pane in particular: it has its own row already, and
    /// two rows for one session would read as two sessions.
    #[test]
    fn only_a_debug_studio_or_network_architect_pane_is_discovered() {
        for pane in [
            "design-studio:designer-react",
            "teams-studio:architect",
            "studio-code:director",
            "debug-studio:", // the bare prefix names no session
            "debug-studio",
            "",
            // The network grammar, missed in every way it can be missed.
            "network-:architect",        // no slug
            "network-kitchen",           // no tail
            "network-kitchen:director",  // a network has ONE architect, and no director of its own
            "network-Kitchen:architect", // a slug is lowercase — it is a pane key and a directory name
            "network-kit chen:architect",
            "kitchen:architect",         // the prefix is what makes it a network
        ] {
            assert!(discovered(pane).is_none(), "{pane} must not be discovered");
        }
    }

    /// A newer CLI against an OLDER app is the routine case — the binary is staged from `target/` at
    /// app boot, so the two are often a build apart. The two added fields must therefore DEFAULT rather
    /// than failing the whole read, and `managed` must default to TRUE: every row an older app can send
    /// is a registry row.
    #[test]
    fn an_older_apps_reply_still_lists() {
        let old = r#"{"sessions":[{"id":"designerReact","paneId":"design-studio:designer-react","live":true,"busy":false}]}"#;
        let res: SessionListResult = serde_json::from_str(old).expect("an older reply must still parse");
        assert_eq!(res.sessions.len(), 1);
        assert!(res.sessions[0].managed, "a row from before the field existed is a registry row");
        assert_eq!(res.sessions[0].summary, "");
    }

    /// The whole point of the verb's argument space: a DIRECTOR is not expressible. Stopping a director
    /// is not refused by a check somewhere downstream that could be dropped in a refactor — there is no
    /// spelling of this argument that names one.
    #[test]
    fn a_director_pane_id_is_not_expressible() {
        for candidate in [
            "studio-code:director",
            "director",
            "base-studio-code:director",
            "studio-code:api", // nor any other fleet worker
        ] {
            let err = resolve(candidate).unwrap_err();
            assert!(err.contains("is not a system session"), "{candidate} must be refused");
            assert!(err.contains("director"), "the refusal explains WHY a director is out of scope");
        }
    }

    /// A near-miss is the realistic mistake (the id is camelCase, the pane id is kebab). The refusal has
    /// to carry the valid set or the caller just guesses again.
    #[test]
    fn a_near_miss_is_refused_and_told_the_valid_set() {
        let err = resolve("sound-designer").unwrap_err();
        assert!(err.contains("soundDesigner"), "the refusal names the id the caller meant");
        // The realistic per-tech near-miss: the pane id is kebab, the studio id is camel.
        assert!(resolve("librarian-rust").is_err(), "the PANE id is not the studio id");
        assert!(resolve("librarian").is_err(), "the un-teched role is not a session any more");
        for id in valid_ids() {
            assert!(err.contains(id), "the refusal lists {id}");
        }
    }

    /// Case and whitespace are NOT normalised away. An id that only matches after being massaged is a
    /// second, looser spelling of the closed set — and the looser the match, the more of the argument
    /// space injected prose can reach.
    #[test]
    fn resolution_is_exact_rather_than_forgiving() {
        for near in ["DesignerReact", "DESIGNERREACT", " designerReact", "designerReact ", "design-studio:designer-react"] {
            assert!(resolve(near).is_err(), "{near} must not resolve");
        }
    }

    /// Both wire shapes survive a JSON round trip verbatim — the app deserializes the request and the
    /// CLI deserializes the result back, so a rename on either side has to fail here rather than in the
    /// field as "the app did nothing".
    #[test]
    fn the_wire_contract_round_trips() {
        let req = LifecycleRequest { id: "designer".into(), action: LifecycleAction::Stop, request: None };
        let back: LifecycleRequest = serde_json::from_str(&serde_json::to_string(&req).unwrap()).unwrap();
        assert_eq!(back, req);

        let res = LifecycleResult {
            id: "designer".into(),
            pane_id: "design-studio:designer".into(),
            outcome: LifecycleOutcome::AlreadyRunning,
        };
        let json = serde_json::to_string(&res).unwrap();
        assert!(json.contains("\"paneId\""), "camelCase on the wire, like every other appchan result");
        assert!(json.contains("\"already-running\""), "the outcome is kebab-case on the wire");
        let back: LifecycleResult = serde_json::from_str(&json).unwrap();
        assert_eq!(back, res);

        let list = SessionListResult {
            sessions: vec![SystemSessionState {
                id: "librarian".into(),
                pane_id: "algorithms-studio:librarian".into(),
                live: true,
                busy: false,
                pid: Some(42),
                summary: "the Algorithms Studio".into(),
                managed: true,
            }],
        };
        let back: SessionListResult =
            serde_json::from_str(&serde_json::to_string(&list).unwrap()).unwrap();
        assert_eq!(back, list);
    }

    /// `stop` excludes exactly one session, and `start` excludes none. Pinned as a pair: the
    /// exclusion exists because the architect would be killing its own caller, NOT because stopping it
    /// is dangerous — so making `start` symmetrical with it would be the wrong fix.
    #[test]
    fn stop_excludes_only_the_architect_and_start_excludes_nobody() {
        for s in SYSTEM_SESSIONS {
            assert!(resolve(s.id).is_ok(), "{} must always be startable", s.id);
            assert_eq!(
                resolve_stoppable(s.id).is_ok(),
                s.id != "architect",
                "{} stoppability",
                s.id
            );
        }
        let err = resolve_stoppable("architect").unwrap_err();
        assert!(err.contains("kill the caller"), "the refusal says WHY, not just no");
    }

    /// The exclusion must not become a second, looser spelling of the closed set: an id outside the
    /// registry fails the same way through both doors.
    #[test]
    fn the_stop_door_is_no_wider_than_the_closed_set() {
        for candidate in ["studio-code:director", "director", "Designer", ""] {
            assert!(resolve_stoppable(candidate).unwrap_err().contains("is not a system session"));
        }
    }

    #[test]
    fn only_the_acting_outcomes_report_a_change() {
        assert!(LifecycleOutcome::Started.changed());
        assert!(LifecycleOutcome::Stopped.changed());
        assert!(!LifecycleOutcome::AlreadyRunning.changed());
        assert!(!LifecycleOutcome::NotRunning.changed());
    }
}

// This crate's modules are IN THE GRAPH, not in this directory.
// src/ask.rs, src/cli.rs do not exist — they are records in the
// committed graph/algorithms.json, materialized into $OUT_DIR by the shared build script.
// To change one, edit the RECORD and promote it; editing a file here would be editing nothing:
//     bsc graph impl get bsc-session--<module>.rs
//     bsc graph impl set --id bsc-session--<module>.rs --code-file <f>
//     bsc graph promote --id bsc-session--<module>.rs
//
// This header stays a file because include! refuses crate-level //! docs and #![…] inner
// attributes (E0753 / "an inner attribute is not permitted in this context").
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

#[cfg(test)]
mod steward_grammar_tests {
    use super::*;

    #[test]
    fn a_network_steward_resolves_from_its_pane_id_alone() {
        // The gap this closes: the role, its persona and its floor all shipped, and NOTHING could name
        // a steward — so none could be started, listed or stopped.
        let r = resolve("network-finance:steward").expect("a steward resolves");
        assert_eq!(r.pane_id, "network-finance:steward");
        assert_eq!(r.id, r.pane_id, "id IS the pane id — no second name to keep in step");
        assert!(r.summary.contains("finance"), "the summary names the network: {}", r.summary);
        assert!(r.stoppable, "a network deleted while its steward runs must not strand it");
    }

    #[test]
    fn a_network_may_hold_both_an_architect_and_a_steward() {
        // They are different jobs — one plans what comes next, one operates what exists — so the tails
        // are siblings rather than modes of one session.
        let a = resolve("network-finance:architect").expect("architect");
        let s = resolve("network-finance:steward").expect("steward");
        assert_ne!(a.pane_id, s.pane_id);
        assert_ne!(a.summary, s.summary);
    }

    #[test]
    fn the_slug_is_validated_because_it_becomes_a_pane_key() {
        // Same rule the architect's grammar enforces: this reaches a pane key AND a directory name.
        assert!(network_steward_slug("network-:steward").is_none(), "empty slug");
        assert!(network_steward_slug("network-a/b:steward").is_none(), "a separator");
        assert!(network_steward_slug("network-a b:steward").is_none(), "a space");
        assert!(network_steward_slug("network-Finance:steward").is_none(), "uppercase");
        assert_eq!(network_steward_slug("network-a-b2:steward"), Some("a-b2"));
    }

    #[test]
    fn the_two_grammars_do_not_answer_for_each_other() {
        assert!(network_steward_slug("network-finance:architect").is_none());
        assert!(network_architect_slug("network-finance:steward").is_none());
    }

    #[test]
    fn a_steward_is_listable_so_it_cannot_run_unnamed() {
        // `discovered` is what `bsc session list` reports a live pane through. Without the steward arm
        // a running steward would appear as an unmanaged mystery row, which is the exact complaint
        // `discovered`'s own doc says the summary exists to prevent.
        let (id, summary) = discovered("network-kitchen:steward").expect("a live steward is listable");
        assert_eq!(id, "network-kitchen:steward");
        assert!(summary.contains("steward"), "got: {summary}");
    }
}
