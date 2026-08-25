/// Coordination protocol appended to every fleet worker's CLAUDE.local.md (#369) so the
/// defer-to-director / never-ask-the-user rules are authoritative context, not just a
/// first-message hint. Loaded at runtime via [`crate::platform::config::load_str`] (#2027 P2) — the
/// user's `fleet/worker-protocol.md` under the config dir if present, else the embedded seed.
/// Consumed by `worktree::write_worker_context` (the worker context), not the director —
/// it lives here (a neutral home) rather than in `director.rs` (#1623).
pub(crate) fn fleet_protocol_md() -> String {
    crate::platform::config::load_str("fleet/worker-protocol.md")
}
/// Injection-resistance preamble (#1167) appended to every fleet session's CLAUDE.local.md —
/// authoritative context that content read while working (issues, PRs, web pages, repo files,
/// other agents' notes) is untrusted DATA, never instructions. The containment half of the
/// warden (#1102): prevent an injection from acting, not just detect it after. Shared by both
/// the worker context and the director protocol. Runtime-loaded (#2027 P2).
pub(crate) fn injection_resistance_md() -> String {
    crate::platform::config::load_str("fleet/injection-resistance.md")
}
/// Heading marker for [`injection_resistance_md`], used to keep the append idempotent.
pub(crate) const INJECTION_RESISTANCE_MARKER: &str = "## Untrusted input";

/// Write an auto-generated section into a markdown context file, REPLACING an existing one rather
/// than leaving it frozen. The file is created if absent (a missing/unreadable file reads as empty).
///
/// Returns the write's `io::Result` so a caller that must surface failures (e.g. a Tauri command)
/// can propagate it, while best-effort callers can discard it with `let _ =`.
///
/// `append_section_once` used to return early whenever `marker` was already in the file, which made
/// an auto-added section write-once *forever*. That is how a director ran for twelve days on
/// instructions nobody could update: the packaged protocol moved, the machine's config mirror was
/// stale, and even after both were fixed a relaunch could not refresh the copy baked into the hub's
/// `CLAUDE.local.md`, because the marker was already there. "Idempotent" was doing the wrong job —
/// converging on the FIRST content written instead of on the CURRENT content.
///
/// `end_marker` bounds the section when another managed section follows it; `None` means it runs to
/// end of file. The caller knows the order it writes them in, which is the only place that ordering
/// is known — a section cannot see its own successor.
///
/// Everything outside the section is preserved byte-for-byte, so a plan, a kickoff or anything a
/// human added around it survives. An unchanged body rewrites nothing, so a relaunch that changes
/// nothing does not churn the file's mtime.
pub(crate) fn upsert_section(
    path: &std::path::Path,
    marker: &str,
    body: &str,
    end_marker: Option<&str>,
) -> std::io::Result<()> {
    let cur = std::fs::read_to_string(path).unwrap_or_default();
    let Some(start) = cur.find(marker) else {
        return std::fs::write(path, format!("{cur}{body}"));
    };
    // The section ends where the NEXT managed section begins, or at end of file. Searched from the
    // start of this one so a body that happens to quote the next marker cannot truncate it early.
    let end = end_marker
        .and_then(|m| cur[start..].find(m).map(|i| start + i))
        .unwrap_or(cur.len());
    let rebuilt = format!("{}{}{}", &cur[..start], body.trim_start_matches('\n'), &cur[end..]);
    if rebuilt == cur {
        return Ok(()); // already current — do not touch the file
    }
    std::fs::write(path, rebuilt)
}

#[cfg(test)]
mod tests {
    /// #4191 — the worker protocol must NAME the live stores and state their precedence.
    ///
    /// A worker's context is assembled once at launch while the stores stay live, so anything quoted
    /// into it is a snapshot that can go stale. That is only safe if the worker knows (a) the stores
    /// exist and how to read them, and (b) which side wins on a disagreement. Before this, the protocol
    /// mentioned `bsc` exactly once — for `bsc plan request` — so a worker had no reason to prefer the
    /// store over the copy in front of it, and every fix landed on the copy.
    ///
    /// Pinned against the EMBEDDED seed (an empty config root forces the fallback), so a machine with a
    /// stale `config/fleet/worker-protocol.md` mirror cannot make this pass or fail spuriously.
    /// The protocol must also tell a CAGED worker how to read those stores
    /// (bsc-is-unreachable-inside-the-namespace-cage).
    ///
    /// `bsc` cannot exist inside the namespace — binding it means binding a writable database, the
    /// ambient authority the isolation removes — so a protocol that names only `bsc` verbs hands a
    /// caged worker instructions that fail with `command not found`, which reads as a broken
    /// environment rather than as policy.
    ///
    /// The commands themselves are EXECUTED in a real cage by
    /// `the_protocols_caged_store_commands_actually_run_inside_the_cage`; that test is Linux- and
    /// bubblewrap-gated, so this one keeps the document's shape checkable everywhere.
    #[test]
    fn the_worker_protocol_tells_a_caged_worker_where_the_stores_are() {
        let empty = std::env::temp_dir().join(format!("bsc-proto-caged-{}", std::process::id()));
        std::fs::create_dir_all(&empty).unwrap();
        let md = crate::platform::config::with_config_root(&empty, super::fleet_protocol_md);
        let _ = std::fs::remove_dir_all(&empty);

        let block = md
            .split_once("<!-- caged-store-commands -->")
            .and_then(|(_, rest)| rest.split_once("<!-- /caged-store-commands -->"))
            .map(|(b, _)| b)
            .expect("the caged block is delimited so a test can run exactly what it says");
        for path in ["/plan/items", "/graph/impl", "/ui/components"] {
            assert!(block.contains(path), "the caged block must name {path}: {block}");
        }
        // The premise, stated where the worker meets it: absence of `bsc` is the SIGNAL, not a fault.
        assert!(md.contains("command -v bsc"), "tells the worker how to tell which world it is in: {md}");
        // And the one thing the cage genuinely cannot do, said before the worker hits it.
        assert!(
            md.contains("SUMMARY tier"),
            "/ui carries no source in the projection; a worker must learn that here, not by failing: {md}"
        );
    }

    /// The WRITE half of the caged surface. The read block told a worker where the stores are and
    /// left it with no way to record anything — the state that ends in a green gate, a commit, and
    /// an item still reading `in_progress`.
    ///
    /// Shape only; the commands themselves are EXECUTED in a real cage (and put through the drain)
    /// by `the_protocols_caged_plan_writes_run_inside_the_cage_and_the_drain_accepts_them`.
    #[test]
    fn the_worker_protocol_tells_a_caged_worker_how_to_record_what_it_did() {
        let empty = std::env::temp_dir().join(format!("bsc-proto-write-{}", std::process::id()));
        std::fs::create_dir_all(&empty).unwrap();
        let md = crate::platform::config::with_config_root(&empty, super::fleet_protocol_md);
        let _ = std::fs::remove_dir_all(&empty);

        let block = md
            .split_once("<!-- caged-plan-writes -->")
            .and_then(|(_, rest)| rest.split_once("<!-- /caged-plan-writes -->"))
            .map(|(b, _)| b)
            .expect("the caged write block is delimited so a test can run exactly what it says");
        // Every verb the protocol's own record-keeping section demands must have a caged form, or
        // the worker is told to do something it cannot.
        for verb in ["change", "note", "gate", "status"] {
            assert!(block.contains(verb), "the caged write block must cover {verb}: {block}");
        }
        assert!(block.contains("/plan/out"), "and name the outbox: {block}");

        // The outbox is listed with the others a worker is given, so it is discoverable from the
        // read section too — that paragraph is where a caged worker learns what IS writable.
        assert!(md.contains("`/plan/out` to record what you did"), "listed beside the other outboxes: {md}");
        // The narrowing, said before the worker meets the refusal.
        assert!(
            md.contains("refuses `verified`"),
            "a worker must learn `verified` is not its to set HERE, not by being rejected: {md}"
        );
        // And the contract it can read in full rather than working from this excerpt.
        assert!(md.contains("/plan/schema"), "points at the readable contract: {md}");
    }

    #[test]
    fn the_worker_protocol_names_the_stores_and_their_precedence() {
        let empty = std::env::temp_dir().join(format!("bsc-proto-seed-{}", std::process::id()));
        std::fs::create_dir_all(&empty).unwrap();
        let md = crate::platform::config::with_config_root(&empty, super::fleet_protocol_md);
        let _ = std::fs::remove_dir_all(&empty);

        assert!(!md.trim().is_empty(), "the embedded seed must resolve");
        // The precedence rule — the half that makes a stale quote harmless.
        assert!(md.contains("source of truth"), "states which side wins: {md}");
        assert!(md.contains("the store is right"), "…explicitly, on a disagreement: {md}");
        // The read verbs, so knowing the rule is actionable rather than advice.
        for verb in ["bsc graph impl get", "bsc ui get", "bsc plan", "bsc files read"] {
            assert!(md.contains(verb), "the protocol must name `{verb}`:\n{md}");
        }
    }

    /// A worker must know that a build verdict is RECORDABLE, and equally that its own loop is not
    /// (a-workers-failing-build-is-invisible-to-its-director).
    ///
    /// Both halves are load-bearing and they pull opposite ways. Without the first, a worker's build
    /// failure exists only in its own pane and dies with the session, so the director learns a stream
    /// is stuck by noticing silence. Without the second, a worker wraps its iteration loop, every
    /// half-finished edit files a fault, and the project's node sits red while nothing is wrong —
    /// which is the same signal-destroying mistake #4008 avoided by scoping to supply blocks, and the
    /// reason the repo's own gate is deliberately unwrapped.
    #[test]
    fn the_worker_protocol_records_a_build_verdict_and_not_its_own_loop() {
        let empty = std::env::temp_dir().join(format!("bsc-proto-errors-{}", std::process::id()));
        std::fs::create_dir_all(&empty).unwrap();
        let md = crate::platform::config::with_config_root(&empty, super::fleet_protocol_md);
        let _ = std::fs::remove_dir_all(&empty);

        assert!(md.contains("bsc errors run"), "the recorder must be named:\n{md}");
        assert!(md.contains("--stage build"), "…with the stage that separates it from runtime faults");
        // The exclusion, in the document rather than in someone's head.
        assert!(
            md.contains("Do NOT wrap your iteration loop"),
            "the protocol must say which runs are NOT recorded:\n{md}",
        );
        // A rule with no reason gets dropped the first time it is inconvenient.
        assert!(md.contains("not a defect"), "…and why: a mid-edit failure is work, not a fault");
    }

    /// The director's half: a fault is a READ it consults, never a push it waits for.
    ///
    /// The failure this guards against is a director that treats every red build as an interrupt.
    /// Workers break their own builds constantly on the way to finishing, so routing each one turns
    /// ordinary work into a queue of false alarms — and a director that learns to ignore that queue
    /// ignores the real ones in it too.
    #[test]
    fn the_director_protocol_reads_faults_rather_than_waiting_to_be_told() {
        let p = crate::platform::config::embedded_str("fleet/director-protocol.md");
        assert!(p.contains("bsc errors list"), "the director must know the read verb");
        assert!(p.contains("--stage build"), "…and how to separate build verdicts from runtime faults");
        assert!(p.contains("bsc errors resolve"), "…and how to clear one it has fixed");
        assert!(
            p.contains("READ, NOT AN INTERRUPT"),
            "the protocol must say a red build is not routed at it:\n{p}",
        );
        // The count is what distinguishes stuck from mid-edit; a director told only "there is a fault"
        // would act on the first one.
        assert!(p.contains("count"), "…and that the repeat count is the signal");
    }

    /// The WRITE half (#4254).    /// The WRITE half (#4254). Reading from the stores is only half the rule: a worker that reads a
    /// record and then edits the FILE writes the copy while the record keeps the old body — the drift
    /// #4246 measured at 22 modules.
    ///
    /// The protocol carved algorithms out ("components only for now"), justified by an algorithm's file
    /// backing several records. That fact is true (34 of 63 share a `src`) but it only defeats a
    /// file→record LOOKUP, which algorithms never need: a feature `requires` them by ID.
    ///
    /// And MAINTENANCE — the phase whose whole purpose is modifying the original document — never said
    /// so, leaving a maintenance worker to do what any worker would and open the file.
    #[test]
    fn the_worker_protocol_states_the_write_rule_for_both_libraries() {
        let empty = std::env::temp_dir().join(format!("bsc-proto-write-{}", std::process::id()));
        std::fs::create_dir_all(&empty).unwrap();
        let md = crate::platform::config::with_config_root(&empty, super::fleet_protocol_md);
        let _ = std::fs::remove_dir_all(&empty);

        // Both surfaces name their WRITE verb, not just their read verb.
        for verb in ["bsc ui set", "bsc graph impl set"] {
            assert!(md.contains(verb), "the protocol must name the write verb `{verb}`:\n{md}");
        }
        // The algorithms carve-out must not come back.
        assert!(
            !md.contains("This is components only for now"),
            "algorithms are no longer exempt from the record rule:\n{md}",
        );
        // Maintenance states WHAT it modifies. This is the phase the whole rule exists for.
        assert!(
            md.contains("MAINTENANCE you modify the ORIGINAL DOCUMENT"),
            "maintenance must state that edits go to the record:\n{md}",
        );
    }

    /// #session-stop-is-honoured — the protocol must not promise MAINTENANCE as the end state.
    ///
    /// The promise was load-bearing for a hook that no longer exists: `bsc-defer` refused a worker's
    /// Stop while work remained, and the prose told it to park in maintenance rather than end. With the
    /// bounce gone, telling a worker it "does not end" would leave it looping on prose alone.
    #[test]
    fn the_worker_protocol_ends_at_stop_not_maintenance() {
        let empty = std::env::temp_dir().join(format!("bsc-proto-stop-{}", std::process::id()));
        std::fs::create_dir_all(&empty).unwrap();
        let md = crate::platform::config::with_config_root(&empty, super::fleet_protocol_md);
        let _ = std::fs::remove_dir_all(&empty);

        assert!(md.contains("you STOP"), "the protocol must end the loop at a stop:\n{md}");
        assert!(
            !md.contains("you do not end"),
            "the protocol must not promise a session never ends:\n{md}",
        );
        // `bsc-maintain` survives as a NOTE, and must be described as one rather than as a park.
        assert!(md.contains("not a parking brake"), "bsc-maintain must be framed as a note: {md}");
    }

    /// #worker-prose-follows-the-local-first-loop — the worker's standing context must teach the LOCAL
    /// loop, not auto-pr.
    ///
    /// `fleet-local-completion-flow` made `local` the default push policy, which DENIES `git push` /
    /// `gh pr create` at the permission layer. But the prose still opened with "Under the default
    /// auto-pr policy you open a PR for your work", and the defer directive — injected on EVERY Stop
    /// attempt — said the same. Permission and instruction disagreed, and the instruction is what the
    /// model follows: workers kept trying to open PRs on a project that integrates locally.
    ///
    /// The other half was missing entirely: `bsc plan change` (the local PR) appeared in NO worker
    /// prose, so a worker had never been told to open a change record or write gate evidence.
    #[test]
    fn the_worker_protocol_teaches_the_local_loop_not_auto_pr() {
        let empty = std::env::temp_dir().join(format!("bsc-proto-local-{}", std::process::id()));
        std::fs::create_dir_all(&empty).unwrap();
        let md = crate::platform::config::with_config_root(&empty, super::fleet_protocol_md);
        let _ = std::fs::remove_dir_all(&empty);

        // The DEFAULT is local, stated as such.
        assert!(md.contains("default is LOCAL"), "the protocol must state the local default: {md}");
        // The change record is taught — all three verbs a worker actually needs.
        for verb in ["bsc plan change new", "bsc plan change note", "bsc plan change gate"] {
            assert!(md.contains(verb), "the worker must be taught `{verb}`:
{md}");
        }
        // Completion is the worker's HALF, not a verdict on its own work.
        assert!(md.contains("bsc plan status <ref> complete"), "must name the completion verb: {md}");
        assert!(
            md.contains("does not get to declare it correct"),
            "must state that complete is not verified:
{md}",
        );
    }

    /// The defer directive is NO LONGER INJECTED — `sessionLaunch` stopped installing the `bsc-defer`
    /// Stop hook (#session-stop-is-honoured), so nothing reads this file at runtime any more. The
    /// assertion is kept because the seed is still compiled into `bsc` (`crates/bsc/src/defer.rs`
    /// `include_str!`s it) and re-attaching the hook is one line: if that ever happens deliberately,
    /// the prose it would inject must already be correct rather than two releases stale. That is
    /// exactly how the auto-pr instruction outlived the policy change it contradicted.
    #[test]
    fn the_defer_directive_does_not_default_to_opening_a_pr() {
        let empty = std::env::temp_dir().join(format!("bsc-defer-local-{}", std::process::id()));
        std::fs::create_dir_all(&empty).unwrap();
        let md = crate::platform::config::with_config_root(&empty, || {
            crate::platform::config::load_str("fleet/defer-directive.md")
        });
        let _ = std::fs::remove_dir_all(&empty);

        assert!(!md.trim().is_empty(), "the embedded seed must resolve");
        assert!(
            md.contains("do NOT push") && md.contains("do NOT open a PR"),
            "the default directive must forbid push/PR:
{md}",
        );
        assert!(
            md.contains("bsc plan status <ref> complete"),
            "the directive must name the local completion verb:
{md}",
        );
        // The stale claim this test exists to prevent coming back.
        assert!(
            !md.contains("default auto-pr policy"),
            "the directive must not call auto-pr the default:
{md}",
        );
    }
}

// ── an auto-added section refreshes (an-auto-added-protocol-section-is-frozen-once-written) ──────
//
// `append_section_once` returned early whenever the marker was present, so an auto-generated
// section was write-once forever. A director ran for twelve days on instructions nobody could
// update: the packaged protocol moved, this machine's config mirror was stale, and even after both
// were fixed a relaunch could not refresh the copy baked into the hub's CLAUDE.local.md.

#[cfg(test)]
mod upsert_tests {
    use super::upsert_section;

    fn tmp(tag: &str) -> std::path::PathBuf {
        let p = crate::testutil::unique_dir("bsc-upsert", tag);
        std::fs::create_dir_all(&p).unwrap();
        p.join("CLAUDE.local.md")
    }

    /// An absent section is appended — the original behaviour, unchanged.
    #[test]
    fn an_absent_section_is_appended() {
        let f = tmp("absent");
        std::fs::write(&f, "the plan\n").unwrap();
        upsert_section(&f, "## Protocol", "\n## Protocol\nv1\n", None).unwrap();
        assert_eq!(std::fs::read_to_string(&f).unwrap(), "the plan\n\n## Protocol\nv1\n");
        std::fs::remove_dir_all(f.parent().unwrap()).ok();
    }

    /// THE regression: a section already present is REPLACED, not left frozen.
    #[test]
    fn a_stale_section_is_refreshed_rather_than_kept_forever() {
        let f = tmp("stale");
        std::fs::write(&f, "the plan\n\n## Protocol\nv1 — twelve days old\n").unwrap();
        upsert_section(&f, "## Protocol", "\n## Protocol\nv2 — how to reach the architect\n", None).unwrap();

        let got = std::fs::read_to_string(&f).unwrap();
        assert!(got.contains("v2 — how to reach the architect"), "the new body must land: {got}");
        assert!(!got.contains("twelve days old"), "and the old one must be gone: {got}");
        assert!(got.starts_with("the plan\n"), "content OUTSIDE the section survives: {got}");
        std::fs::remove_dir_all(f.parent().unwrap()).ok();
    }

    /// A section bounded by the NEXT managed one is replaced within its own bounds — the following
    /// section is untouched. Without the bound, refreshing the first would eat the second.
    #[test]
    fn a_bounded_section_does_not_swallow_the_one_after_it() {
        let f = tmp("bounded");
        std::fs::write(&f, "## Protocol\nv1\n\n## Untrusted input\nrules\n").unwrap();
        upsert_section(&f, "## Protocol", "## Protocol\nv2\n\n", Some("## Untrusted input")).unwrap();

        let got = std::fs::read_to_string(&f).unwrap();
        assert_eq!(got, "## Protocol\nv2\n\n## Untrusted input\nrules\n", "got: {got:?}");
        std::fs::remove_dir_all(f.parent().unwrap()).ok();
    }

    /// An unchanged body rewrites NOTHING, so a relaunch that changes nothing does not churn the
    /// file — the property "idempotent" was supposed to mean, now measured on content.
    #[test]
    fn an_unchanged_section_does_not_touch_the_file() {
        let f = tmp("noop");
        let body = "\n## Protocol\nv1\n";
        std::fs::write(&f, format!("the plan\n{body}")).unwrap();
        let before = std::fs::metadata(&f).unwrap().modified().unwrap();

        std::thread::sleep(std::time::Duration::from_millis(20));
        upsert_section(&f, "## Protocol", body, None).unwrap();

        assert_eq!(
            std::fs::metadata(&f).unwrap().modified().unwrap(),
            before,
            "an unchanged section must not rewrite the file",
        );
        std::fs::remove_dir_all(f.parent().unwrap()).ok();
    }

    /// A body that QUOTES the end marker must not truncate its own section — the search starts at
    /// the section, so the first hit is the real boundary, not a mention inside the body.
    #[test]
    fn a_body_quoting_the_end_marker_still_replaces_the_whole_section() {
        let f = tmp("quotes");
        std::fs::write(&f, "## Protocol\nv1\n\n## Untrusted input\nrules\n").unwrap();
        // v2 mentions the next section by name, as real protocol prose does.
        upsert_section(
            &f,
            "## Protocol",
            "## Protocol\nv2 — see \"## Untrusted input\" below\n\n",
            Some("## Untrusted input"),
        )
        .unwrap();

        let got = std::fs::read_to_string(&f).unwrap();
        assert!(got.contains("see \"## Untrusted input\" below"), "the quote survives: {got}");
        assert!(got.ends_with("## Untrusted input\nrules\n"), "and the real section still follows: {got}");
        assert_eq!(got.matches("rules").count(), 1, "exactly once: {got}");
        std::fs::remove_dir_all(f.parent().unwrap()).ok();
    }
}
