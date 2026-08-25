use crate::prelude::*;
use crate::fleet::protocols::append_section_once;

/// Director protocol (#375) appended to the project hub's CLAUDE.local.md so the
/// async-integrator director always has its standing duties as authoritative context
/// (it runs at the hub, so it never gets the worker worktree protocol). Loaded at runtime via
/// [`crate::platform::config::load_str`] (#2027 P2) — the user's `fleet/director-protocol.md` under
/// the config dir if present, else the embedded seed.
pub(crate) fn director_protocol_md() -> String {
    crate::platform::config::load_str("fleet/director-protocol.md")
}

/// Ensure the project hub's CLAUDE.local.md carries the director protocol (#375). Idempotent.
#[tauri::command]
pub(crate) fn ensure_director_protocol(project_key: String) -> Result<(), String> {
    let local = project_dir(&project_key).join("CLAUDE.local.md");
    if let Some(parent) = local.parent() { let _ = std::fs::create_dir_all(parent); }
    // Both sections are appended verbatim only when their marker is absent (idempotent), via the
    // shared helper — no scattered read-modify-write blocks. Errors propagate (this is a command).
    append_section_once(&local, "## Director protocol", &director_protocol_md()).str_err()?;
    // Injection-resistance preamble (#1167): the director reads issue/PR prose + authors kickoffs,
    // so it's a high-value injection target — give it the same untrusted-input rules as workers.
    append_section_once(&local, INJECTION_RESISTANCE_MARKER, &injection_resistance_md()).str_err()?;
    Ok(())
}

#[cfg(test)]
mod relocated_tests {
    #![allow(unused_imports)]
    use super::*;
    use crate::testutil::prelude::*;

    /// #the-fleet-went-pull-but-nobody-told-the-director-to-pull.
    ///
    /// The app stopped pushing prompts into sessions, but this file still described the push world:
    /// a worker's question "arrives as a `[coordinator] <session> asks: ...` message". Nothing
    /// arrives. A director waiting on a channel that was switched off never sweeps a parked worker,
    /// and the fleet reads as stalled for no reason.
    ///
    /// Stale prose is the whole failure mode here, so it is guarded as prose.
    #[test]
    fn director_protocol_tells_the_director_to_look_rather_than_wait() {
        let p = crate::platform::config::embedded_str("fleet/director-protocol.md");

        // The PULL is named, in this file — not only in a prompt builder of a pump that is inert.
        assert!(p.contains("logs waiting"),
            "the director must be told to sweep `bsc logs waiting`; it is the queue that replaced the push");

        // And the promise of delivery is GONE. Guarding its absence is the point: a director told a
        // message will arrive will wait for one.
        assert!(!p.contains("asks: ...\" message") && !p.contains("asks: ...' message"),
            "the protocol must not promise that a worker's question arrives as a message");

        // The superseded roster helper must not be the one it reaches for first: it cannot see the
        // request lane or the permission-prompt signal, which are two of the four queue kinds.
        assert!(!p.contains("Run `bsc-fleet` from the project hub"),
            "the roster instruction must name `bsc fleet list`, not the superseded bsc-fleet helper");
    }

    /// #captured-issues-and-briefs-have-no-queue-to-pull-from.
    ///
    /// Both these bullets used to point at `bsc logs coord` — a raw replayed feed with no notion of
    /// which rows are still OPEN, so a director re-read every issue it had already routed on every
    /// sweep. Stale prose is the failure mode here: a director told to read a feed will read a feed.
    #[test]
    fn director_protocol_points_at_the_pending_queue_not_the_raw_feed() {
        let p = crate::platform::config::embedded_str("fleet/director-protocol.md");

        assert!(p.contains("logs pending"), "the routing queue must be named");
        // The two bullets it replaced. `logs coord` may still appear elsewhere (it is a legitimate
        // raw reader), but never as the way to find an issue or a brief.
        for stale in [
            "read it with `$BSC_BIN logs coord`",
            "`$BSC_BIN logs coord` is where you find one",
        ] {
            assert!(!p.contains(stale), "a queue exists now; the feed must not be the instruction: {stale}");
        }

        // The CLOSING half of each. A queue whose rows are never closed is the feed again with extra
        // steps — and neither close is guessable: an assign silently closes nothing without --issue,
        // and a brief has exactly one closing verb.
        assert!(p.contains("--issue"), "the assign must be told to carry the id back");
        assert!(p.contains("bsc-brief-done"), "a brief's only closing verb must be named");
        assert!(
            p.contains("reconciled, nothing to do"),
            "closing a brief that needed no change is the case a director will otherwise skip"
        );
    }

    /// Staffing includes WHICH MODEL, and the director is the one who staffs.
    ///
    /// Both verbs have to be named, because they are not interchangeable: `bsc persona model` moves an
    /// identity's default in every team that places it, and `bsc teams model` overrides one placement.
    /// A director told only about the first would make one team cheap by changing every team that
    /// shares the persona — which is exactly the mistake the placement override exists to prevent.
    #[test]
    fn director_protocol_names_both_model_verbs_and_which_one_scopes_to_a_team() {
        let p = crate::platform::config::embedded_str("fleet/director-protocol.md");
        assert!(p.contains("bsc persona model"), "the identity-wide default verb must be named");
        assert!(p.contains("bsc teams model"), "the per-placement override verb must be named");
        // The tier vocabulary the CLI actually accepts — a protocol naming one it would refuse is
        // worse than naming none.
        for tier in bsc_util::model_ids() {
            assert!(p.contains(tier), "the protocol names the tier `{tier}` the CLI accepts");
        }
    }

    /// #fleet-list-cannot-see-a-stopped-worker.
    ///
    /// `bsc fleet list` reported only what the app was tracking, so a stopped worker had no row at
    /// all — on network-monitor a director with 38 streams saw one row, itself. The command now takes
    /// membership from plan.db, and this prose is what tells the director the table is the WHOLE fleet
    /// rather than the running part of it. Stale prose here is worse than none: a director that reads
    /// a four-row table as "these are my workers" never wakes the other thirty-four.
    #[test]
    fn director_protocol_says_the_fleet_list_includes_workers_that_are_not_running() {
        let p = crate::platform::config::embedded_str("fleet/director-protocol.md");

        assert!(p.contains("running or not") || p.contains("running or NOT"),
            "the director must be told the list covers workers that are NOT running");

        // All four states, by the name the command prints — a director matching prose to output is
        // how a state gets acted on, and `never-launched` is the one whose move is different.
        for state in ["`running`", "`idle`", "`stopped`", "`never-launched`"] {
            assert!(p.contains(state), "the protocol must name the {state} state");
        }

        // The two moves must stay distinct. A never-launched stream has no session, so waking it does
        // nothing; pointing a director at `wake` for it is the failure this separation prevents.
        assert!(p.contains("bsc fleet start"),
            "a never-launched stream needs a launch, not a wake — the protocol must say so");
    }

    /// The same file said `bsc-assign` "resumes the chosen worker" in one bullet and "does NOT resume
    /// the worker" in another, twenty lines apart. A director acting on the first leaves work sitting
    /// in an inbox nobody opens.
    #[test]
    fn director_protocol_does_not_claim_assign_resumes_a_worker() {
        let p = crate::platform::config::embedded_str("fleet/director-protocol.md");
        assert!(!p.contains("That resumes the chosen worker"),
            "bsc-assign delivers to the inbox; it does not resume — follow it with `bsc fleet wake`");
    }

    #[test]
    fn director_protocol_assigns_contract_ownership() {
        // The director owns the integration contracts and is the worker's help desk for them. That
        // survives the funnel: answering from a contract is deciding, and deciding is the one thing
        // the director keeps.
        let p = crate::platform::config::embedded_str("fleet/director-protocol.md");
        assert!(p.contains("contracts/") || p.contains("contracts directory") || p.contains("INTEGRATION CONTRACTS"),
            "director protocol must claim ownership of the contracts directory");
    }

    #[test]
    fn director_protocol_routes_the_doing_duties_rather_than_performing_them() {
        // #funnel-commons-and-integration-streams. The director loses write, so its three DOING
        // duties become lanes: the commons lane owns the repo-root commons, the integration lane owns
        // the integration branch (merges, the revert, the seam tests). This replaces the assertions
        // that guarded `OWN ALL GITHUB` / `gh pr merge` ownership — under local-first there are no PRs
        // to own, so that clause is not narrowed, it is vacuous.
        let p = crate::platform::config::embedded_str("fleet/director-protocol.md");

        // The GitHub-ownership clause is GONE, not reworded. Guarding its absence is the point: a
        // director that still believes it merges PRs will sit waiting for PRs that never open.
        assert!(!p.contains("OWN ALL GITHUB"),
            "the OWN ALL GITHUB section must be removed -- local-first has no PRs to review or merge");
        assert!(!p.contains("gh pr merge"),
            "the director must not be told to merge PRs; it holds no GitHub write under the funnel");

        // Commons: routed to the lane, and explicitly NOT applied by the director itself.
        assert!(p.contains("ROUTE THE COMMONS"),
            "director protocol must carry the commons ROUTING section");
        assert!(p.contains("COMMONS lane"),
            "the commons must be attributed to the commons lane, not to the director");
        assert!(p.contains("never edit one yourself"),
            "the director must be told it no longer edits a commons file");

        // Integration: the revert and the seam tests both belong to the integration lane.
        assert!(p.contains("WATCHDOG -- ROUTE THE REVERT"),
            "the watchdog duty must be a routing instruction, not a revert the director performs");
        assert!(p.contains("INTEGRATION lane"),
            "the revert must be routed to the integration lane");
        assert!(p.contains("TEST THE INTEGRATIONS"),
            "integration testing must still be mandated -- as a routed duty");

        // Both duties route through the same emitter every other dispatch uses.
        assert!(p.contains("bsc-assign"),
            "routed duties reach their lane via bsc-assign");
    }

    #[test]
    fn director_protocol_tells_it_how_to_reach_the_architect() {
        // Same shape as the test below, and the same diagnosis: the capability was already there and
        // the protocol never said so. The director is not a restricted role, and `bsc` is
        // mandatory-tier, so `bsc session list` and `bsc session ask architect` have always been
        // permitted — the live Network Monitor director's settings.json carries `Bash(bsc *)`. What
        // it had was a channel it could only RECEIVE on: a brief is explicitly information rather
        // than a question, and `bsc plan request` was worked BY the director, so filing one
        // addressed it to itself.
        let p = crate::platform::config::embedded_str("fleet/director-protocol.md");

        // The VIEW upward — the twin of looking down at its own workers.
        assert!(p.contains("session list"), "the director must be told how to SEE the architect");
        // The CALL: an answer it can act on this turn.
        assert!(
            p.contains("session ask architect"),
            "the director must be told how to ASK the architect and get an answer back",
        );
        // The CONTRACT: a decision that outlives the turn.
        assert!(
            p.contains("--to architect"),
            "…and how to file something that must not be lost when its turn ends",
        );
        // The two are for different things, and choosing wrong is the failure worth naming.
        assert!(
            p.contains("ask when you need an answer to keep going"),
            "the protocol must say WHICH to reach for, not just that both exist",
        );
        // The queue is pull, like every other queue the director works.
        assert!(
            p.contains("request list --to architect"),
            "nothing surfaces an upward request either — say so, or it waits forever",
        );
        // And the boundary, so the lane is not used to hand its own work upward.
        assert!(
            p.contains("Anything inside this project is YOURS"),
            "an upward lane without a boundary becomes a way to stall your own work",
        );
    }

    #[test]
    fn director_protocol_takes_team_design_and_the_worker_context() {
        // #funnel-planner-takes-team-and-context. The director staffs the fleet and authors the context
        // its workers run under, from the architect's sealed requirement. Its capability row already
        // permitted all of this (`bsc` is mandatory-tier, and `code: write` covers the hub prose) — what
        // was missing was the protocol saying it is the director's JOB, which is what this guards.
        let p = crate::platform::config::embedded_str("fleet/director-protocol.md");

        // The requirement is the director's ONLY input, and it must read it before anything else.
        assert!(p.contains("bsc plan requirement get"),
            "the director must read the architect's requirement, by name");
        assert!(p.contains("You do NOT talk to the"),
            "the director must be told it never converses with the user");
        assert!(p.contains("do not infer one from the repo"),
            "a missing requirement must stop the director, not license it to guess one");

        // Team design: the discover-before-write loop, over both stores.
        assert!(p.contains("DESIGN THE TEAM"), "team design must be a standing director duty");
        assert!(p.contains("bsc persona list") && p.contains("bsc teams list"),
            "the director must discover existing personas + teams before authoring");
        assert!(p.contains("never guess an id"),
            "the director must be told not to invent store ids");

        // The context files, and the boundary on the write grant that lets it author them.
        assert!(p.contains("AUTHOR THE WORKER CONTEXT FILES"),
            "authoring the workers' context must be a standing director duty");
        assert!(p.contains("prompts/<stream>-kickoff.md"),
            "the director must know which files it authors");
        assert!(p.contains("It does NOT reach") && p.contains("project code"),
            "the write grant must be bounded in the same breath it is granted");
    }

    #[test]
    fn director_protocol_decides_under_authority_and_parks_when_it_has_none() {
        // #funnel-unattended-director. The protocol must carry BOTH halves, because either alone is
        // unsafe: authority without the park rule licenses guessing, and the park rule without
        // authority stalls the pipeline on the first unspecified thing.
        let p = crate::platform::config::embedded_str("fleet/director-protocol.md");

        assert!(p.contains("DECIDE UNDER AUTHORITY, AND CITE IT"),
            "deciding under authority must be a standing duty, not an aside");
        assert!(p.contains("bsc plan decision authority"),
            "the director must be told how to read what it may decide BEFORE deciding");
        assert!(p.contains("bsc plan decision add"),
            "every derived decision must be recorded against its clause");

        // The other half: no clause ⇒ park, and it is the user's inbox that surfaces it.
        assert!(p.contains("DO NOT GUESS"), "an uncovered decision must not be guessed");
        assert!(p.contains("bsc-wait") && p.contains("Coordination inbox"),
            "an uncovered decision must park and surface where the user can see it");
        assert!(p.contains("parks on the FIRST such decision"),
            "a project with NO authority must park immediately rather than run ahead");

        // The transformation queue is the deliberate EXCEPTION — stated in the same document, or a
        // reader generalizes the new authority rule straight onto the highest-blast-radius gate.
        assert!(p.contains("ONE gate that granted") && p.contains("does NOT open by default"),
            "the transformation queue must be named as the exception to authority-governed advance");
        assert!(p.contains("reverse-scopes a"),
            "the exception must carry its REASON, not just the rule");
    }

    #[test]
    fn director_protocol_reports_an_undelivered_assign_to_a_stopped_lane() {
        // The commons + integration lanes are ORDINARY streams that stop when done, so the honesty
        // rule stops being advice and becomes the only thing preventing silent loss: a worker parked
        // on bsc-ask for a commons change is waiting on a lane that may have ended.
        let p = crate::platform::config::embedded_str("fleet/director-protocol.md");
        assert!(p.contains("not delivered"),
            "an assign to a stopped session must be described as undelivered");
        assert!(p.contains("BLOCKED"),
            "a commons change whose lane has stopped must be reported as blocked, not as landed");
    }

    #[test]
    fn director_protocol_routes_confirmed_transformations() {
        // #2509 slice (e): the director dispatches ONLY confirmed transformation rows, in
        // dependency order, via the existing bsc-issue + bsc-assign loop — the user's confirm
        // queue is the uniform gate. Guard the standing protocol says exactly that.
        let p = crate::platform::config::embedded_str("fleet/director-protocol.md");
        assert!(p.contains("ROUTE CONFIRMED TRANSFORMATIONS"),
            "director protocol must carry the confirmed-transformations routing section (#2509)");
        assert!(p.contains("bsc plan transformation list"),
            "director must read the transformation list from plan.db");
        // Confirmed-only: it dispatches rows with confirmed:true and NEVER confirms (the user's gate).
        assert!(p.contains("confirmed: true") && p.contains("NEVER confirm"),
            "director routes only confirmed rows and never confirms one itself");
        // Ordering: tier + dependsOn, foundation-first waves.
        assert!(p.contains("dependsOn") && p.contains("tier"),
            "director must respect tier + dependsOn ordering when routing transformations");
        // Reuses the existing capture-and-route loop.
        assert!(p.contains("bsc-issue") && p.contains("bsc-assign"),
            "director routes confirmed transformations through the existing bsc-issue + bsc-assign loop");
    }
    #[test]
    fn director_protocol_includes_injection_resistance() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = temp_home("dirproto");
        let key = "proj-dir".to_string();
        ensure_director_protocol(key.clone()).unwrap();
        let md = std::fs::read_to_string(project_dir(&key).join("CLAUDE.local.md")).unwrap();
        assert!(md.contains("## Director protocol"), "director protocol present");
        assert!(md.contains(INJECTION_RESISTANCE_MARKER), "director also gets the injection-resistance preamble");
        // Idempotent — a second ensure doesn't duplicate either section.
        ensure_director_protocol(key.clone()).unwrap();
        let again = std::fs::read_to_string(project_dir(&key).join("CLAUDE.local.md")).unwrap();
        assert_eq!(again.matches(INJECTION_RESISTANCE_MARKER).count(), 1);
        std::fs::remove_dir_all(&home).ok();
    }
}
