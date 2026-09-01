//! `bsc fleet` (#4098) — which fleet panes are ACTUALLY alive.
//!
//! ## Why
//! The `bsc-fleet` shell helper reads `fleet.roster.tsv` — a LAUNCH MANIFEST — and joins `coord.log`.
//! It never checked a process, so a pane printed `idle` whether its session had exited an hour ago or
//! started ten seconds ago and not yet logged. Agents read that as "these sessions are running": on
//! `studio-code` it listed 14 launched panes while 5 `claude.exe` existed system-wide.
//!
//! Part 1 stopped the helper CLAIMING liveness. This supplies it.
//!
//! ## Why it goes through the app
//! Liveness is the app's fact, not the filesystem's: the PTY sessions live in `PtyState`, and "is
//! something running in this pane" is a descendant-process walk the app already does (`console/pty/
//! busy.rs`). No file on disk knows it. So this rides the same `bsc-appchan` request channel `bsc shot`
//! and `bsc navigate` use rather than inventing a second mechanism — or, worse, re-deriving liveness by
//! scanning the process table and guessing which process belongs to which pane.
//!
//! ## Contract
//! An empty `pane_ids` means "every pane the app is tracking". Naming panes narrows it — the caller
//! usually has a roster and wants those rows resolved. The reply reports each pane's `live` (a PTY
//! session exists) and `busy` (it has a live descendant), which are DIFFERENT questions: a session can
//! exist with nothing running in it, and that distinction is the whole point of the original report.

use serde::{Deserialize, Serialize};

pub mod cli;
/// Who the fleet IS — plan.db's membership, kept separate from the app's liveness (see the module docs).
pub mod membership;
/// The dependency gate (#the-director-can-see-which-streams-are-held) — which streams may start, which
/// are waiting on an upstream, and which sit in a cycle. Shares one CONTRACT FIXTURE with the app's
/// `streamGate.ts`, so the reporter and the launcher cannot answer differently.
pub mod fault_triage;
pub mod gate;
/// The claims a fleet makes about itself that do not hold (`bsc fleet doctor`) — the divergence
/// detector for this domain, alongside `bsc graph doctor` and `bsc ui parity`. App-free.
pub mod doctor;

/// This verb's routing key in the shared channel.
pub const KIND: &str = "fleet";

/// The WAKE verb rides its own routing key: it is a different request shape AND a different path
/// through the app (frontend emit + ack, not a pure-Rust answer).
pub const WAKE_KIND: &str = "fleet-wake";

/// `bsc fleet director new` — the architect's one CREATE into the project tier
/// (#architect-creates-a-director-with-discovery). Its own key for the same reason as
/// [`WAKE_KIND`]: creating a session is a frontend store action, not a pure-Rust answer.
pub const DIRECTOR_KIND: &str = "fleet-director";

/// `bsc fleet start` — launch a project's WHOLE fleet (director + every worker stream).
///
/// Its own routing key, for the same reason as [`WAKE_KIND`] and [`DIRECTOR_KIND`]: the pane
/// creation is a frontend store action, not a pure-Rust answer. This is the whole-fleet sibling of
/// `fleet director new` — that one creates the coordinator alone, this one brings up the fleet it
/// coordinates.
pub const START_KIND: &str = "fleet-start";

/// Ask the app to launch a project's fleet.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartRequest {
    /// An EXISTING project's key. Refused when it names nothing — this LAUNCHES a fleet, it does not
    /// create a project.
    pub project_key: String,
    /// Relaunch even when sessions for this project are already live. Without it an existing fleet is
    /// reported rather than duplicated: two workers on one worktree would fight over the same branch.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub force: bool,
}

/// What a start actually did.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StartOutcome {
    #[default]
    Launched,
    /// Sessions for this project are already live and `force` was not set.
    AlreadyRunning,
}

/// The reply to a start.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartResult {
    pub project_key: String,
    pub outcome: StartOutcome,
    /// Whether a director was included.
    #[serde(default)]
    pub director: bool,
    /// The stream ids that got a worker.
    #[serde(default)]
    pub streams: Vec<String>,
    /// Streams SKIPPED because they name no repo, so nothing can be worktree'd for them. Reported
    /// rather than silently dropped — a stream that never launches is otherwise invisible.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub skipped_no_repo: Vec<String>,
}

/// The pane a project's director runs on. Pane identity is `<projectKey>:director`, the same grammar
/// [`director_project_key`] reads back — one spelling, so create / list / brief all name the same pane.
pub fn director_pane_id(project_key: &str) -> String {
    format!("{project_key}:director")
}

/// Ask the app to CREATE a project's director, seeded with what the architect settled.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectorNewRequest {
    /// An EXISTING project's key. Resolved against the project set on both sides and refused when it
    /// names nothing — this verb creates a DIRECTOR, never a project (that is `bsc project new`).
    pub project_key: String,
}

/// What happened. `AlreadyRunning` is not an error but it is not a create either: a second
/// coordinator for one fleet is the failure this distinction exists to prevent, and a caller told
/// "created" would believe it had just seeded a director with context it never received.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DirectorOutcome {
    Created,
    AlreadyRunning,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectorNewResult {
    pub project_key: String,
    pub pane_id: String,
    pub outcome: DirectorOutcome,
    /// Whether this create AUTHORED the director's kickoff (true) or found one already there and left
    /// it alone (false). Reported because the two are different directors: one born with the
    /// architect's discovery, one born with whatever the planner wrote.
    pub kickoff_written: bool,
}

/// The kickoff an architect-created director is born with.
///
/// CREATION CARRIES CONTEXT is the load-bearing half of this verb: a director started empty and
/// briefed a moment later is exactly what the item exists to prevent. But context is carried as
/// SOURCES AND FETCH COMMANDS, never as inlined bodies — #4191's rule is that the store wins over
/// anything quoted into a session's context, because a quoted body is a second copy and the copy is
/// what gets read while the record moves on. The architect is still writing discovery when this
/// director starts; inlining would freeze a half-finished snapshot into its prompt.
pub fn discovery_kickoff(project_key: &str) -> String {
    format!(
        "# Director — {project_key}\n\
         \n\
         You coordinate this project's fleet. You do not plan, and you do not write feature code.\n\
         \n\
         ## Read what the architect settled, first\n\
         \n\
         This project was scoped by the architect before you existed. Read it from the STORE rather\n\
         than waiting to be told — and re-read it when something looks stale, because the store stays\n\
         live while this prompt was written once, at your launch:\n\
         \n\
         - `bsc plan requirement get` — the user's statement, and the AUTHORITY clauses every decision\n\
           below you must cite. Start here; it is what you are accountable to.\n\
         - `bsc plan stage list` then `bsc plan stage get <name>` — the discovery prose (goal, scope,\n\
           stack, architecture, …). These are the discovery files this director was created with.\n\
         - `bsc plan feature list` — the feature breakdown.\n\
         - `bsc plan list` — the issues, with acceptance criteria and owning streams.\n\
         - `bsc plan fleet get --full` — the streams, their owned globs and their dependencies.\n\
         \n\
         If `bsc plan requirement get` comes back empty, the architect has not sealed the requirement\n\
         yet. Say so and wait — do not invent scope to fill the gap.\n\
         \n\
         ## Your lane\n\
         \n\
         - You own integration, contracts and the board. Workers own their own streams.\n\
         - A worker exists only once its STREAM does, and CREATING THE FLEET IS YOURS — nobody does\n\
           it for you. `bsc plan fleet get` on a new project returns `(no fleet)`; that is the normal\n\
           starting state, not a fault, and not something to wait out.\n\
         - To add one: `bsc plan fleet stream set <id>` with the stream JSON on stdin — at minimum\n\
           `{{\"id\":\"<id>\",\"repo\":\"<owner/repo>\",\"owns\":[\"<glob>\"],\"issues\":[],\"dependsOn\":[]}}`. Give it\n\
           the globs it owns so two workers never edit the same file. Repeat per stream.\n\
         - THEN start it: `bsc fleet wake <projectKey>:<stream-id>`. A wake REFUSES a stream plan.db\n\
           does not name, so creating it first is the whole prerequisite. See the fleet with\n\
           `bsc fleet list`.\n\
         - Record what you decide with `bsc plan decision`, citing the authority clause it rests on.\n\
         - A tooling gap a worker files (`bsc plan request`) is yours to judge and escalate.\n"
    )
}

/// Which panes to report on. Empty ⇒ every pane the app tracks.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct FleetRequest {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub pane_ids: Vec<String>,
}

/// One pane's real runtime state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaneLive {
    pub pane_id: String,
    /// A PTY session exists for this pane — `pty_create` would RECONNECT rather than launch.
    pub live: bool,
    /// Its shell has at least one live descendant, i.e. something is actually running in it. Distinct
    /// from `live`: an idle-but-open session is `live: true, busy: false`.
    ///
    /// ANSWERS "may I type at this prompt", NOT "is the agent working". A shell mid-build is busy and
    /// has no agent; a sandboxed pane is busy at a bare prompt, because its own `bwrap` plumbing and
    /// the shell inside it are both descendants. Use `agent` for the second question.
    pub busy: bool,
    /// The agent is RUNNING something — it has spawned a child of its own (a tool call, a build).
    ///
    /// This is what `bsc session list` reports as `BUSY`, and it exists because neither field around it
    /// can answer that question. `busy` is permanently true for an agent session (the agent is itself a
    /// descendant, so it restates `live`); `agent` reports that an agent is PRESENT, which an idle one
    /// equally is. Measured on an idle designer whose entire tree was `bash → claude` at its prompt:
    /// both read true, and the session looked mid-task while it sat waiting for input.
    ///
    /// LIMIT, stated because it is invisible otherwise: an agent waiting on a model response has no
    /// child either, so it reads `false`. This means "running something", not "occupied".
    ///
    /// `#[serde(default)]` so an older app answering a newer CLI degrades to "not working" rather than
    /// failing to parse — the same safe direction `agent` takes.
    #[serde(default)]
    pub working: bool,
    /// An AGENT process is running for this pane — `claude`, `bsc-agent`, or a wrapper hosting one.
    ///
    /// This is what makes `bsc fleet list` say `running` rather than `idle`, and it is a different
    /// probe from `busy` for the reason above. `#[serde(default)]` so an older app answering a newer
    /// CLI degrades to "no agent seen" rather than failing to parse — and the table then says `idle`,
    /// which is the safe direction: it prompts a wake rather than suppressing one.
    #[serde(default)]
    pub agent: bool,
    /// The session's OS process id, when the app has one. Answers the original report's "diagnosing
    /// this required dropping out to tasklist" without a second tool.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
}

/// The app's answer.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct FleetResult {
    pub panes: Vec<PaneLive>,
}

/// Ask the app to WAKE a pane (#4101) — the director's one lever over a parked worker.
///
/// Waking is not answerable in Rust like [`FleetRequest`] is: `wakePane` is a frontend store action
/// (it clears the dormant/ended marks, bakes the startup prompt, and bumps the owning tab's runId), so
/// this rides the same emit-and-ack round trip `bsc navigate` uses.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WakeRequest {
    pub pane_id: String,
    /// What to say to the woken session. Empty ⇒ the app supplies its standard change-request wake, so
    /// a director does not have to reproduce that prose to use the command.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub prompt: String,
    /// Wake even when the pane is BUSY. Waking kills the PTY first, so interrupting real work is a
    /// deliberate act, not a default.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub force: bool,
}

/// What actually happened.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WakeResult {
    pub pane_id: String,
    /// `wakePane`'s own verdict. FALSE means the pane could not be resolved — no open tab left to
    /// recreate it in, or a stream neither the roster nor plan.db names. (A DISABLED pane is REVIVED,
    /// not a cause of FALSE — `a-wake-revives-a-disabled-pane`.) It must reach the caller as an error,
    /// because the wake path kills the PTY BEFORE relaunching: a false reported as success leaves a
    /// dead worker and a caller who believes it is running. That was #4025, where the Wake button
    /// killed every parked worker silently for exactly this reason.
    pub woke: bool,
    /// Whether the pane had something running when the wake landed — so an interrupt is visible in the
    /// reply rather than inferred.
    #[serde(default)]
    pub was_busy: bool,
}

#[cfg(test)]
mod tests {

    /// The director must be told how the fleet it wakes COMES TO EXIST.
    ///
    /// Observed on twitter-clone-test: the kickoff said "You may START a worker that is parked
    /// (`bsc fleet wake <pane>`)" and never said a stream has to exist first, or how to make one.
    /// `bsc plan fleet get` returned `(no fleet)`, `bsc fleet wake` refuses a stream plan.db does not
    /// name, and the director — a 9B — spent its whole 60-step budget scouting and then wrote a README
    /// listing options instead of creating a single stream. It had no instruction out of the wall.
    #[test]
    fn the_director_kickoff_states_the_stream_prerequisite() {
        let k = super::discovery_kickoff("demo");
        assert!(k.contains("bsc plan fleet stream set"), "it names the verb that CREATES a stream");
        assert!(k.contains("CREATING THE FLEET IS YOURS"), "and that the job is the director's");
        assert!(k.contains("(no fleet)"), "and that an empty fleet is the normal starting state");
        // The ORDER is the part that was missing: create, then wake.
        let create = k.find("bsc plan fleet stream set").expect("create verb present");
        let wake = k.rfind("bsc fleet wake").expect("wake verb present");
        assert!(create < wake, "the kickoff must teach create BEFORE wake");
        // The example must RENDER as real JSON. It is inside a `format!` in a quoted string, so the
        // braces need doubling and the quotes escaping — both of which were wrong on the first two
        // attempts, and a half-escaped example is worse than none for a model that copies it.
        assert!(
            k.contains(r#"{"id":"<id>","repo":"<owner/repo>""#),
            "the JSON example must render unescaped:\n{k}",
        );
        assert!(!k.contains("{{"), "no unresolved format braces reached the prompt");
        assert!(!k.contains("\\\""), "no unresolved backslash-quotes reached the prompt");
    }

    use super::*;

    /// The app deserializes `FleetRequest` from the envelope payload and the CLI deserializes
    /// `FleetResult` back, so both directions must survive a JSON round trip verbatim — a rename on one
    /// side would otherwise show up as "every pane is gone", which is exactly the wrong answer for a
    /// command whose whole job is reporting liveness.
    #[test]
    fn the_wire_contract_round_trips() {
        let req = FleetRequest { pane_ids: vec!["k:director".into(), "k:worker".into()] };
        let back: FleetRequest = serde_json::from_str(&serde_json::to_string(&req).unwrap()).unwrap();
        assert_eq!(back, req);

        let res = FleetResult {
            panes: vec![
                PaneLive { pane_id: "k:director".into(), live: true, busy: true, agent: true, working: true, pid: Some(4242) },
                PaneLive { pane_id: "k:worker".into(), live: false, busy: false, agent: false, working: false, pid: None },
            ],
        };
        let json = serde_json::to_string(&res).unwrap();
        // camelCase on the wire — the field is `paneId`, matching every other appchan result.
        assert!(json.contains("\"paneId\""), "{json}");
        assert_eq!(serde_json::from_str::<FleetResult>(&json).unwrap(), res);
    }

    /// An empty request must serialize to an EMPTY object, not `{"pane_ids":[]}` — the app reads absent
    /// as "report everything", and a `[]` that survived would silently mean "report nothing".
    #[test]
    fn an_empty_request_asks_for_everything() {
        let json = serde_json::to_string(&FleetRequest::default()).unwrap();
        assert_eq!(json, "{}", "an empty ask must not serialize a pane list");
        assert!(serde_json::from_str::<FleetRequest>("{}").unwrap().pane_ids.is_empty());
    }

    /// The wake contract is a CROSS-PROCESS wire: `bsc` serializes the request, the app deserializes
    /// it, and the reply travels back the same way. A rename on either side silently degrades to the
    /// serde default — a `force` that stopped arriving would turn every busy refusal into an
    /// interrupt, so the field names are pinned here rather than trusted to review.
    #[test]
    fn the_wake_wire_round_trips_by_name() {
        let req = WakeRequest { pane_id: "proj:api".into(), prompt: "rebase".into(), force: true };
        let v = serde_json::to_value(&req).unwrap();
        assert_eq!(v["paneId"], "proj:api");
        assert_eq!(v["prompt"], "rebase");
        assert_eq!(v["force"], true);
        assert_eq!(serde_json::from_value::<WakeRequest>(v).unwrap(), req);

        // The common case stays terse — an omitted prompt/force must decode to "app default, refuse
        // if busy", never to a silent force.
        let bare: WakeRequest = serde_json::from_value(serde_json::json!({"paneId": "p"})).unwrap();
        assert!(bare.prompt.is_empty() && !bare.force);
        assert_eq!(serde_json::to_value(&bare).unwrap().as_object().unwrap().len(), 1);

        let res = WakeResult { pane_id: "proj:api".into(), woke: true, was_busy: true };
        let rv = serde_json::to_value(&res).unwrap();
        assert_eq!(rv["woke"], true);
        assert_eq!(rv["wasBusy"], true);
        assert_eq!(serde_json::from_value::<WakeResult>(rv).unwrap(), res);
    }

    /// The start contract is a CROSS-PROCESS wire: `bsc` serializes the request, the app
    /// deserializes it, and the reply comes back the same way. A rename on either side is invisible
    /// to the compiler and shows up as a launch that silently does nothing.
    #[test]
    fn the_start_contract_round_trips() {
        let req = StartRequest { project_key: "my-app".into(), force: true };
        let back: StartRequest = serde_json::from_str(&serde_json::to_string(&req).unwrap()).unwrap();
        assert_eq!(back, req);

        let res = StartResult {
            project_key: "my-app".into(),
            outcome: StartOutcome::Launched,
            director: true,
            streams: vec!["api".into(), "ui".into()],
            skipped_no_repo: vec!["docs".into()],
        };
        let back: StartResult = serde_json::from_str(&serde_json::to_string(&res).unwrap()).unwrap();
        assert_eq!(back, res);
    }

    /// The field names the app reads. camelCase on the wire, like every other appchan payload — a
    /// snake_case `project_key` would deserialize to the empty default and the app would refuse the
    /// launch with "no project key" for a request that named one.
    #[test]
    fn the_start_request_is_camel_case_on_the_wire() {
        let json = serde_json::to_value(StartRequest {
            project_key: "my-app".into(),
            force: false,
        })
        .unwrap();
        assert_eq!(json["projectKey"], "my-app");
        // `force` is skipped when false, so the common request stays minimal.
        assert!(json.get("force").is_none(), "a default force must not be sent: {json}");

        let res = serde_json::to_value(StartResult {
            project_key: "k".into(),
            outcome: StartOutcome::AlreadyRunning,
            director: false,
            streams: vec![],
            skipped_no_repo: vec![],
        })
        .unwrap();
        assert_eq!(res["projectKey"], "k");
        assert_eq!(res["outcome"], "alreadyRunning");
        // An empty skip list is omitted rather than sent as [] — nothing was skipped.
        assert!(res.get("skippedNoRepo").is_none());
    }

    /// `start` must not share a routing key with the other fleet verbs: they take different request
    /// shapes AND different paths through the app, so a collision would hand a launch to the liveness
    /// reader and answer it with a pane list.
    #[test]
    fn start_has_its_own_routing_key() {
        assert_eq!(START_KIND, "fleet-start");
        for other in [KIND, WAKE_KIND, DIRECTOR_KIND] {
            assert_ne!(START_KIND, other);
        }
    }

    /// `wake` must not share `list`'s routing key: they take different request shapes AND different
    /// paths through the app (frontend ack vs pure Rust), so a collision would hand a wake to the
    /// lister and answer with an empty pane list instead of failing.
    #[test]
    fn wake_routes_separately_from_list() {
        assert_ne!(KIND, WAKE_KIND);
    }
}
