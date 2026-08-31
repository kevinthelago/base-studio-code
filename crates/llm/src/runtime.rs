//! What the LOCAL model runtime is actually doing right now — as opposed to what it was asked to do.
//!
//! # Why this module exists
//!
//! Ollama fits its runner to the VRAM it can see, and it does so **silently**. Ask for two parallel
//! slots at a 64K context on a box that has already committed most of its VRAM and you get one slot
//! at 4096, with no error, no warning, and an HTTP API that answers every question as if nothing
//! happened. MEASURED 2026-08-31: a second `ollama serve` started with `OLLAMA_NUM_PARALLEL=2` came
//! up as `llama-server … -c 4096 -np 1`, because the first server already held 7.52 GiB of a 15.9 GiB
//! GPU.
//!
//! That matters twice over:
//!
//! * **Parallelism.** Two concurrent requests to one model measured **1.88x** the single-request
//!   time — serialized, not parallel — which is exactly the "we cannot run two local sessions"
//!   symptom. Setting `OLLAMA_NUM_PARALLEL` is necessary and NOT sufficient; nothing downstream can
//!   currently tell whether it took effect.
//! * **Context.** A shrunk context is worse than a slow one. Ollama does not trim overflow, it
//!   truncates to `num_ctx/2` and keeps the HEAD plus the tail — and the head is where `CLAUDE.md`
//!   lives. This app's own system prompt measured 33,580 tokens, so a runner that quietly came up at
//!   4096 is discarding essentially all of it while every surface reports success.
//!
//! So this module reads the GRANT, not the request. The authority is the running `llama-server`'s own
//! argv (`-c` total context, `-np` slots), because that is the process actually doing the work; the
//! HTTP API reports intent and cannot contradict itself.
//!
//! Everything here is **pure**. The probe that walks `/proc` and calls the HTTP API lives in `cli.rs`,
//! so every parse and every finding is testable against captured real output — see the fixtures in
//! the tests below, taken verbatim from this box.

use std::collections::BTreeMap;

/// Bytes in a GiB, for rendering. Local-model sizes are always discussed in GiB.
pub const GIB: f64 = 1_073_741_824.0;

/// What a running `llama-server` was actually GRANTED, read from its own argv.
///
/// `-c` is the TOTAL context across all slots, not the per-slot context — llama.cpp divides it by
/// `-np`. Getting that backwards reports a 64K context when each slot really has 32K, so
/// [`Self::per_slot_ctx`] is the only figure callers should compare against a requested `num_ctx`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SlotGrant {
    /// `-c`: the total context llama.cpp allocated KV for, summed across slots.
    pub total_ctx: u32,
    /// `-np`: how many requests this runner can serve concurrently.
    pub slots: u32,
    /// The model file this runner loaded, when the argv names one (`--model <path>`).
    pub model_path: Option<String>,
}

impl SlotGrant {
    /// The context each individual request actually gets. This is the number to compare against a
    /// requested `num_ctx`; `total_ctx` alone overstates it by a factor of `slots`.
    pub fn per_slot_ctx(&self) -> u32 {
        self.total_ctx / self.slots.max(1)
    }
}

/// Parse a `llama-server` command line into the grant it represents.
///
/// Takes the argv as the kernel holds it (`/proc/<pid>/cmdline`, NUL-split), so there is no quoting
/// to undo and no shell to re-interpret. Returns `None` when the argv carries no `-c`, which means it
/// is not a runner worth reporting on.
///
/// `-np` ABSENT means one slot, not "unknown": llama.cpp's own default is 1, and reporting `None`
/// here would make the common single-slot case indistinguishable from a parse failure.
pub fn parse_llama_server_argv(argv: &[String]) -> Option<SlotGrant> {
    let value_after = |flag: &str| -> Option<&String> {
        argv.iter().position(|a| a == flag).and_then(|i| argv.get(i + 1))
    };
    let total_ctx = value_after("-c")
        .or_else(|| value_after("--ctx-size"))
        .and_then(|v| v.parse::<u32>().ok())?;
    let slots = value_after("-np")
        .or_else(|| value_after("--parallel"))
        .and_then(|v| v.parse::<u32>().ok())
        .unwrap_or(1);
    Some(SlotGrant {
        total_ctx,
        slots: slots.max(1),
        model_path: value_after("--model").cloned(),
    })
}

/// A model ollama currently holds resident, from `GET /api/ps`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResidentModel {
    pub name: String,
    /// Total bytes the runner is holding for this model — weights plus KV plus buffers.
    pub size_bytes: u64,
    /// Of that, what sits in VRAM. Equal to `size_bytes` on a full offload.
    pub vram_bytes: u64,
    /// The context ollama says it gave this model. Reports INTENT; the runner's `-c`/`-np` is the
    /// authority when the two disagree.
    pub context_length: Option<u32>,
}

impl ResidentModel {
    /// Bytes attributable to KV + buffers, given the model's on-disk weight size.
    ///
    /// DERIVED BY SUBTRACTION, deliberately. The arithmetic alternative is to compute KV from the
    /// model's layer count and head dimensions, and that is wrong for exactly the models in use here:
    /// qwen3.5 is HYBRID, and llama.cpp allocated KV for **8 of its 32 layers**. A formula assuming
    /// every layer carries KV overstates the cost fourfold and would drive the fleet to run fewer
    /// parallel sessions than the box can actually hold.
    pub fn overhead_bytes(&self, weights_bytes: u64) -> Option<u64> {
        self.size_bytes.checked_sub(weights_bytes)
    }
}

/// Parse `GET /api/ps`. An absent or malformed `models` array is an empty list, not an error: "no
/// model is loaded" is a normal state and must not read as a failure to probe.
pub fn parse_ps(body: &str) -> Result<Vec<ResidentModel>, String> {
    let v: serde_json::Value =
        serde_json::from_str(body).map_err(|e| format!("/api/ps is not JSON: {e}"))?;
    Ok(v.get("models")
        .and_then(|m| m.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|m| {
                    let name = m.get("name").and_then(|n| n.as_str())?.to_string();
                    let size_bytes = m.get("size").and_then(serde_json::Value::as_u64)?;
                    Some(ResidentModel {
                        name,
                        size_bytes,
                        vram_bytes: m
                            .get("size_vram")
                            .and_then(serde_json::Value::as_u64)
                            .unwrap_or(0),
                        context_length: m
                            .get("context_length")
                            .and_then(serde_json::Value::as_u64)
                            .map(|c| c as u32),
                    })
                })
                .collect()
        })
        .unwrap_or_default())
}

/// Model name to on-disk weight size, from `GET /api/tags`. Feeds [`ResidentModel::overhead_bytes`].
pub fn parse_tags(body: &str) -> Result<BTreeMap<String, u64>, String> {
    let v: serde_json::Value =
        serde_json::from_str(body).map_err(|e| format!("/api/tags is not JSON: {e}"))?;
    Ok(v.get("models")
        .and_then(|m| m.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|m| {
                    Some((
                        m.get("name").and_then(|n| n.as_str())?.to_string(),
                        m.get("size").and_then(serde_json::Value::as_u64)?,
                    ))
                })
                .collect()
        })
        .unwrap_or_default())
}

/// What the caller ASKED for, to be checked against what is running.
///
/// Every field is optional because each is separately unknowable: `OLLAMA_NUM_PARALLEL` may simply
/// not be set (ollama picks its own), and the requested `num_ctx` is the app's business rather than
/// the runtime's. An unknown is reported as unknown — never defaulted into a comparison, which would
/// manufacture a finding out of an absent fact.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Requested {
    /// `OLLAMA_NUM_PARALLEL` from the server's environment.
    pub parallel: Option<u32>,
    /// The `num_ctx` the app sends with each request (`$BSC_AGENT_NUM_CTX`, else its own cap).
    pub num_ctx: Option<u32>,
}

/// Pick the `OLLAMA_*` settings that bear on slot sizing out of a NUL- or newline-separated environ.
///
/// Reads the SERVER's environment rather than the current process's: these are set where
/// `ollama serve` was launched, which on this box is a bare shell, not a unit file — so
/// `systemctl show` reports nothing and `std::env` sees nothing either.
pub fn parse_ollama_env(environ: &str) -> Requested {
    let get = |key: &str| -> Option<String> {
        environ
            .split(['\0', '\n'])
            .find_map(|line| line.strip_prefix(&format!("{key}=")))
            .map(str::to_string)
            .filter(|v| !v.trim().is_empty())
    };
    Requested { parallel: get("OLLAMA_NUM_PARALLEL").and_then(|v| v.trim().parse().ok()), num_ctx: None }
}

/// GPU memory, as the kernel driver reports it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Vram {
    pub total_bytes: u64,
    pub used_bytes: u64,
}

impl Vram {
    pub fn free_bytes(&self) -> u64 {
        self.total_bytes.saturating_sub(self.used_bytes)
    }
}

/// Parse the amdgpu sysfs VRAM counters (`mem_info_vram_total` / `mem_info_vram_used`).
///
/// The DRIVER, not ollama's log. Ollama prints its VRAM view at startup, but that lands on whatever
/// stdout `ollama serve` was launched with — on this box a bare shell, so there is no file to read and
/// no journal entry. sysfs is always there and always current.
///
/// Returns `None` on anything unparseable rather than guessing: a wrong VRAM figure would drive a
/// wrong answer to "can another session fit", which is the one question this exists to answer.
pub fn parse_vram_sysfs(total: &str, used: &str) -> Option<Vram> {
    let n = |s: &str| s.trim().parse::<u64>().ok();
    let (total_bytes, used_bytes) = (n(total)?, n(used)?);
    // A driver reporting zero total is reporting "I do not know", not "there is no memory".
    if total_bytes == 0 {
        return None;
    }
    Some(Vram { total_bytes, used_bytes })
}

/// How much a gap matters.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Severity {
    /// Worth knowing; nothing is being lost.
    Note,
    /// Something asked for is not in effect.
    Warn,
}

/// A gap between what was requested and what is running.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Finding {
    pub severity: Severity,
    pub message: String,
    /// What to do about it, when there is a concrete answer. Rendered on its own line.
    pub fix: Option<String>,
}

/// Compare the grant against the request and report every gap.
///
/// The findings are the POINT of this module. A status command that merely prints the current numbers
/// leaves the reader to notice that 4096 is not 65536, and the whole reason this went unseen is that
/// nobody was looking. So the comparison is done here and stated in words.
pub fn findings(req: &Requested, grants: &[SlotGrant]) -> Vec<Finding> {
    findings_with_headroom(req, grants, None, None)
}

/// [`findings`], plus the question a fleet actually wants answered: does another parallel session fit?
///
/// `slot_cost` is the MEASURED per-slot overhead (see [`ResidentModel::overhead_bytes`]), not a
/// formula. Both extra arguments are optional because both are separately unknowable — no GPU, or no
/// model resident yet to measure a slot from — and an unknown must produce silence rather than a
/// confident wrong number about what the box can hold.
pub fn findings_with_headroom(
    req: &Requested,
    grants: &[SlotGrant],
    vram: Option<Vram>,
    slot_cost: Option<u64>,
) -> Vec<Finding> {
    let mut out = Vec::new();
    if let (Some(v), Some(cost)) = (vram, slot_cost) {
        // `checked_div` rather than a zero guard: a slot measured at zero bytes is a failed
        // measurement, not a free one, and dividing by it would claim infinite headroom.
        if let Some(fits) = v.free_bytes().checked_div(cost) {
            out.push(Finding {
                severity: Severity::Note,
                message: format!(
                    "headroom: {:.2} GiB free of {:.2} GiB · a slot measured {:.2} GiB · \
                     room for {fits} more parallel session(s) on an ALREADY-LOADED model.",
                    v.free_bytes() as f64 / GIB,
                    v.total_bytes as f64 / GIB,
                    cost as f64 / GIB,
                ),
                fix: (fits == 0).then(|| {
                    "nothing more fits — unload a model (`ollama stop <model>`) before starting \
                     another local session"
                        .to_string()
                }),
            });
        }
    }
    for g in grants {
        // The context shrink. Worse than it looks: ollama truncates to num_ctx/2 keeping the head and
        // tail, so overflowing by one token costs half the window and silently drops the middle.
        if let Some(want) = req.num_ctx {
            let got = g.per_slot_ctx();
            if got < want {
                out.push(Finding {
                    severity: Severity::Warn,
                    message: format!(
                        "context SHRUNK: asked for {want} tokens per slot, the runner granted {got} \
                         ({}x smaller). Ollama fits the runner to available VRAM and does not report \
                         it. Prompts over {got} tokens are truncated to {} — keeping the head and \
                         tail, dropping the middle.",
                        want / got.max(1),
                        got / 2
                    ),
                    fix: Some(
                        "free VRAM (unload another model: `ollama stop <model>`) or lower \
                         $BSC_AGENT_NUM_CTX so the request matches what fits"
                            .into(),
                    ),
                });
            }
        }
        // The slot shrink — the reason two sessions serialize.
        if let Some(want) = req.parallel {
            if g.slots < want {
                out.push(Finding {
                    severity: Severity::Warn,
                    message: format!(
                        "parallelism SHRUNK: OLLAMA_NUM_PARALLEL={want}, the runner granted {} slot(s). \
                         Concurrent requests to this model run one after another.",
                        g.slots
                    ),
                    fix: Some(
                        "free VRAM so the extra slot fits — a slot costs one context worth of KV, \
                         and the weights are shared, so slots are far cheaper than a second model"
                            .into(),
                    ),
                });
            }
        }
        if req.parallel.is_none() && g.slots == 1 {
            out.push(Finding {
                severity: Severity::Note,
                message: "one slot: concurrent requests to this model will serialize. \
                          OLLAMA_NUM_PARALLEL is unset, so ollama chose this."
                    .into(),
                fix: Some(
                    "set OLLAMA_NUM_PARALLEL=2 where `ollama serve` is launched, then re-check here \
                     that the grant actually moved — setting it is not the same as getting it"
                        .into(),
                ),
            });
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Captured verbatim from this box, 2026-08-31 — the runner that had silently come up at 4096.
    const REAL_ARGV: &[&str] = &[
        "/home/u/.local/lib/ollama/llama-server",
        "--model",
        "/home/u/.ollama/models/blobs/sha256-afb54ad43a39",
        "--port",
        "36005",
        "--host",
        "127.0.0.1",
        "--no-webui",
        "-c",
        "4096",
        "-np",
        "1",
        "--flash-attn",
        "auto",
        "-b",
        "2048",
    ];

    /// Captured verbatim from `GET /api/ps` on this box.
    const REAL_PS: &str = r#"{"models":[{"name":"huihui_ai/qwen3.5-abliterated:9b","model":"huihui_ai/qwen3.5-abliterated:9b","size":5498564770,"digest":"92a443","details":{"family":"qwen35","parameter_size":"9.7B","quantization_level":"Q4_K_M"},"expires_at":"2026-08-31T10:04:21-04:00","size_vram":5498564770,"context_length":4096}]}"#;

    const REAL_TAGS: &str = r#"{"models":[{"name":"qwen3.5:35b-a3b","size":23869191742},{"name":"huihui_ai/qwen3.5-abliterated:9b","size":6593000000}]}"#;

    fn argv(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn the_grant_is_read_from_the_running_runners_own_argv() {
        let g = parse_llama_server_argv(&argv(REAL_ARGV)).expect("a runner with -c");
        assert_eq!(g.total_ctx, 4096);
        assert_eq!(g.slots, 1);
        assert_eq!(g.model_path.as_deref(), Some("/home/u/.ollama/models/blobs/sha256-afb54ad43a39"));
    }

    /// `-c` is the TOTAL across slots. Reporting it as the per-request context would claim 131072
    /// when each request really gets 65536 — an error in the reassuring direction.
    #[test]
    fn the_per_slot_context_divides_the_total_by_the_slot_count() {
        let two = parse_llama_server_argv(&argv(&["x", "-c", "131072", "-np", "2"])).unwrap();
        assert_eq!(two.total_ctx, 131072);
        assert_eq!(two.per_slot_ctx(), 65536, "each request gets HALF the -c figure");

        let one = parse_llama_server_argv(&argv(&["x", "-c", "65536"])).unwrap();
        assert_eq!(one.slots, 1, "-np absent means llama.cpp's own default of 1, not unknown");
        assert_eq!(one.per_slot_ctx(), 65536);
    }

    #[test]
    fn an_argv_without_a_context_is_not_a_runner_worth_reporting() {
        assert!(parse_llama_server_argv(&argv(&["llama-server", "--help"])).is_none());
        assert!(parse_llama_server_argv(&[]).is_none());
        // A `-c` with no value must not panic on the missing index.
        assert!(parse_llama_server_argv(&argv(&["x", "-c"])).is_none());
    }

    #[test]
    fn the_long_flag_spellings_parse_too() {
        let g = parse_llama_server_argv(&argv(&["x", "--ctx-size", "8192", "--parallel", "4"]))
            .expect("long flags");
        assert_eq!((g.total_ctx, g.slots, g.per_slot_ctx()), (8192, 4, 2048));
    }

    #[test]
    fn resident_models_parse_from_real_api_ps() {
        let ms = parse_ps(REAL_PS).expect("valid ps");
        assert_eq!(ms.len(), 1);
        assert_eq!(ms[0].name, "huihui_ai/qwen3.5-abliterated:9b");
        assert_eq!(ms[0].size_bytes, 5_498_564_770);
        assert_eq!(ms[0].vram_bytes, 5_498_564_770, "a full offload puts it all in VRAM");
        assert_eq!(ms[0].context_length, Some(4096));
    }

    /// Nothing loaded is a NORMAL state, and an empty list is the honest answer — an error here would
    /// make an idle box look like a broken probe.
    #[test]
    fn nothing_loaded_is_an_empty_list_rather_than_an_error() {
        assert_eq!(parse_ps(r#"{"models":[]}"#).unwrap(), vec![]);
        assert_eq!(parse_ps("{}").unwrap(), vec![]);
        assert!(parse_ps("not json").is_err(), "a malformed body IS an error, unlike an empty one");
    }

    /// KV is derived by SUBTRACTION, never from a layer-count formula: qwen3.5 is hybrid and only 8
    /// of its 32 layers carry KV, so a per-layer formula overstates the cost about fourfold.
    #[test]
    fn kv_overhead_is_measured_by_subtracting_the_weights() {
        let tags = parse_tags(REAL_TAGS).expect("valid tags");
        let m = &parse_ps(REAL_PS).unwrap()[0];
        let weights = tags[&m.name];
        let overhead = m.overhead_bytes(weights);
        // At 4096 context the runner holds LESS than the weights on disk — the GGUF is memory-mapped
        // and not every page is resident — so subtraction underflows. Reporting None beats reporting
        // a wrapped-around number as a KV cost.
        assert_eq!(overhead, None, "an underflow is unknown, never a huge positive");

        let big = ResidentModel { size_bytes: 8_078_114_159, ..m.clone() };
        assert_eq!(big.overhead_bytes(weights), Some(1_485_114_159));
    }

    /// Real amdgpu sysfs values from this box: 17095983104 total is the 15.9 GiB ollama also reports,
    /// which is the cross-check that the driver and the runtime agree about the same GPU.
    #[test]
    fn vram_comes_from_the_driver_rather_than_a_log_we_cannot_reach() {
        let v = parse_vram_sysfs("17095983104\n", "10390507520\n").expect("real sysfs values");
        assert_eq!(v.total_bytes, 17_095_983_104);
        assert_eq!(v.free_bytes(), 6_705_475_584);
        assert!((v.total_bytes as f64 / GIB - 15.92).abs() < 0.01, "agrees with ollama's 15.9 GiB");

        // Unknown stays unknown. A guessed VRAM figure produces a confident wrong answer to the one
        // question this exists for — whether another session fits.
        assert_eq!(parse_vram_sysfs("", "0"), None);
        assert_eq!(parse_vram_sysfs("not-a-number", "0"), None);
        assert_eq!(parse_vram_sysfs("0", "0"), None, "a zero total means 'I do not know'");
        // Used above total must not underflow into a huge "free".
        assert_eq!(parse_vram_sysfs("100", "200").unwrap().free_bytes(), 0);
    }

    /// The question a fleet actually asks: does another parallel session fit?
    #[test]
    fn headroom_answers_how_many_more_sessions_fit() {
        let vram = parse_vram_sysfs("17095983104", "10390507520").unwrap();
        let slot = 1_485_114_159_u64; // measured KV+buffers for one 64K slot on this box
        let f = findings_with_headroom(&Requested::default(), &[], Some(vram), Some(slot));
        let h = f.iter().find(|f| f.message.contains("headroom")).expect("a headroom finding");
        assert!(h.message.contains("room for 4 more"), "{}", h.message);
        // No run of spaces. A Rust line-continuation that loses its backslash silently bakes the
        // source indentation into the output, and the message still "contains" everything asserted
        // above — so only this catches it.
        assert!(!h.message.contains("  "), "collapsed continuation: {:?}", h.message);
        assert!(h.fix.is_none(), "room to spare needs no fix");

        // Full up: the finding must say so AND say what to do.
        let full = parse_vram_sysfs("17095983104", "17000000000").unwrap();
        let f = findings_with_headroom(&Requested::default(), &[], Some(full), Some(slot));
        let h = f.iter().find(|f| f.message.contains("headroom")).unwrap();
        assert!(h.message.contains("room for 0 more"), "{}", h.message);
        assert!(h.fix.as_deref().unwrap().contains("ollama stop"), "names the actual command");
    }

    /// No GPU, or nothing resident to measure a slot from — say nothing rather than guess.
    #[test]
    fn an_unmeasurable_box_produces_no_headroom_claim() {
        let vram = parse_vram_sysfs("17095983104", "0").unwrap();
        for (v, c) in [(None, Some(1)), (Some(vram), None), (None, None), (Some(vram), Some(0))] {
            let f = findings_with_headroom(&Requested::default(), &[], v, c);
            assert!(!f.iter().any(|f| f.message.contains("headroom")), "guessed with v={v:?} c={c:?}");
        }
    }

    #[test]
    fn the_server_environment_supplies_what_was_requested() {
        let r = parse_ollama_env("PATH=/usr/bin\0OLLAMA_NUM_PARALLEL=2\0OLLAMA_MAX_LOADED_MODELS=1\0");
        assert_eq!(r.parallel, Some(2));
        // Newline-separated is accepted too, since that is how the value arrives once `tr` has run.
        assert_eq!(parse_ollama_env("OLLAMA_NUM_PARALLEL=4\n").parallel, Some(4));
        // Unset stays unset. Defaulting it to ollama's own default would invent a request the user
        // never made, and then report a "shrink" against it.
        assert_eq!(parse_ollama_env("PATH=/usr/bin").parallel, None);
        assert_eq!(parse_ollama_env("OLLAMA_NUM_PARALLEL=").parallel, None);
        assert_eq!(parse_ollama_env("OLLAMA_NUM_PARALLEL=nonsense").parallel, None);
    }

    /// THE FINDING THIS WHOLE MODULE EXISTS FOR — the measured case, stated in words.
    #[test]
    fn a_silently_shrunk_context_is_reported_with_what_it_costs() {
        let req = Requested { parallel: Some(2), num_ctx: Some(65536) };
        let granted = parse_llama_server_argv(&argv(REAL_ARGV)).unwrap();
        let f = findings(&req, std::slice::from_ref(&granted));

        let ctx = f.iter().find(|f| f.message.contains("context SHRUNK")).expect("the context finding");
        assert_eq!(ctx.severity, Severity::Warn);
        assert!(ctx.message.contains("65536"), "says what was asked");
        assert!(ctx.message.contains("4096"), "says what was granted");
        assert!(ctx.message.contains("16x smaller"), "says how bad: {}", ctx.message);
        assert!(ctx.message.contains("2048"), "says the truncation floor is num_ctx/2");
        assert!(ctx.fix.is_some(), "a finding without a fix is just a complaint");

        let par = f.iter().find(|f| f.message.contains("parallelism SHRUNK")).expect("the slot finding");
        assert!(par.message.contains("1 slot"), "{}", par.message);
        assert!(par.message.contains("one after another"), "names the consequence");
    }

    /// A grant that matches the request produces no warning — or every healthy box reads as broken
    /// and the findings stop meaning anything.
    #[test]
    fn a_grant_that_matches_the_request_is_silent() {
        let req = Requested { parallel: Some(2), num_ctx: Some(65536) };
        let g = parse_llama_server_argv(&argv(&["x", "-c", "131072", "-np", "2"])).unwrap();
        assert_eq!(findings(&req, &[g]), vec![], "131072 over 2 slots IS 65536 each");
    }

    /// A grant LARGER than the request is not a problem, and must not be reported as one.
    #[test]
    fn a_grant_bigger_than_the_request_is_not_a_finding() {
        let req = Requested { parallel: Some(1), num_ctx: Some(8192) };
        let g = parse_llama_server_argv(&argv(&["x", "-c", "65536", "-np", "1"])).unwrap();
        assert!(findings(&req, &[g]).iter().all(|f| f.severity == Severity::Note));
    }

    /// With nothing requested there is nothing to compare, so the only thing worth saying is the
    /// serialization note — never a shrink against a request that was never made.
    #[test]
    fn an_unknown_request_produces_no_shrink_finding() {
        let g = parse_llama_server_argv(&argv(REAL_ARGV)).unwrap();
        let f = findings(&Requested::default(), &[g]);
        assert!(!f.iter().any(|f| f.message.contains("SHRUNK")), "cannot shrink from an unknown");
        assert_eq!(f.len(), 1);
        assert_eq!(f[0].severity, Severity::Note);
        assert!(f[0].message.contains("serialize"));
        assert!(f[0].fix.as_deref().unwrap().contains("not the same as getting it"));
    }
}
