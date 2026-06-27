use crate::*;
use crate::project::{hub::*, plan_files::*, blueprints::*, dead_code::*, ui_skeleton::*, files::*};
use crate::fleet::{worktree::*, director::*, inspect::*};
use crate::github::readiness::*;
use crate::extensions::{mcp::*, cfg::*};
use crate::console::settings::*;

    use crate::testutil::{ENV_LOCK, temp_home, write_file};

    #[test]
    fn session_lock_detects_unclean_shutdown() {
        // #1041: the marker surviving a run = unclean shutdown (the Exit handler never deleted it).
        let dir = std::env::temp_dir().join(format!(
            "bsc-lock-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0),
        ));
        let lock = dir.join(".session-lock");
        // First claim (clean / first run): marker not present yet.
        assert!(!claim_session_lock(&lock), "first claim sees a clean state");
        assert!(lock.exists(), "claim writes the marker");
        // A second claim WITHOUT a clean release (no Exit delete) = unclean prior shutdown.
        assert!(claim_session_lock(&lock), "surviving marker => unclean");
        // A clean release (what RunEvent::Exit does), then a claim = clean again.
        let _ = std::fs::remove_file(&lock);
        assert!(!claim_session_lock(&lock), "after a clean release the next run is clean");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn director_protocol_assigns_contract_ownership() {
        // The director owns the integration contracts, tests the seams, and is the worker's
        // help desk for them (#…). Guard that the standing protocol says so.
        let p = DIRECTOR_PROTOCOL_MD;
        assert!(p.contains("contracts/") || p.contains("contracts directory") || p.contains("INTEGRATION CONTRACTS"),
            "director protocol must claim ownership of the contracts directory");
        assert!(p.contains("TEST THE INTEGRATIONS"), "director protocol must mandate integration testing");
    }

    #[test]
    fn pane_id_format_matches_frontend_convention() {
        // The frontend uses `t${tabIdx}p${paneIdx}` as the pane ID key.
        // Verify the format matches for several indices.
        assert_eq!(format!("t{}p{}", 0, 0), "t0p0");
        assert_eq!(format!("t{}p{}", 1, 3), "t1p3");
        assert_eq!(format!("t{}p{}", 2, 8), "t2p8");
    }

    #[test]
    fn osc7_path_strip_removes_scheme_and_host() {
        // Mirrors what TerminalView.tsx does in the browser:
        // data.replace(/^file:\/\/[^/]*/, "")
        let input = "file://localhost/c/Users/Kevin/project";
        let stripped = input.trim_start_matches("file://").split_once('/')
            .map(|(_, rest)| format!("/{}", rest))
            .unwrap_or_default();
        assert_eq!(stripped, "/c/Users/Kevin/project");
    }

    #[test]
    fn to_native_path_resolves_git_bash_drive_paths_on_windows() {
        // The OSC-7 cwd a bash shell reports (and the app persists) — must round back to a native
        // path so pty_create's is_dir/Command::cwd resolve an EXISTING worktree on restore (#979).
        let bash = "/c/Users/Kevin/.base-studio-code/worktrees/studio-code/base-studio-code--source-experience";
        let got = to_native_path(bash);
        if cfg!(windows) {
            assert_eq!(got, "C:/Users/Kevin/.base-studio-code/worktrees/studio-code/base-studio-code--source-experience");
        } else {
            assert_eq!(got, bash); // no-op off Windows
        }
        // Non-drive POSIX paths and already-native paths pass through unchanged everywhere.
        assert_eq!(to_native_path("/usr/local/bin"), "/usr/local/bin");
        assert_eq!(to_native_path("C:/already/native"), "C:/already/native");
    }

    #[test]
    fn read_skeleton_dir_collects_source_files_recursively() {
        use std::fs;
        let root = std::env::temp_dir().join(format!("bsc_skel_test_{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("parts")).unwrap();
        fs::write(root.join("Login.jsx"), "export default () => null;").unwrap();
        fs::write(root.join("parts/Field.tsx"), "export const F = 1;").unwrap();
        fs::write(root.join("notes.md"), "ignore me").unwrap();        // wrong ext → skipped
        fs::write(root.join("data.json"), "{}").unwrap();

        let files = read_skeleton_dir(&root);
        let keys: Vec<&str> = files.iter().map(|(k, _)| k.as_str()).collect();
        assert!(keys.contains(&"Login.jsx"), "got {keys:?}");
        assert!(keys.contains(&"parts/Field.tsx"), "nested + forward-slash relpath");
        assert!(keys.contains(&"data.json"));
        assert!(!keys.iter().any(|k| k.ends_with(".md")), "non-source files skipped");

        // Missing folder → empty, never panics.
        assert!(read_skeleton_dir(&root.join("nope")).is_empty());
        let _ = fs::remove_dir_all(&root);
    }


    #[test]
    fn ansi_c_quote_wraps_plain_text() {
        assert_eq!(bash_ansi_c_quote("triage the issues"), "$'triage the issues'");
    }

    #[test]
    fn claude_launch_bakes_prompt_fresh() {
        assert_eq!(claude_launch("triage the issues", false), "claude $'triage the issues'");
    }

    #[test]
    fn claude_launch_adds_continue_flag() {
        // Triage resumes the repo's prior conversation instead of starting fresh.
        assert_eq!(claude_launch("triage the issues", true), "claude --continue $'triage the issues'");
    }

    #[test]
    fn worktree_slug_keeps_only_branch_safe_chars() {
        // The slug doubles as a git branch name + worktree dir, and must match the
        // frontend `worktreeSlug` (replace anything outside [A-Za-z0-9._-] with '-').
        assert_eq!(worktree_slug("auth-ui"), "auth-ui");
        assert_eq!(worktree_slug("a.b_c-d"), "a.b_c-d");
        assert_eq!(worktree_slug("API client/2"), "API-client-2");
    }

    #[test]
    fn claude_project_dir_name_replaces_non_alnum_with_dash() {
        // Matches the dir Claude Code creates under ~/.claude/projects.
        assert_eq!(
            claude_project_dir_name(r"C:\Users\Kevin\Projects\rust\base-studio-code"),
            "C--Users-Kevin-Projects-rust-base-studio-code"
        );
        // Consecutive specials (\ then .) each map to their own dash.
        assert_eq!(
            claude_project_dir_name(r"C:\Users\Kevin\.base-studio-code\documents"),
            "C--Users-Kevin--base-studio-code-documents"
        );
    }

    #[test]
    fn ansi_c_quote_escapes_newlines_quotes_and_backslashes() {
        // Newlines collapse to \n so the whole token stays on one physical line;
        // single quotes and backslashes are escaped. $ and backticks pass through
        // literally (ANSI-C quoting does not expand them).
        assert_eq!(
            bash_ansi_c_quote("line1\nit's $HOME `cmd` \\x"),
            "$'line1\\nit\\'s $HOME `cmd` \\\\x'"
        );
    }

    #[test]
    fn parse_github_probe_detects_each_marker_independently() {
        use {GH_AUTH_MARK, GH_PATH_MARK, GIT_PATH_MARK};
        // All three markers present -> (gh, git, auth) all true.
        let all = format!("{GIT_PATH_MARK}
{GH_PATH_MARK}
{GH_AUTH_MARK}
");
        assert_eq!(parse_github_probe(&all), (true, true, true));
        // Empty output (probe found nothing) -> all false.
        assert_eq!(parse_github_probe(""), (false, false, false));
        // git on PATH but gh missing -> gh false, git true, auth false.
        let git_only = format!("{GIT_PATH_MARK}
");
        assert_eq!(parse_github_probe(&git_only), (false, true, false));
        // gh present but unauthenticated -> gh true, git true, auth false.
        let no_auth = format!("{GIT_PATH_MARK}
{GH_PATH_MARK}
");
        assert_eq!(parse_github_probe(&no_auth), (true, true, false));
    }

    #[test]
    fn interpret_preflight_reports_each_prerequisite() {
        use {interpret_preflight, GitBashProbe, GH_AUTH_MARK, PREFLIGHT_MARK};
        // Everything present + authed, on Windows with Git Bash found.
        let stdout = format!(
            "{PREFLIGHT_MARK}\tclaude\t/usr/bin/claude\tclaude 1.2.3\n\
             {PREFLIGHT_MARK}\tgit\t/usr/bin/git\tgit version 2.43.0\n\
             {PREFLIGHT_MARK}\tgh\t/usr/bin/gh\tgh version 2.40.0\n\
             {GH_AUTH_MARK}\n"
        );
        let r = interpret_preflight(&stdout, GitBashProbe::Found("C:\\Git\\bin\\bash.exe".into()));
        // Git Bash first (the console shell), then claude, git, gh, gh auth.
        let names: Vec<&str> = r.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(names, ["Git Bash", "claude", "git", "gh", "gh auth"]);
        assert!(r.iter().all(|p| p.found), "all prerequisites should be found");
        assert!(r.iter().all(|p| p.hint.is_empty()), "found tools carry no hint");
        let git = r.iter().find(|p| p.name == "git").unwrap();
        assert_eq!(git.version.as_deref(), Some("git version 2.43.0"));
        assert_eq!(git.path.as_deref(), Some("/usr/bin/git"));
    }

    #[test]
    fn interpret_preflight_flags_missing_tools_with_hints() {
        use {interpret_preflight, GitBashProbe, PREFLIGHT_MARK};
        // claude + git present; gh missing (empty path), unauthenticated; Git Bash missing.
        let stdout = format!(
            "{PREFLIGHT_MARK}\tclaude\t/usr/bin/claude\tclaude 1.2.3\n\
             {PREFLIGHT_MARK}\tgit\t/usr/bin/git\tgit version 2.43.0\n\
             {PREFLIGHT_MARK}\tgh\t\t\n"
        );
        let r = interpret_preflight(&stdout, GitBashProbe::Missing);
        let gh = r.iter().find(|p| p.name == "gh").unwrap();
        assert!(!gh.found);
        assert!(gh.hint.contains("cli.github.com"));
        let gh_auth = r.iter().find(|p| p.name == "gh auth").unwrap();
        assert!(!gh_auth.found, "gh missing -> auth cannot be reported found");
        assert!(!gh_auth.hint.is_empty());
        let gitbash = r.iter().find(|p| p.name == "Git Bash").unwrap();
        assert!(!gitbash.found);
        assert!(gitbash.hint.contains("git-scm.com"));
        // Present tools still carry their version/path even when others are missing.
        assert!(r.iter().find(|p| p.name == "claude").unwrap().found);
    }

    #[test]
    fn interpret_preflight_omits_git_bash_off_windows() {
        use {interpret_preflight, GitBashProbe};
        let r = interpret_preflight("", GitBashProbe::NotApplicable);
        assert!(!r.iter().any(|p| p.name == "Git Bash"));
        // Empty probe -> every CLI tool reported missing with a hint.
        let names: Vec<&str> = r.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(names, ["claude", "git", "gh", "gh auth"]);
        assert!(r.iter().all(|p| !p.found));
        assert!(r.iter().all(|p| !p.hint.is_empty()));
    }

    #[test]
    fn interpret_preflight_gh_auth_requires_gh_present() {
        // A stale GH_AUTH_OK marker must NOT report auth when gh itself is absent.
        use {interpret_preflight, GitBashProbe, GH_AUTH_MARK, PREFLIGHT_MARK};
        let stdout = format!("{PREFLIGHT_MARK}\tgh\t\t\n{GH_AUTH_MARK}\n");
        let r = interpret_preflight(&stdout, GitBashProbe::NotApplicable);
        assert!(!r.iter().find(|p| p.name == "gh auth").unwrap().found);
    }

    #[test]
    fn ensure_session_settings_merges_mandatory_and_custom_commands() {
        use crate::console::settings::write_session_settings;
        let dir = std::env::temp_dir().join(format!("bsc-ess-{}", std::process::id()));
        let settings = dir.join(".claude").join("settings.json");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join(".claude")).unwrap();
        // Seed an existing setting that must be preserved (not clobbered).
        std::fs::write(
            &settings,
            r#"{"model":"claude-sonnet-4-6","permissions":{"allow":["Read"],"deny":["WebSearch"]}}"#,
        ).unwrap();

        write_session_settings(
            &dir.to_string_lossy(),
            &["cargo".into(), "git".into()],
            &["scp".into()],
            &[],
            &[],
            &[],
            &[],
            &[],
            &[],
            false,
            "allow",
        ).unwrap();

        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&settings).unwrap()).unwrap();
        let allow: Vec<String> = v["permissions"]["allow"].as_array().unwrap()
            .iter().map(|x| x.as_str().unwrap().to_string()).collect();
        let deny: Vec<String> = v["permissions"]["deny"].as_array().unwrap()
            .iter().map(|x| x.as_str().unwrap().to_string()).collect();
        // Pre-existing entries are preserved (merged, not clobbered).
        assert!(allow.contains(&"Read".to_string()));
        assert!(deny.contains(&"WebSearch".to_string()));
        assert_eq!(v["model"], "claude-sonnet-4-6");
        // Bash is allowed broadly (start-and-go) plus explicit gh/git/custom rules.
        assert!(allow.contains(&"Bash".to_string()));
        assert!(allow.contains(&"Bash(gh *)".to_string()));
        assert!(allow.contains(&"Bash(git *)".to_string()));
        assert!(allow.contains(&"Bash(bsc-plan *)".to_string())); // the plan-store CLI (#plan-db)
        assert!(allow.contains(&"Bash(cargo *)".to_string()));
        assert_eq!(allow.iter().filter(|r| *r == "Bash(git *)").count(), 1);
        // Curated dangerous defaults plus the user deny are present.
        assert!(deny.contains(&"Bash(sudo *)".to_string()));
        assert!(deny.contains(&"Bash(rm -rf /*)".to_string()));
        assert!(deny.contains(&"Bash(scp *)".to_string()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// #1572: bash_posture scales the auto-approve set — `allow` doers get the read-only AND
    /// build baselines + the bare `Bash`; `ask` coordinators get read-only only (build/unlisted
    /// prompt); `deny` gets neither baseline. The mandatory + per-stream granted commands are
    /// always present.
    #[test]
    fn write_session_settings_bash_posture_scales_the_baseline() {
        use crate::console::settings::write_session_settings;
        let base = std::env::temp_dir().join(format!("bsc-ess-posture-{}", std::process::id()));
        let read_allow = |dir: &std::path::Path| -> Vec<String> {
            let v: serde_json::Value = serde_json::from_str(
                &std::fs::read_to_string(dir.join(".claude").join("settings.json")).unwrap()).unwrap();
            v["permissions"]["allow"].as_array().unwrap().iter().map(|x| x.as_str().unwrap().to_string()).collect()
        };
        for (posture, want_ro, want_build, want_bare) in [
            ("allow", true, true, true),
            ("ask",   true, false, false),
            ("deny",  false, false, false),
        ] {
            let dir = base.join(posture);
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(dir.join(".claude")).unwrap();
            // Grant a project-specific command in every posture — it must ALWAYS be present.
            write_session_settings(&dir.to_string_lossy(), &["terraform".into()], &[],
                &[], &[], &[], &[], &[], &[], false, posture).unwrap();
            let allow = read_allow(&dir);
            assert_eq!(allow.contains(&"Bash(ls *)".to_string()), want_ro, "{posture}: read-only baseline");
            assert_eq!(allow.contains(&"Bash(cargo *)".to_string()), want_build, "{posture}: build baseline");
            assert_eq!(allow.contains(&"Bash".to_string()), want_bare, "{posture}: bare Bash");
            assert!(allow.contains(&"Bash(terraform *)".to_string()), "{posture}: granted command always present");
            assert!(allow.contains(&"Bash(git *)".to_string()), "{posture}: mandatory git always present");
        }
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn write_session_settings_writes_ask_tier_for_hard_push_gate() {
        use crate::console::settings::write_session_settings;
        let dir = std::env::temp_dir().join(format!("bsc-ess-ask-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join(".claude")).unwrap();

        // A hard push-confirm flow (#297) asks before push/PR: the rules land in
        // permissions.ask (deny > ask > allow), so they prompt under the broad Bash allow.
        write_session_settings(
            &dir.to_string_lossy(),
            &[],
            &[],
            &[],
            &[],
            &[],
            &[],
            &["Bash(git push *)".into(), "Bash(gh pr create *)".into()],
            &[],
            false,
            "allow",
        ).unwrap();

        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join(".claude").join("settings.json")).unwrap()).unwrap();
        let ask: Vec<String> = v["permissions"]["ask"].as_array().unwrap()
            .iter().map(|x| x.as_str().unwrap().to_string()).collect();
        assert!(ask.contains(&"Bash(git push *)".to_string()));
        assert!(ask.contains(&"Bash(gh pr create *)".to_string()));
        // Bash stays broadly allowed; ask only narrows the two push writes.
        let allow: Vec<String> = v["permissions"]["allow"].as_array().unwrap()
            .iter().map(|x| x.as_str().unwrap().to_string()).collect();
        assert!(allow.contains(&"Bash".to_string()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_session_settings_merges_verbatim_tool_rules() {
        use crate::console::settings::write_session_settings;
        let dir = std::env::temp_dir().join(format!("bsc-ess-tool-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join(".claude")).unwrap();

        // The role write-path guard: deny every write tool (planner/director/triage),
        // and auto-approve a worker's boundary glob.
        write_session_settings(
            &dir.to_string_lossy(),
            &[],
            &[],
            &[],
            &[],
            &["Edit(src/auth/**)".into(), "Write(src/auth/**)".into()],
            &["Edit".into(), "Write".into(), "MultiEdit".into(), "NotebookEdit".into()],
            &[],
            &[],
            false,
            "allow",
        ).unwrap();

        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join(".claude").join("settings.json")).unwrap()).unwrap();
        let allow: Vec<String> = v["permissions"]["allow"].as_array().unwrap()
            .iter().map(|x| x.as_str().unwrap().to_string()).collect();
        let deny: Vec<String> = v["permissions"]["deny"].as_array().unwrap()
            .iter().map(|x| x.as_str().unwrap().to_string()).collect();
        // Tool rules land verbatim — NOT wrapped in Bash(...).
        assert!(allow.contains(&"Edit(src/auth/**)".to_string()));
        assert!(allow.contains(&"Write(src/auth/**)".to_string()));
        assert!(!allow.iter().any(|r| r.contains("Bash(Edit")));
        assert!(deny.contains(&"Edit".to_string()));
        assert!(deny.contains(&"Write".to_string()));
        assert!(deny.contains(&"MultiEdit".to_string()));
        assert!(deny.contains(&"NotebookEdit".to_string()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_session_settings_replace_drops_removed_permissions() {
        use crate::console::settings::write_session_settings;
        let dir = std::env::temp_dir().join(format!("bsc-ess-replace-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join(".claude")).unwrap();
        let cwd = dir.to_string_lossy();
        let read = || -> Vec<String> {
            let v: serde_json::Value = serde_json::from_str(
                &std::fs::read_to_string(dir.join(".claude").join("settings.json")).unwrap()).unwrap();
            v["permissions"]["allow"].as_array().unwrap().iter().map(|x| x.as_str().unwrap().to_string()).collect()
        };

        // First pass grants a custom command (merge mode). Use a command NOT in the baselines
        // (`terraform`) so the drop is observable — a baseline command would be re-added anyway.
        write_session_settings(&cwd, &["terraform".into()], &[], &[], &[], &[], &[], &[], &[], false, "allow").unwrap();
        assert!(read().contains(&"Bash(terraform *)".to_string()));

        // Re-apply with the command REMOVED — replace mode must drop it (merge would keep it).
        write_session_settings(&cwd, &[], &[], &[], &[], &[], &[], &[], &[], true, "allow").unwrap();
        let allow = read();
        assert!(!allow.contains(&"Bash(terraform *)".to_string()), "replace must drop the removed command (#799)");
        assert!(allow.contains(&"Bash".to_string()), "but the broad Bash allow is recomputed");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_session_settings_writes_mcp_servers_and_hooks() {
        let dir = std::env::temp_dir().join(format!("bsc-ext-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let mcp = vec![
            McpServerCfg {
                name: "filesystem".into(), transport: "stdio".into(),
                command: Some("npx".into()), args: vec!["-y".into(), "@mcp/fs".into()],
                url: None, env: vec![("ROOT".into(), "/tmp".into())],
            },
            McpServerCfg {
                name: "sentry".into(), transport: "http".into(),
                command: None, args: vec![], url: Some("https://mcp.sentry.dev/sse".into()), env: vec![],
            },
        ];
        let hooks = vec![HookCfg {
            event: "PostToolUse".into(), matcher: "Write|Edit".into(), command: "format.sh".into(),
        }];
        write_session_settings(&dir.to_string_lossy(), &[], &[], &mcp, &hooks, &[], &[], &[], &[], false, "allow").unwrap();

        // .mcp.json carries both servers in the right transport shapes.
        let mcp_json: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join(".mcp.json")).unwrap()).unwrap();
        assert_eq!(mcp_json["mcpServers"]["filesystem"]["command"], "npx");
        assert_eq!(mcp_json["mcpServers"]["filesystem"]["args"][1], "@mcp/fs");
        assert_eq!(mcp_json["mcpServers"]["filesystem"]["env"]["ROOT"], "/tmp");
        assert_eq!(mcp_json["mcpServers"]["sentry"]["type"], "http");
        assert_eq!(mcp_json["mcpServers"]["sentry"]["url"], "https://mcp.sentry.dev/sse");

        // settings.json gates the servers + carries the hook grouped by event.
        let settings: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join(".claude").join("settings.json")).unwrap()).unwrap();
        let enabled: Vec<String> = settings["enabledMcpjsonServers"].as_array().unwrap()
            .iter().map(|x| x.as_str().unwrap().to_string()).collect();
        assert!(enabled.contains(&"filesystem".to_string()) && enabled.contains(&"sentry".to_string()));
        assert_eq!(settings["hooks"]["PostToolUse"][0]["matcher"], "Write|Edit");
        assert_eq!(settings["hooks"]["PostToolUse"][0]["hooks"][0]["command"], "format.sh");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn resolve_mcp_command_substitutes_research_marker(){
        use std::path::PathBuf;
        // A normal command is untouched.
        assert_eq!(resolve_mcp_command("npx", None), "npx");
        assert_eq!(
            resolve_mcp_command("npx", Some(PathBuf::from("/x/bsc-research-mcp"))),
            "npx",
        );
        // The Research marker resolves to the bundled binary's absolute path when present…
        let bin = PathBuf::from("/opt/app/bsc-research-mcp");
        assert_eq!(resolve_mcp_command("bsc-research-mcp", Some(bin.clone())), bin.to_string_lossy());
        // …and falls back to the bare marker when the bundled binary can't be located (dev build).
        assert_eq!(resolve_mcp_command("bsc-research-mcp", None), "bsc-research-mcp");
        // The Compliance marker (#1005) resolves the same way through its own bundled path.
        let comp = PathBuf::from("/opt/app/bsc-compliance-mcp");
        assert_eq!(resolve_mcp_command("bsc-compliance-mcp", Some(comp.clone())), comp.to_string_lossy());
        assert_eq!(resolve_mcp_command("bsc-compliance-mcp", None), "bsc-compliance-mcp");
    }

    #[test]
    fn write_session_skills_writes_skill_files() {
        let dir = std::env::temp_dir().join(format!("bsc-skills-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let skills = vec![
            SkillCfg {
                name: "Open a clean PR".into(),
                description: "Open a tidy pull request".into(),
                prompt: "Do the PR steps.".into(),
                tools: vec!["create_pr".into(), "git_diff".into()],
            },
            SkillCfg {
                name: "Review Docs".into(),
                description: "Review the docs".into(),
                prompt: "Check the docs.".into(),
                tools: vec![],
            },
        ];
        write_session_skills(&dir, &skills).unwrap();

        // First skill: slugged dir, frontmatter with name/description/allowed-tools, body.
        let a = std::fs::read_to_string(
            dir.join(".claude").join("skills").join("open-a-clean-pr").join("SKILL.md"),
        ).unwrap();
        assert!(a.starts_with("---\n"));
        assert!(a.contains("name: \"Open a clean PR\"\n"));
        assert!(a.contains("description: \"Open a tidy pull request\"\n"));
        assert!(a.contains("allowed-tools: \"create_pr, git_diff\"\n"));
        assert!(a.contains("Do the PR steps."));

        // Second skill: no tools → no allowed-tools line, body still present.
        let b = std::fs::read_to_string(
            dir.join(".claude").join("skills").join("review-docs").join("SKILL.md"),
        ).unwrap();
        assert!(b.contains("name: \"Review Docs\"\n"));
        assert!(b.contains("description: \"Review the docs\"\n"));
        assert!(!b.contains("allowed-tools:"));
        assert!(b.contains("Check the docs."));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn sanitize_preserves_ascii_alphanumerics_and_dash() {
        assert_eq!(sanitize_project_key("my-project-123"), "my-project-123");
    }

    #[test]
    fn sanitize_replaces_punctuation_and_whitespace_with_underscore() {
        // Slashes, spaces, colons, dots → '_'.
        assert_eq!(sanitize_project_key("acme/api"), "acme_api");
        assert_eq!(sanitize_project_key("title::pitch"), "title__pitch");
        assert_eq!(sanitize_project_key("Studio Code v2.0"), "Studio_Code_v2_0");
    }

    #[test]
    fn sanitize_preserves_github_project_node_id() {
        // Project v2 node ids (underscores stay underscores, dash stays) are ASCII-safe.
        assert_eq!(sanitize_project_key("PVT_kwHOA_-LFc4BYsJC"), "PVT_kwHOA_-LFc4BYsJC");
    }

    #[test]
    fn sanitize_drops_unicode_letters_to_match_js_regex() {
        // The frontend's /[^a-zA-Z0-9-]/ is ASCII-only; café → caf_ (not café),
        // so the PTY id and planning directory stay byte-for-byte identical.
        assert_eq!(sanitize_project_key("café"), "caf_");
    }

    #[test]
    fn sanitize_truncates_to_80_chars() {
        let long = "a".repeat(200);
        assert_eq!(sanitize_project_key(&long).len(), 80);
    }

    #[test]
    fn project_dir_places_the_sanitized_key_directly_under_projects() {
        // Every hub lives at projects/<key> for life (#922) — no draft/ root, no documents/ prefix.
        let p = project_dir("studio-code").to_string_lossy().replace('\\', "/");
        assert!(p.ends_with("/projects/studio-code"), "got {p}");
        assert!(!p.contains("/documents/"), "got {p}");
        let s = project_dir("acme/api project").to_string_lossy().replace('\\', "/");
        assert!(s.ends_with("/projects/acme_api_project"), "got {s}");
    }

    #[test]
    fn mark_published_writes_an_in_place_marker_read_by_is_published() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = temp_home("marker");
        let key = "publish-me";
        // A live hub with a plan file (simulating the planner's cwd) — never moved.
        write_file(&project_dir(key).join("goal.md"), "# goal");
        assert!(!is_published(key), "a fresh hub is a draft");

        mark_published(key.to_string()).unwrap();
        assert!(is_published(key), "marker present after mark_published");
        assert!(project_dir(key).join(".published").is_file());
        // The hub did not move: its files stay put (so the planner's cwd + Claude history survive).
        assert!(project_dir(key).join("goal.md").exists(), "files stay in place");
        // Idempotent.
        mark_published(key.to_string()).unwrap();
        assert!(is_published(key));
        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn migration_consolidates_draft_hubs_and_clears_empty_published_shells() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = temp_home("migrate");
        let draft_root = bsc_base_dir().join("draft");

        // (1) A plain draft → moved into projects/.
        write_file(&draft_root.join("plain").join("goal.md"), "# plain goal");
        // (2) The overdrive case: real hub in draft/, empty shell in projects/ → shell cleared, hub wins.
        write_file(&draft_root.join("overdrive").join("CLAUDE.md"), "spec");
        std::fs::create_dir_all(project_dir("overdrive").join("prompts")).unwrap();
        // (3) A real published hub colliding with a stale same-key draft → published kept, draft dropped.
        write_file(&project_dir("shipped").join("CLAUDE.md"), "published spec");
        write_file(&draft_root.join("shipped").join("goal.md"), "stale draft");

        migrate_draft_hubs_into_projects();

        // (1) consolidated.
        assert!(project_dir("plain").join("goal.md").exists(), "plain draft moved into projects/");
        // (2) the real overdrive hub replaced the empty shell.
        assert!(project_dir("overdrive").join("CLAUDE.md").exists(), "real overdrive hub moved in");
        assert!(!project_dir("overdrive").join("prompts").exists(), "empty shell cleared");
        // (3) published kept, stale draft content not clobbered in.
        assert_eq!(std::fs::read_to_string(project_dir("shipped").join("CLAUDE.md")).unwrap(), "published spec");
        // draft/ root retired.
        assert!(!draft_root.exists(), "draft/ root removed after migration");
        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn ingest_section_files_reads_both_dirs_and_discovery_wins() {
        use std::collections::HashMap;
        let root = std::env::temp_dir().join(format!("bsc-ingest-{}", std::process::id()));
        let discovery = root.join("discovery");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&discovery).unwrap();

        // Hub root: a manifest (json) + a stale flat copy of `stack` + a control file.
        std::fs::write(root.join("phases.json"), r#"{"phases":[]}"#).unwrap();
        std::fs::write(root.join("stack.md"), "OLD flat stack").unwrap();
        std::fs::write(root.join("CLAUDE.md"), "the planner spec").unwrap();
        // An empty section is a created-but-unwritten ghost and must be dropped.
        std::fs::write(root.join("empty.md"), "   \n").unwrap();
        // discovery/: the discovery sections (one shadows the stale root `stack`).
        std::fs::write(discovery.join("goal.md"), "ship it").unwrap();
        std::fs::write(discovery.join("stack.md"), "NEW discovery stack").unwrap();

        let mut sections: HashMap<String, String> = HashMap::new();
        ingest_section_files(&root, &mut sections);
        ingest_section_files(&discovery, &mut sections);

        assert_eq!(sections.get("phases").map(String::as_str), Some(r#"{"phases":[]}"#));
        assert_eq!(sections.get("goal").map(String::as_str), Some("ship it"));
        // discovery/ is ingested last, so its section wins over the stale flat copy.
        assert_eq!(sections.get("stack").map(String::as_str), Some("NEW discovery stack"));
        // Control files and empty sections never become sections.
        assert!(!sections.contains_key("CLAUDE"));
        assert!(!sections.contains_key("empty"));

        let _ = std::fs::remove_dir_all(&root);
    }

    use crate::app::run::level_color;

    #[test]
    fn level_color_is_distinct_per_level() {
        let colors = [
            level_color(log::Level::Error),
            level_color(log::Level::Warn),
            level_color(log::Level::Info),
            level_color(log::Level::Debug),
            level_color(log::Level::Trace),
        ];
        // every code is a non-empty ANSI escape, and all five are distinct
        assert!(colors.iter().all(|c| c.starts_with("\x1b[")));
        let unique: std::collections::HashSet<_> = colors.iter().collect();
        assert_eq!(unique.len(), colors.len());
    }

    use crate::agent::launch::has_claude_history;

    #[test]
    fn has_claude_history_detects_jsonl_in_project_dir() {
        let _guard = ENV_LOCK.lock().unwrap();
        let home = temp_home("history");
        let cwd = r"C:\Users\Kevin\Projects\demo";
        let proj = home.join(".claude").join("projects").join(claude_project_dir_name(cwd));

        // No project dir yet → fresh launch.
        assert!(!has_claude_history(cwd));

        // Dir exists but holds no conversation → still fresh.
        std::fs::create_dir_all(&proj).unwrap();
        write_file(&proj.join("config.json"), "{}");
        assert!(!has_claude_history(cwd));

        // A conversation transcript is present → resume is safe.
        write_file(&proj.join("abc-123.jsonl"), "{}\n");
        assert!(has_claude_history(cwd));

        // Empty cwd is never resumable.
        assert!(!has_claude_history(""));
    }

    #[test]
    fn bsc_agent_session_path_keys_off_cwd() {
        // Deterministic per-cwd path under agent-sessions/, slugged like Claude's projects dir.
        let _guard = ENV_LOCK.lock().unwrap();
        let _home = temp_home("agentsess-path");
        let cwd = r"C:\Users\Kevin\Projects\demo";
        let p = bsc_agent_session_path(cwd).unwrap();
        assert!(p.ends_with("conversation.json"));
        let s = p.to_string_lossy().replace('\\', "/");
        assert!(s.contains("/agent-sessions/"));
        assert!(s.contains(&claude_project_dir_name(cwd)));
        // Empty cwd ⇒ no path (no persistence).
        assert!(bsc_agent_session_path("").is_none());
    }

    #[test]
    fn has_bsc_agent_history_requires_nonempty_session_file() {
        let _guard = ENV_LOCK.lock().unwrap();
        let _home = temp_home("agentsess-hist");
        let cwd = r"C:\Users\Kevin\Projects\demo";
        let path = bsc_agent_session_path(cwd).unwrap();

        // No file yet → fresh.
        assert!(!has_bsc_agent_history(cwd));

        // Empty file → still fresh (an aborted/empty run shouldn't trigger resume).
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        write_file(&path, "");
        assert!(!has_bsc_agent_history(cwd));

        // Non-empty conversation → resume is safe.
        write_file(&path, "[{\"User\":\"hi\"}]");
        assert!(has_bsc_agent_history(cwd));

        // Empty cwd is never resumable.
        assert!(!has_bsc_agent_history(""));
    }

    #[test]
    fn worktree_audit_commands_tolerate_empty_cwd() {
        // The per-worker audit snapshot (#920) must never panic on a missing/blank cwd —
        // it just yields nothing so the UI shows "no data" rather than crashing.
        assert!(read_worktree_branch(String::new()).is_empty());
        assert!(read_worktree_branch("   ".into()).is_empty());
        assert!(read_worktree_commits(String::new(), 10).is_empty());
        assert!(read_worktree_commits("   ".into(), 10).is_empty());
        assert!(claude_transcript_path(String::new()).is_none());
        assert!(find_branch_pr(String::new(), "branch".into()).is_none());
        assert!(find_branch_pr("owner/repo".into(), String::new()).is_none());
    }

    #[test]
    fn merge_change_lists_dedupes_and_sorts() {
        let merged = merge_change_lists(
            vec!["src/b.ts".into(), "src/a.ts".into(), "src/b.ts".into()],
            vec!["new.ts".into(), "src/a.ts".into()],
        );
        assert_eq!(merged, vec!["new.ts", "src/a.ts", "src/b.ts"]);
        // Empty inputs yield an empty set.
        assert!(merge_change_lists(vec![], vec![]).is_empty());
    }

    #[test]
    fn read_worktree_changes_empty_cwd_is_empty() {
        assert!(read_worktree_changes(String::new()).is_empty());
        assert!(read_worktree_changes("   ".into()).is_empty());
    }

    /// Regression (#1102): in a linked worktree `.git` is a FILE, so the old
    /// `repo_root/.git/info/exclude` write silently failed and `.mcp.json` leaked into the worker's
    /// diff — quarantining every fleet worker for an "out-of-lane" edit it never made. git_exclude
    /// must resolve the real (common-dir) exclude so the app-managed file is hidden from git, and
    /// thus from read_worktree_changes (the warden's trusted signal).
    #[test]
    fn git_exclude_hides_mcp_json_in_a_worktree() {
        // Needs the git binary; skip gracefully where it's absent rather than failing the suite.
        if std::process::Command::new("git").arg("--version").output().is_err() {
            return;
        }
        let base = std::env::temp_dir().join(format!("bsc-gx-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let main = base.join("main");
        std::fs::create_dir_all(&main).unwrap();
        let git = |cwd: &std::path::Path, args: &[&str]| {
            std::process::Command::new("git").arg("-C").arg(cwd).args(args).output().unwrap()
        };
        git(&main, &["init", "-q"]);
        git(&main, &["config", "user.email", "t@t.t"]);
        git(&main, &["config", "user.name", "t"]);
        std::fs::write(main.join("README.md"), "x").unwrap();
        git(&main, &["add", "-A"]);
        git(&main, &["commit", "-qm", "init"]);

        // A linked worktree: its `.git` is a FILE, the layout that broke the old exclude.
        let wt = base.join("wt");
        git(&main, &["worktree", "add", "-q", wt.to_str().unwrap()]);
        assert!(wt.join(".git").is_file(), "worktree .git should be a file, not a dir");

        // App writes the session's MCP config + asks git to exclude it (mirrors the launch path).
        std::fs::write(wt.join(".mcp.json"), "{}").unwrap();
        git_exclude(&wt, ".mcp.json");

        // The warden's signal must NOT see it — pre-fix this listed ".mcp.json" and tripped a trip.
        let changes = read_worktree_changes(wt.to_string_lossy().into_owned());
        assert!(
            !changes.iter().any(|f| f == ".mcp.json"),
            "worktree .mcp.json must be git-excluded, but read_worktree_changes returned {changes:?}",
        );

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn clear_project_plan_files_removes_md_and_json_only() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = temp_home("cpf");
        let key = "test-plan-clear".to_string();
        let proj = bsc_base_dir().join("projects").join(&key);
        let sub = proj.join("my-repo");
        std::fs::create_dir_all(&sub).unwrap();
        write_file(&proj.join("goal.md"), "goal");
        write_file(&proj.join("phases.json"), "[]");
        write_file(&sub.join("README.md"), "# repo"); // inside subdir -- preserved
        // a generated UI skeleton that must be wiped too (#650)
        let skel = proj.join(".ui-skeleton");
        std::fs::create_dir_all(&skel).unwrap();
        write_file(&skel.join("Home.jsx"), "export default () => null");

        let removed = clear_project_plan_files(key.clone()).unwrap();
        assert_eq!(removed, 3, "goal.md + phases.json + .ui-skeleton removed");
        assert!(!proj.join("goal.md").exists());
        assert!(!proj.join("phases.json").exists());
        assert!(!skel.exists(), ".ui-skeleton dir wiped");
        assert!(sub.join("README.md").exists(), "subdir entry preserved");

        // Missing project -> Ok(0), no panic.
        let n = clear_project_plan_files("no-such-bsc-cpf-key".to_string()).unwrap();
        assert_eq!(n, 0);

        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn clear_project_plan_files_empties_the_plan_db() {
        // The plan now lives in plan.db, not files — clearing must empty it too, or the next poll
        // re-reads the DB and the plan reappears (#plan-db).
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = temp_home("cpfdb");
        let key = "test-clear-plan-db".to_string();
        let db = project_dir(&key).join("plan.db");
        {
            let store = plandb::Store::open(&db).unwrap();
            store.upsert(&plandb::PlanIssue { r#ref: "F1".into(), title: "issue".into(), ..Default::default() }).unwrap();
            store.feature_upsert(&plandb::PlanFeature { name: "Feature".into(), ..Default::default() }).unwrap();
        }
        clear_project_plan_files(key.clone()).unwrap();
        let store = plandb::Store::open(&db).unwrap();
        assert!(store.list(None, None).unwrap().is_empty(), "issues cleared from the DB");
        assert!(store.feature_list().unwrap().is_empty(), "features cleared from the DB");

        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn blueprint_storage_round_trips_and_stays_in_its_dir() {
        // User blueprints live as files under ~/.base-studio-code/blueprints/ (#blueprints).
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = temp_home("bp");
        write_blueprint("bp-1".into(), r#"{"id":"bp-1","name":"Mine"}"#.into()).unwrap();
        write_blueprint("bp-2".into(), r#"{"id":"bp-2","name":"Other"}"#.into()).unwrap();
        let all = list_blueprints();
        assert_eq!(all.len(), 2);
        assert!(all.iter().any(|s| s.contains("Mine")));
        delete_blueprint("bp-1".into()).unwrap();
        let after = list_blueprints();
        assert_eq!(after.len(), 1);
        assert!(after.iter().all(|s| !s.contains("Mine")), "deleted blueprint is gone");
        // The slug guard now lives in the `bsc-blueprint` crate (one definition, #1761) — the app
        // commands delegate to it. A slashy/dotty id is slugified (`.`/`/` → `_`) so it can never
        // escape the blueprints dir, and an empty id is rejected outright.
        let store = bsc_blueprint::Store::new(bsc_base_dir().join("blueprints"));
        let escaped = store.file("../../etc/passwd").unwrap();
        assert!(escaped.starts_with(bsc_base_dir().join("blueprints")), "must stay under blueprints/");
        assert!(store.file("").is_err());
        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn list_local_projects_surfaces_on_disk_unpublished_projects() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = temp_home("llp");
        let root = bsc_base_dir().join("projects");
        // A real project: goal.md drives the title (first sentence, heading stripped).
        write_file(&root.join("monkeys-paw").join("goal.md"), "# A wish-granting app.\n\nmore");
        // A project with only CLAUDE.md still counts as has_plan, title falls back to humanized key.
        write_file(&root.join("artist_portfolio").join("CLAUDE.md"), "spec");
        // A bare scaffold dir (no plan artifacts) is listed but flagged has_plan=false.
        std::fs::create_dir_all(root.join("empty-scaffold").join("prompts")).unwrap();

        let found = list_local_projects().unwrap();
        let by = |k: &str| found.iter().find(|p| p.key == k);
        assert_eq!(by("monkeys-paw").unwrap().title, "A wish-granting app");
        assert!(by("monkeys-paw").unwrap().has_plan);
        assert_eq!(by("artist_portfolio").unwrap().title, "artist portfolio");
        assert!(by("artist_portfolio").unwrap().has_plan);
        assert!(!by("empty-scaffold").unwrap().has_plan, "bare scaffold flagged has_plan=false");

        // The wire format MUST be camelCase — Tauri doesn't rename return fields, and the
        // frontend reads `hasPlan`/`updatedAt`. snake_case here silently hides every project (#789).
        let json = serde_json::to_string(by("monkeys-paw").unwrap()).unwrap();
        assert!(json.contains("\"hasPlan\""), "expected camelCase hasPlan in {json}");
        assert!(json.contains("\"updatedAt\""), "expected camelCase updatedAt in {json}");
        assert!(!json.contains("has_plan") && !json.contains("updated_at"), "must not emit snake_case: {json}");

        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn delete_project_dir_removes_a_dir_with_a_read_only_file() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = temp_home("dpd");
        let key = "doomed-proj".to_string();
        let proj = bsc_base_dir().join("projects").join(&key);
        // Simulate a cloned repo's read-only git pack file — the Windows delete failure mode.
        let f = proj.join("repo").join("objects").join("pack.idx");
        write_file(&f, "packdata");
        let mut perms = std::fs::metadata(&f).unwrap().permissions();
        perms.set_readonly(true);
        std::fs::set_permissions(&f, perms).unwrap();

        crate::project::hub::delete_project_dir_impl(&key, &crate::pty::PtyState::new()).unwrap();
        assert!(!proj.exists(), "project dir (incl. read-only files) should be deleted");

        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn project_file_write_then_read_roundtrips_and_blocks_escape() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = temp_home("ppf");
        let key = "test-pipeline-files".to_string();

        // Write nested under a pipeline subdir, then read the subdir back.
        write_project_file(key.clone(), "pipelines/vue/button.vue".to_string(), "<template/>".to_string()).unwrap();
        write_project_file(key.clone(), "pipelines/vue/card.vue".to_string(), "<card/>".to_string()).unwrap();
        // A fresh project's hub is the draft hub (#904) — resolve, don't hardcode projects/.
        let proj = project_dir(&key);
        assert!(proj.join("pipelines").join("vue").join("button.vue").exists());

        let mut files = read_project_files(key.clone(), "pipelines/vue".to_string());
        files.sort();
        assert_eq!(files.len(), 2);
        assert_eq!(files[0].0, "button.vue");
        assert_eq!(files[0].1, "<template/>");

        // Escapes are rejected on write and yield empty on read.
        assert!(write_project_file(key.clone(), "../escape.txt".to_string(), "x".to_string()).is_err());
        assert!(write_project_file(key.clone(), "/abs.txt".to_string(), "x".to_string()).is_err());
        assert!(write_project_file(key.clone(), "  ".to_string(), "x".to_string()).is_err());
        assert!(read_project_files(key.clone(), "../..".to_string()).is_empty());

        // Missing subdir -> empty, no panic.
        assert!(read_project_files(key.clone(), "pipelines/none".to_string()).is_empty());

        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn inject_skills_inlines_hub_skills_idempotently() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = temp_home("injectskills");
        let hub = home.join("hub");
        std::fs::create_dir_all(&hub).unwrap();
        let wt_local = home.join("CLAUDE.local.md");
        std::fs::write(&wt_local, "# repo plan\n").unwrap();

        // No skills.md ⇒ no-op.
        inject_skills(&hub, &wt_local);
        assert_eq!(std::fs::read_to_string(&wt_local).unwrap(), "# repo plan\n");

        // With skills.md ⇒ inlined under its heading.
        std::fs::write(hub.join("skills.md"), "# Attached skills & knowledge\n\n### Auth\nUse OAuth.\n").unwrap();
        inject_skills(&hub, &wt_local);
        let after = std::fs::read_to_string(&wt_local).unwrap();
        assert!(after.contains("# repo plan"), "keeps the plan");
        assert!(after.contains("Use OAuth."), "inlines the skills");

        // Second call ⇒ idempotent (not appended twice).
        inject_skills(&hub, &wt_local);
        assert_eq!(after, std::fs::read_to_string(&wt_local).unwrap());

        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn worker_context_appends_injection_resistance_idempotently() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = temp_home("injresist");
        let wt = home.join("wt");
        let clone = home.join("clone");
        let hub = home.join("hub");
        for d in [&wt, &clone, &hub] { std::fs::create_dir_all(d).unwrap(); }

        write_worker_context(&wt, &clone, &hub, Some("# scope: owns src/api/**"));
        let md = std::fs::read_to_string(wt.join("CLAUDE.local.md")).unwrap();
        assert!(md.contains("# scope: owns src/api/**"), "keeps the worker scope");
        assert!(md.contains(INJECTION_RESISTANCE_MARKER), "appends the injection-resistance preamble");
        assert!(md.contains("untrusted data"), "carries the untrusted-input rule");

        // Re-running converges (the preamble isn't appended twice).
        write_worker_context(&wt, &clone, &hub, Some("# scope: owns src/api/**"));
        let again = std::fs::read_to_string(wt.join("CLAUDE.local.md")).unwrap();
        assert_eq!(again.matches(INJECTION_RESISTANCE_MARKER).count(), 1, "preamble appears once");

        std::fs::remove_dir_all(&home).ok();
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

    #[test]
    fn mcp_install_dir_slugifies_and_stays_under_mcp_root() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = temp_home("mcpdir");
        let root = bsc_base_dir().join("mcp");
        // A normal repo name lands directly under mcp/.
        assert_eq!(mcp_install_dir("compliance-mcp-server").unwrap(), root.join("compliance-mcp-server"));
        // Path separators are slugified to `_`, so a traversal attempt collapses to a single
        // literal dir name DIRECTLY under mcp/ — it can't escape (the `..` substring that
        // survives is just part of a leaf filename, not a real parent ref).
        let evil = mcp_install_dir("../../etc/passwd").unwrap();
        assert_eq!(evil.parent(), Some(root.as_path()), "must be a direct child of mcp/: {evil:?}");
        let leaf = evil.file_name().unwrap().to_string_lossy();
        assert!(!leaf.contains('/') && !leaf.contains('\\'), "no separators survive the slug: {leaf}");
        // Empty / dot names are rejected.
        assert!(mcp_install_dir("").is_err());
        assert!(mcp_install_dir(".").is_err());
        assert!(mcp_install_dir("..").is_err());
        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn mcp_build_command_detects_the_toolchain() {
        let base = std::env::temp_dir().join(format!("bsc-mcpbuild-{}", std::process::id()));
        let uv = base.join("uv");
        let pnpm = base.join("pnpm");
        let npm = base.join("npm");
        let none = base.join("none");
        for d in [&uv, &pnpm, &npm, &none] {
            std::fs::create_dir_all(d).unwrap();
        }
        // Python/uv project → `python -m uv sync` (module form — no PATH dependency, #887).
        std::fs::write(uv.join("pyproject.toml"), "[project]\nname='x'\n").unwrap();
        assert_eq!(mcp_build_command(&uv).as_deref(), Some("python -m uv sync"));
        // pnpm project → pnpm install && build (a package.json is also present, but the
        // pnpm lockfile wins over the npm fallback).
        std::fs::write(pnpm.join("package.json"), "{}").unwrap();
        std::fs::write(pnpm.join("pnpm-lock.yaml"), "lockfileVersion: 9\n").unwrap();
        assert_eq!(mcp_build_command(&pnpm).as_deref(), Some("pnpm install && pnpm build"));
        // Plain Node project → npm fallback.
        std::fs::write(npm.join("package.json"), "{}").unwrap();
        assert_eq!(mcp_build_command(&npm).as_deref(), Some("npm install && npm run build"));
        // Unknown toolchain → None.
        assert_eq!(mcp_build_command(&none), None);
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn mcp_status_of_reports_downloaded_and_built() {
        let base = std::env::temp_dir().join(format!("bsc-mcpstatus-{}", std::process::id()));
        let dir = base.join("srv");
        std::fs::create_dir_all(&dir).unwrap();
        // Nothing yet → neither downloaded nor built.
        assert_eq!(mcp_status_of(&dir), (false, false));
        // A clone (.git) → downloaded, not built.
        std::fs::create_dir_all(dir.join(".git")).unwrap();
        assert_eq!(mcp_status_of(&dir), (true, false));
        // A build artifact (node_modules) → built. (dist / .venv count too.)
        std::fs::create_dir_all(dir.join("node_modules")).unwrap();
        assert_eq!(mcp_status_of(&dir), (true, true));
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn mcp_update_available_compares_heads() {
        // Differing non-empty shas → update available; equal → none; empty (unknown) → none.
        assert!(mcp_update_available("aaaa", "bbbb"));
        assert!(!mcp_update_available("aaaa", "aaaa"));
        assert!(!mcp_update_available("aaaa", ""));
        assert!(!mcp_update_available("", "bbbb"));
        // Trims surrounding whitespace before comparing.
        assert!(!mcp_update_available(" aaaa\n", "aaaa"));
    }

    #[test]
    fn worktrees_dir_is_outside_the_project_hub() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = temp_home("wtdir");
        let key = "my-proj";
        let wts = worktrees_dir(key);
        let hub = project_dir(key);
        // The whole point of #844: a worker's worktree is NOT under the hub, so the hub's
        // planner CLAUDE.md is not an ancestor of the worker's cwd.
        assert!(wts.starts_with(bsc_base_dir().join("worktrees")), "got {wts:?}");
        assert!(!wts.starts_with(&hub), "worktrees must not be under the hub: {wts:?} ⊄ {hub:?}");
        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn write_worker_context_leads_with_scope_then_repo_ctx_protocol_skills() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = temp_home("workerctx");
        let wt = home.join("wt");
        let clone = home.join("clone");
        let hub = home.join("hub");
        std::fs::create_dir_all(&wt).unwrap();
        std::fs::create_dir_all(&clone).unwrap();
        std::fs::create_dir_all(&hub).unwrap();
        // Per-repo app-managed context (untracked in the clone) + attached skills at the hub.
        std::fs::write(clone.join("CLAUDE.local.md"), "# repo notes\nUse the shared client.\n").unwrap();
        std::fs::write(hub.join("skills.md"), "# Attached skills & knowledge\n\n### Auth\nUse OAuth.\n").unwrap();

        let scope = "# Your scope\n\nYou own `src/auth/**`. Issues: #12, #13.";
        write_worker_context(&wt, &clone, &hub, Some(scope));
        let out = std::fs::read_to_string(wt.join("CLAUDE.local.md")).unwrap();

        // Scope leads, then per-repo context, then protocol, then skills — in that order.
        let i_scope = out.find("You own `src/auth/**`").expect("scope present");
        let i_repo = out.find("Use the shared client").expect("repo ctx present");
        let i_proto = out.find("## Fleet coordination protocol").expect("protocol present");
        let i_skills = out.find("Use OAuth.").expect("skills inlined");
        assert!(i_scope < i_repo, "scope must lead the per-repo context");
        assert!(i_repo < i_proto, "per-repo context must precede the protocol");
        assert!(i_proto < i_skills, "protocol must precede the skills");
        // The full planner spec is NOT here — only the worker's scope.
        assert!(!out.contains("Project Planner"), "must not carry the planner spec");

        // Idempotent: a second launch converges to identical content (protocol/skills not doubled).
        write_worker_context(&wt, &clone, &hub, Some(scope));
        assert_eq!(out, std::fs::read_to_string(wt.join("CLAUDE.local.md")).unwrap());
        assert_eq!(out.matches("## Fleet coordination protocol").count(), 1);

        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn delete_project_dir_removes_relocated_worktrees() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = temp_home("dpdwt");
        let key = "doomed-with-wt".to_string();
        // A hub file and a relocated worktree with a (Windows-hostile) read-only file.
        write_file(&project_dir(&key).join("goal.md"), "# goal");
        let wt_file = worktrees_dir(&key).join("web--auth").join("src").join("x.rs");
        write_file(&wt_file, "fn main() {}");
        let mut perms = std::fs::metadata(&wt_file).unwrap().permissions();
        perms.set_readonly(true);
        std::fs::set_permissions(&wt_file, perms).unwrap();

        crate::project::hub::delete_project_dir_impl(&key, &crate::pty::PtyState::new()).unwrap();
        assert!(!project_dir(&key).exists(), "hub should be deleted");
        assert!(!worktrees_dir(&key).exists(), "relocated worktrees should be deleted too");

        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn dead_code_cmd_allowlists_known_scanners_only() {
        assert!(dead_code_cmd("depcheck").is_some());
        assert!(dead_code_cmd("ts-prune").is_some());
        assert!(dead_code_cmd("cargo-machete").is_some());
        // arbitrary commands are never runnable
        assert!(dead_code_cmd("rm").is_none());
        assert!(dead_code_cmd("cargo machete; rm -rf /").is_none());
        assert!(dead_code_cmd("").is_none());
    }

    #[test]
    fn scan_dead_code_handles_bad_dir_and_unknown_tool() {
        let bad = scan_dead_code("/no/such/dir/xyzzy".to_string(), "depcheck".to_string());
        assert!(!bad.ran && bad.error.is_some());
        let unknown = scan_dead_code(".".to_string(), "totally-unknown".to_string());
        assert!(!unknown.ran && unknown.error.as_deref().unwrap_or("").contains("unknown scanner"));
    }

    #[test]
    fn write_project_file_bytes_decodes_base64_and_blocks_escape() {
        use base64::Engine;
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = temp_home("ppfb");
        let key = "test-intake".to_string();

        // Stage a "binary" file (raw bytes, incl. a NUL) from base64.
        let bytes: &[u8] = &[0x89, b'P', b'N', b'G', 0x00, 0xFF, 0x10];
        let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
        write_project_file_bytes(key.clone(), ".intake/logo.png".to_string(), b64).unwrap();
        let path = project_dir(&key).join(".intake").join("logo.png");
        assert!(path.exists());
        assert_eq!(std::fs::read(&path).unwrap(), bytes, "bytes round-trip exactly");

        // Bad base64 + path escapes are rejected.
        assert!(write_project_file_bytes(key.clone(), ".intake/x.png".to_string(), "not base64!!".to_string()).is_err());
        assert!(write_project_file_bytes(key.clone(), "../escape.png".to_string(), "AAAA".to_string()).is_err());
        assert!(write_project_file_bytes(key.clone(), "/abs.png".to_string(), "AAAA".to_string()).is_err());

        std::fs::remove_dir_all(&home).ok();
    }
