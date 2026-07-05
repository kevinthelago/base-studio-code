//! Runtime log-scope graph (#1389) — the PURE policy behind the dual-sink logger.
//!
//! The file sink is a **system of record** (always writes at the audit baseline, ungated). The
//! console sink is a **view**: each log record's `target` (the `::`-joined module path — the
//! folder-tree-is-the-architecture) is matched against a scope config that maps a **prefix → console
//! level / off**, and the record prints to stdout only if it passes. Toggling a node cascades to its
//! whole subtree via **longest-prefix match**. No per-callsite tagging — it reuses the module-path
//! targets we already emit.
//!
//! This module owns the config type, the matching + cascade, and the JSON persistence — all
//! **Tauri-free + pure** so the desktop `GraphLogger` (`observability::graph_log`) and the `bsc logs scope`
//! CLI ([`run_cli`]) share ONE policy. The security property lives one layer up (the file sink is
//! unconditional); this module only ever decides what the CONSOLE view shows.

use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

/// The app crate's `log` target root — every backend record's target begins with this (e.g.
/// `base_studio_code_lib::console::pty`). Dependency records (tauri/wry/reqwest/…) do NOT, so they
/// fall under the global root (`""`). Frontend records are namespaced under `…::frontend::<feature>`
/// so they join the same tree.
pub const CRATE_ROOT: &str = "base_studio_code_lib";

/// A scope's console policy: a maximum level to show, or fully OFF. The ranks mirror `log::Level`
/// (Error=1 … Trace=5) so a record at rank `r` prints iff `r <= self.rank()` (and not `Off`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ScopeLevel {
    /// The console view is silenced for this scope. The FILE sink still records everything (#1389's
    /// security property) — `Off` is a VIEW control, never a RECORD control.
    Off,
    Error,
    Warn,
    Info,
    Debug,
    Trace,
}

impl ScopeLevel {
    /// The severity rank: `Off`=0, then `Error`=1 … `Trace`=5 (matching `log::Level as usize`).
    pub fn rank(self) -> u8 {
        match self {
            ScopeLevel::Off => 0,
            ScopeLevel::Error => 1,
            ScopeLevel::Warn => 2,
            ScopeLevel::Info => 3,
            ScopeLevel::Debug => 4,
            ScopeLevel::Trace => 5,
        }
    }

    /// Whether a record at `level_rank` (1=Error … 5=Trace, i.e. `log::Level as u8`) prints to the
    /// console under this policy. `Off` never prints; otherwise the record shows when it is at least
    /// as severe as the threshold (`level_rank <= self.rank()`).
    pub fn permits(self, level_rank: u8) -> bool {
        self != ScopeLevel::Off && level_rank > 0 && level_rank <= self.rank()
    }

    /// Parse a user-supplied level word (`off`/`error`/`warn`/`info`/`debug`/`trace`, plus the
    /// synonyms `none`/`silent`/`quiet`→`Off` and `warning`→`Warn`). Case-insensitive.
    pub fn parse(s: &str) -> Option<Self> {
        match s.trim().to_ascii_lowercase().as_str() {
            "off" | "none" | "silent" | "quiet" | "0" => Some(ScopeLevel::Off),
            "error" | "err" => Some(ScopeLevel::Error),
            "warn" | "warning" => Some(ScopeLevel::Warn),
            "info" => Some(ScopeLevel::Info),
            "debug" => Some(ScopeLevel::Debug),
            "trace" => Some(ScopeLevel::Trace),
            _ => None,
        }
    }

    /// The canonical lowercase label (`off`/`error`/…), matching the serde form.
    pub fn label(self) -> &'static str {
        match self {
            ScopeLevel::Off => "off",
            ScopeLevel::Error => "error",
            ScopeLevel::Warn => "warn",
            ScopeLevel::Info => "info",
            ScopeLevel::Debug => "debug",
            ScopeLevel::Trace => "trace",
        }
    }
}

/// The runtime scope graph: a prefix → console-policy map. Keys are `::`-joined module-path prefixes
/// (`""` is the global root; `base_studio_code_lib` is the app root; `base_studio_code_lib::fleet`
/// covers the whole fleet subtree). A record's console level is the value of the **longest** key that
/// prefix-matches its target — so toggling a parent node cascades to every child not overridden below.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ScopeConfig {
    /// prefix → console policy. `BTreeMap` for a stable, sorted on-disk + `list` ordering.
    pub scopes: BTreeMap<String, ScopeLevel>,
}

impl Default for ScopeConfig {
    /// Today's static defaults (`app/run.rs`): the global root shows `Warn` (keeps noisy deps —
    /// tauri/wry/reqwest — quiet) and the app's own crate root shows `Info`. The graph tunes from
    /// these; a `reset` restores exactly this.
    fn default() -> Self {
        let mut scopes = BTreeMap::new();
        scopes.insert(String::new(), ScopeLevel::Warn);
        scopes.insert(CRATE_ROOT.to_string(), ScopeLevel::Info);
        Self { scopes }
    }
}

/// Normalize a user-supplied scope token to a tree key. A control surface (`bsc logs scope set fleet …`, the
/// `log_set_scope` command) accepts the app-subsystem shorthand; this expands it to a real target
/// prefix:
/// - `""` / `root` / `all` / `*` → the global root (`""`, governs deps too);
/// - anything already under the crate root (`base_studio_code_lib…`) → taken verbatim;
/// - otherwise prefixed with `base_studio_code_lib::` (so `fleet` → `base_studio_code_lib::fleet`,
///   `console::pty` → `base_studio_code_lib::console::pty`, `frontend::planner` likewise).
///
/// So the app subsystems — the audience #1389 targets — are addressable by bare name, while a
/// dependency scope can still be reached by passing its own crate prefix (rare) or the root.
pub fn normalize_scope(input: &str) -> String {
    let s = input.trim().trim_matches(':').trim();
    match s.to_ascii_lowercase().as_str() {
        "" | "root" | "all" | "*" | "global" => String::new(),
        _ if s == CRATE_ROOT || s.starts_with(&format!("{CRATE_ROOT}::")) => s.to_string(),
        _ => format!("{CRATE_ROOT}::{s}"),
    }
}

impl ScopeConfig {
    /// The console policy governing `target`: the value of the longest key that prefix-matches it
    /// (root `""` always matches, so this never fails to resolve). A key `k` matches `target` when
    /// `k` is empty, `k == target`, or `target` starts with `k::` (a proper module ancestor).
    pub fn console_level(&self, target: &str) -> ScopeLevel {
        // Longest matching key wins. `best_len` is `None` until the first match; the empty root key
        // (len 0) matches everything and seeds the floor. A key is only taken when strictly longer
        // than the current best, so deeper (more specific) keys override their ancestors.
        let mut best_len: Option<usize> = None;
        let mut best_level = ScopeLevel::Warn; // used only if nothing matches (root is usually present)
        for (k, v) in &self.scopes {
            let matches = k.is_empty() || target == k || target.starts_with(&format!("{k}::"));
            if !matches {
                continue;
            }
            let take = match best_len {
                None => true,
                Some(l) => k.len() > l,
            };
            if take {
                best_len = Some(k.len());
                best_level = *v;
            }
        }
        best_level
    }

    /// Whether a record at `level_rank` (`log::Level as u8`) with this `target` prints to the console.
    pub fn permits(&self, target: &str, level_rank: u8) -> bool {
        self.console_level(target).permits(level_rank)
    }

    /// Set a scope's policy. `scope` is normalized ([`normalize_scope`]) so the app-subsystem
    /// shorthand (`fleet`) and a full target both land on the same key.
    pub fn set(&mut self, scope: &str, level: ScopeLevel) {
        self.scopes.insert(normalize_scope(scope), level);
    }

    /// Restore the built-in defaults ([`ScopeConfig::default`]).
    pub fn reset(&mut self) {
        *self = ScopeConfig::default();
    }

    /// Parse a config from JSON text, MERGED over the defaults: the defaults seed the map, then the
    /// parsed entries override/extend per key. So a file that only pins `fleet: off` still keeps the
    /// root/`Warn` + crate-root/`Info` floor, and a new default key added in a later build appears
    /// for an old on-disk file. A parse failure yields the plain defaults (never an error).
    pub fn from_json(text: &str) -> Self {
        let mut cfg = ScopeConfig::default();
        if let Ok(parsed) = serde_json::from_str::<ScopeConfig>(text) {
            cfg.scopes.extend(parsed.scopes);
        }
        cfg
    }

    /// Serialize to pretty JSON (stable key order via the `BTreeMap`). Infallible in practice; falls
    /// back to `{}` on the impossible serde error.
    pub fn to_json(&self) -> String {
        serde_json::to_string_pretty(self).unwrap_or_else(|_| "{}".into())
    }

    /// Load from `path`, MERGED over the defaults (see [`from_json`](ScopeConfig::from_json)). A
    /// missing/unreadable file yields the plain defaults, so first run + a deleted file both behave.
    pub fn load(path: &Path) -> Self {
        match std::fs::read_to_string(path) {
            Ok(text) => ScopeConfig::from_json(&text),
            Err(_) => ScopeConfig::default(),
        }
    }

    /// Persist to `path` as pretty JSON, creating the parent dir. Returns an error string on an I/O
    /// failure (the caller decides whether a persistence miss is fatal — for logging it never is).
    pub fn save(&self, path: &Path) -> Result<(), String> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        std::fs::write(path, self.to_json().as_bytes()).map_err(|e| e.to_string())
    }
}

// ── The `bsc logs scope` control CLI (#1389 surface 1) ──────────────────────────────────────────────────
//
// `bsc logs scope set <scope> <level|off>` · `bsc logs scope list` · `bsc logs scope reset` — the terminal/agent surface
// that toggles CONSOLE scopes live from a running session (#1325's bsc-*-over-shared-state pattern).
// It writes the shared `log-scopes.json`; the desktop `GraphLogger`'s external-write poll reloads it
// within ~2s, so an agent can quiet or light up a subsystem mid-debug with no restart.

use bsc_cli_util::{resolve_store_path, CmdDoc};

const TAGLINE: &str =
    "toggle CONSOLE log scopes at runtime (the file/audit log is always kept, #1389)";

/// The env override (and the `bsc logs scope` reader) for the scope-config file path. Mirrors the store-CLI
/// `--flag` → `$ENV` → default precedence via `resolve_store_path`.
pub const SCOPES_ENV: &str = "BSC_LOG_SCOPES";

/// The default scope-config path: `$BSC_LOG_SCOPES`, else `<base>/log-scopes.json`.
pub fn scopes_path() -> std::path::PathBuf {
    resolve_store_path(&None, SCOPES_ENV, || {
        Ok(bsc_util::bsc_base_dir()
            .unwrap_or_else(|| std::path::PathBuf::from(".base-studio-code"))
            .join("log-scopes.json"))
    })
    .unwrap_or_else(|_| std::path::PathBuf::from("log-scopes.json"))
}

const COMMANDS: &[CmdDoc] = &[
    CmdDoc {
        name: "list",
        summary: "the current scope graph (prefix → console level), the default",
        usage: "\
USAGE:
  bsc logs scope list [--json]

Print every scope key and its console policy. The FILE/audit log is unaffected by any of these —
they only gate what the console (stdout / devtools) VIEW shows.",
    },
    CmdDoc {
        name: "set",
        summary: "set a scope's console level (or off)",
        usage: "\
USAGE:
  bsc logs scope set <scope> <level>

<scope>  an app subsystem by bare name (fleet, console::pty, github, planner, frontend::planner, …)
         or `root`/`all` for the global floor. Cascades to the whole subtree.
<level>  off | error | warn | info | debug | trace   (off silences the CONSOLE only; the file log
         still records everything).

  bsc logs scope set fleet off            # quiet the whole fleet subtree in the console
  bsc logs scope set console::pty debug   # light up one module while debugging",
    },
    CmdDoc {
        name: "reset",
        summary: "restore the built-in defaults (root=warn, app=info)",
        usage: "\
USAGE:
  bsc logs scope reset

Restore the default graph: the global root shows warn (deps stay quiet) and the app crate shows info.",
    },
];

/// `bsc logs scope <cmd>` entrypoint: `args` is everything after `bsc logs scope`; `prog` is the display name for
/// help/errors. Writes/reads the shared `log-scopes.json` (`--file <path>` / `$BSC_LOG_SCOPES` /
/// default). Help is resolved before touching the file.
pub fn run_cli(args: Vec<String>, prog: &str) -> Result<(), String> {
    // Parse: a leading verb + positionals, plus `--json` and `--file <path>`.
    let mut positional: Vec<String> = Vec::new();
    let mut json = false;
    let mut file: Option<String> = None;
    let mut it = args.into_iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--json" | "--pretty" => json = true,
            "--file" => file = Some(it.next().ok_or("--file needs a value")?),
            "-h" | "--help" => positional.insert(0, "help".into()),
            other if other.starts_with("--") => return Err(format!("unknown flag '{other}'")),
            other => positional.push(other.to_string()),
        }
    }

    if bsc_cli_util::handle_help(prog, TAGLINE, COMMANDS, &positional) {
        return Ok(());
    }

    let path = match &file {
        Some(f) => std::path::PathBuf::from(f),
        None => scopes_path(),
    };

    let verb = positional.first().map(String::as_str).unwrap_or("list");
    match verb {
        "list" => {
            let cfg = ScopeConfig::load(&path);
            if json {
                println!("{}", cfg.to_json());
            } else {
                println!("scope\tconsole");
                for (k, v) in &cfg.scopes {
                    let name = if k.is_empty() { "(root)" } else { k.as_str() };
                    println!("{name}\t{}", v.label());
                }
            }
        }
        "set" => {
            let scope = positional.get(1).cloned().ok_or("usage: bsc logs scope set <scope> <level>")?;
            let level_raw = positional.get(2).cloned().ok_or("usage: bsc logs scope set <scope> <level>")?;
            let level = ScopeLevel::parse(&level_raw)
                .ok_or_else(|| format!("unknown level '{level_raw}' (off|error|warn|info|debug|trace)"))?;
            let mut cfg = ScopeConfig::load(&path);
            cfg.set(&scope, level);
            cfg.save(&path)?;
            let key = normalize_scope(&scope);
            let shown = if key.is_empty() { "(root)".to_string() } else { key };
            println!("set {shown} = {}", level.label());
        }
        "reset" => {
            let cfg = ScopeConfig::default();
            cfg.save(&path)?;
            println!("reset log scopes to defaults");
        }
        other => {
            return Err(bsc_cli_util::unknown_command(prog, TAGLINE, COMMANDS, other));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> std::path::PathBuf {
        use std::sync::atomic::{AtomicU32, Ordering};
        static N: AtomicU32 = AtomicU32::new(0);
        std::env::temp_dir().join(format!(
            "logscope-{name}-{}-{}.json",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ))
    }

    #[test]
    fn level_permits_mirrors_log_level_ranks() {
        // Error=1 … Trace=5; a record prints when its rank <= the scope threshold.
        assert!(ScopeLevel::Warn.permits(1), "error shows under warn");
        assert!(ScopeLevel::Warn.permits(2), "warn shows under warn");
        assert!(!ScopeLevel::Warn.permits(3), "info hidden under warn");
        assert!(ScopeLevel::Debug.permits(4));
        assert!(!ScopeLevel::Info.permits(4), "debug hidden under info");
        // Off silences everything, even Error.
        assert!(!ScopeLevel::Off.permits(1));
        assert!(!ScopeLevel::Off.permits(5));
    }

    #[test]
    fn level_parse_accepts_words_and_synonyms() {
        assert_eq!(ScopeLevel::parse("OFF"), Some(ScopeLevel::Off));
        assert_eq!(ScopeLevel::parse("none"), Some(ScopeLevel::Off));
        assert_eq!(ScopeLevel::parse("Warning"), Some(ScopeLevel::Warn));
        assert_eq!(ScopeLevel::parse(" debug "), Some(ScopeLevel::Debug));
        assert_eq!(ScopeLevel::parse("bogus"), None);
    }

    #[test]
    fn normalize_scope_expands_bare_subsystems_and_keeps_full_targets() {
        assert_eq!(normalize_scope("fleet"), "base_studio_code_lib::fleet");
        assert_eq!(normalize_scope("console::pty"), "base_studio_code_lib::console::pty");
        // Already-rooted targets pass through untouched.
        assert_eq!(
            normalize_scope("base_studio_code_lib::github"),
            "base_studio_code_lib::github"
        );
        assert_eq!(normalize_scope("base_studio_code_lib"), "base_studio_code_lib");
        // The root synonyms all collapse to the empty global key.
        assert_eq!(normalize_scope(""), "");
        assert_eq!(normalize_scope("root"), "");
        assert_eq!(normalize_scope("ALL"), "");
        assert_eq!(normalize_scope("*"), "");
    }

    #[test]
    fn console_level_uses_longest_prefix_and_cascades_to_subtree() {
        let mut cfg = ScopeConfig::default(); // root=warn, crate=info
        // A crate-internal target inherits the crate-root Info until a more specific key overrides.
        assert_eq!(cfg.console_level("base_studio_code_lib::fleet::director"), ScopeLevel::Info);
        // A dependency target (not under the crate root) falls to the global Warn.
        assert_eq!(cfg.console_level("wry::webview"), ScopeLevel::Warn);

        // Toggle the whole fleet subtree off → every fleet descendant cascades to Off…
        cfg.set("fleet", ScopeLevel::Off);
        assert_eq!(cfg.console_level("base_studio_code_lib::fleet::director"), ScopeLevel::Off);
        assert_eq!(cfg.console_level("base_studio_code_lib::fleet"), ScopeLevel::Off);
        // …but a sibling subtree is untouched (still Info from the crate root).
        assert_eq!(cfg.console_level("base_studio_code_lib::github::api"), ScopeLevel::Info);

        // A deeper, more specific key wins over the ancestor (longest-prefix).
        cfg.set("fleet::director", ScopeLevel::Debug);
        assert_eq!(cfg.console_level("base_studio_code_lib::fleet::director"), ScopeLevel::Debug);
        assert_eq!(cfg.console_level("base_studio_code_lib::fleet::worker"), ScopeLevel::Off);
    }

    #[test]
    fn prefix_match_is_boundary_aware_not_substring() {
        let mut cfg = ScopeConfig::default();
        cfg.set("fleet", ScopeLevel::Off);
        // `fleeting` must NOT be matched by the `fleet` key — matching is on `::` boundaries.
        assert_eq!(cfg.console_level("base_studio_code_lib::fleeting"), ScopeLevel::Info);
        assert_eq!(cfg.console_level("base_studio_code_lib::fleet"), ScopeLevel::Off);
    }

    #[test]
    fn permits_combines_scope_and_record_level() {
        let mut cfg = ScopeConfig::default();
        cfg.set("console::pty", ScopeLevel::Debug);
        let t = "base_studio_code_lib::console::pty";
        assert!(cfg.permits(t, 4), "debug record shows under a debug scope");
        // The crate root is Info, so a debug record elsewhere is hidden.
        assert!(!cfg.permits("base_studio_code_lib::project::hub", 4));
        assert!(cfg.permits("base_studio_code_lib::project::hub", 3), "info shows");
    }

    #[test]
    fn reset_restores_defaults() {
        let mut cfg = ScopeConfig::default();
        cfg.set("fleet", ScopeLevel::Off);
        cfg.set("github", ScopeLevel::Trace);
        cfg.reset();
        assert_eq!(cfg, ScopeConfig::default());
        assert_eq!(cfg.console_level("base_studio_code_lib::fleet::x"), ScopeLevel::Info);
    }

    #[test]
    fn json_round_trips_and_merges_over_defaults() {
        let mut cfg = ScopeConfig::default();
        cfg.set("fleet", ScopeLevel::Off);
        let text = cfg.to_json();
        let back = ScopeConfig::from_json(&text);
        assert_eq!(back, cfg);

        // A PARTIAL file (only pins one scope) still carries the default floor after merge.
        let partial = r#"{ "scopes": { "base_studio_code_lib::github": "trace" } }"#;
        let merged = ScopeConfig::from_json(partial);
        assert_eq!(merged.console_level("wry::x"), ScopeLevel::Warn, "root default preserved");
        assert_eq!(merged.console_level("base_studio_code_lib::x"), ScopeLevel::Info, "crate default preserved");
        assert_eq!(merged.console_level("base_studio_code_lib::github::api"), ScopeLevel::Trace, "file value applied");

        // Garbage falls back to defaults, never an error.
        assert_eq!(ScopeConfig::from_json("not json"), ScopeConfig::default());
    }

    #[test]
    fn save_then_load_round_trips_through_disk() {
        let path = tmp("rt");
        let mut cfg = ScopeConfig::default();
        cfg.set("planner", ScopeLevel::Off);
        cfg.set("console::pty", ScopeLevel::Debug);
        cfg.save(&path).unwrap();

        let loaded = ScopeConfig::load(&path);
        assert_eq!(loaded, cfg);
        assert_eq!(loaded.console_level("base_studio_code_lib::planner::prompts"), ScopeLevel::Off);
        assert_eq!(loaded.console_level("base_studio_code_lib::console::pty"), ScopeLevel::Debug);

        // A missing file loads the defaults, never a panic.
        let _ = std::fs::remove_file(&path);
        assert_eq!(ScopeConfig::load(&path), ScopeConfig::default());
    }

    #[test]
    fn cli_set_list_reset_round_trip_via_file() {
        let path = tmp("cli");
        let f = path.to_string_lossy().into_owned();
        let go = |args: Vec<&str>| {
            let mut v: Vec<String> = args.into_iter().map(String::from).collect();
            v.extend(["--file".into(), f.clone()]);
            run_cli(v, "bsc logs scope")
        };
        // set writes the file with the normalized key.
        assert!(go(vec!["set", "fleet", "off"]).is_ok());
        let cfg = ScopeConfig::load(&path);
        assert_eq!(cfg.scopes.get("base_studio_code_lib::fleet"), Some(&ScopeLevel::Off));
        // list + reset dispatch without error; a bad level is a clean usage error.
        assert!(go(vec!["list"]).is_ok());
        assert!(go(vec!["set", "fleet", "bogus"]).is_err());
        assert!(go(vec!["reset"]).is_ok());
        assert_eq!(ScopeConfig::load(&path), ScopeConfig::default());
        // Help works without touching the file (and unknown verb errors).
        assert!(run_cli(vec!["help".into()], "bsc logs scope").is_ok());
        assert!(go(vec!["frobnicate"]).is_err());
        let _ = std::fs::remove_file(&path);
    }
}
