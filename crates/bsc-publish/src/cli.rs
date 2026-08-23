//! `bsc publish` — push a plan's GitHub structure with no frontend involved.

use crate::{
    create_issues_for_repo, ensure_project_board, publish_repositories, repo_for, token, viewer_login,
    LiveGh, Report, Status,
};
use bsc_cli_util::CmdDoc;

const TAGLINE: &str = "publish a plan's GitHub structure — repos, the project board, and one issue per plan row";

const COMMANDS: &[CmdDoc] = &[CmdDoc {
    name: "run",
    summary: "publish the plan in $BSC_PLAN_DB to GitHub (idempotent; safe to re-run)",
    usage: "\
USAGE:
  bsc publish run [--db <plan.db>] [--token <tok>] [--project <node-id>]
                  [--title <text>] [--description <text>] [--private] [--dry-run] [--json]

Reads the plan store and creates what is missing on GitHub: each linked REPO, the PROJECT BOARD (and
links the repos to it), and one ISSUE per plan row — added to the board, labelled with its own
labels plus `stream:<id>` and the `bsc-generated` provenance stamp, and assigned to the publishing
account. Each created issue's number is written back to the plan row.

IT IS IDEMPOTENT. Re-running publishes only what is genuinely absent: a row that already knows its
GitHub number is left alone even if its title has since changed, and a row published before numbers
were recorded is matched by title ONCE and backfilled. Running it twice on an unchanged plan creates
nothing.

IT FAILS CLOSED. If a repo's existing issues cannot be listed, that repo is SKIPPED rather than
created into — a transient read failure must never duplicate a backlog.

NO MILESTONES are created (#1912/#1942); phases are not GitHub milestones.

THE TOKEN is resolved in this order, most explicit first: `--token`, then $GITHUB_TOKEN / $GH_TOKEN,
then `gh auth token`, then the GitHub connection saved in the app. The chosen SOURCE is reported;
the token itself never is.

--dry-run reports exactly what would be created, touching nothing.

NOT YET INCLUDED: repo scaffolding (README, topics, community files, dependency manifests). This
lands the plan STRUCTURE, not the repo presentation.",
}];

struct Args {
    json: bool,
    dry_run: bool,
    private: bool,
    db: Option<String>,
    token: Option<String>,
    project: Option<String>,
    title: Option<String>,
    description: Option<String>,
    positional: Vec<String>,
}

fn parse_args(raw: Vec<String>) -> Result<Args, String> {
    let mut a = Args {
        json: false,
        dry_run: false,
        private: false,
        db: None,
        token: None,
        project: None,
        title: None,
        description: None,
        positional: Vec::new(),
    };
    let mut it = raw.into_iter();
    while let Some(arg) = it.next() {
        let mut take = |flag: &str| it.next().ok_or_else(|| format!("{flag} needs a value"));
        match arg.as_str() {
            "--json" => a.json = true,
            "--dry-run" => a.dry_run = true,
            "--private" => a.private = true,
            "-h" | "--help" => a.positional.insert(0, "help".into()),
            "--db" => a.db = Some(take("--db")?),
            "--token" => a.token = Some(take("--token")?),
            "--project" => a.project = Some(take("--project")?),
            "--title" => a.title = Some(take("--title")?),
            "--description" => a.description = Some(take("--description")?),
            other if other.starts_with("--") => return Err(format!("unknown flag '{other}'")),
            other => a.positional.push(other.to_string()),
        }
    }
    Ok(a)
}

pub fn run(args: Vec<String>, prog: &str) -> Result<(), String> {
    let args = parse_args(args)?;
    let cmd = args.positional.first().cloned().unwrap_or_else(|| "run".to_string());

    if bsc_cli_util::handle_help(prog, TAGLINE, COMMANDS, &args.positional) {
        return Ok(());
    }
    match cmd.as_str() {
        "run" => cmd_run(&args),
        other => Err(bsc_cli_util::unknown_command(prog, TAGLINE, COMMANDS, other)),
    }
}

fn cmd_run(args: &Args) -> Result<(), String> {
    let db = bsc_cli_util::resolve_store_path(&args.db, "BSC_PLAN_DB", || {
        Err("no plan store — pass --db or set $BSC_PLAN_DB".to_string())
    })?;
    let store = plandb::Store::open(&db).map_err(|e| format!("could not open {}: {e}", db.display()))?;

    let repos = store.repo_list().map_err(|e| format!("could not read repos: {e}"))?;
    if repos.is_empty() {
        return Err("nothing to publish — the plan has no linked repositories (`bsc plan repo add <owner/name>`)".into());
    }
    let issues = store.list(None, None).map_err(|e| format!("could not read issues: {e}"))?;

    let title = args.title.clone().unwrap_or_else(|| {
        db.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "Project".into())
    });
    let description = args.description.clone().unwrap_or_default();

    // --dry-run answers "what would this do" WITHOUT a token, so it works on a machine that has
    // never connected — which is where someone most wants to check before wiring credentials.
    if args.dry_run {
        let mut report = Report::default();
        for r in &repos {
            report.push(crate::Outcome { id: format!("repo:{r}"), status: Status::Skipped, detail: Some("would ensure".into()) });
        }
        report.push(crate::Outcome { id: "project".into(), status: Status::Skipped, detail: Some(format!("would ensure board '{title}'")) });
        for iss in &issues {
            let repo = repo_for(iss, &repos).cloned().unwrap_or_default();
            let detail = match iss.gh_number {
                Some(n) => format!("already #{n}"),
                None => "would create".to_string(),
            };
            report.push(crate::Outcome { id: format!("issue:{repo}:{}", iss.r#ref), status: Status::Skipped, detail: Some(detail) });
        }
        return emit(&report, args.json, None);
    }

    let (tok, source) = token::resolve(args.token.as_deref())?;
    let api = LiveGh { token: tok };
    let mut report = Report::default();

    let viewer = viewer_login(&api);
    let node_ids = publish_repositories(&api, &repos, &description, args.private, &viewer, &mut report);
    let project_id = ensure_project_board(
        &api,
        args.project.as_deref(),
        &repos,
        &viewer,
        &title,
        &node_ids,
        &mut report,
    );

    for repo in &repos {
        let mine: Vec<&plandb::PlanIssue> = issues
            .iter()
            .filter(|i| repo_for(i, &repos).map(|r| r == repo).unwrap_or(false))
            .collect();
        if mine.is_empty() {
            continue;
        }
        let identities =
            create_issues_for_repo(&api, repo, &mine, project_id.as_deref(), &viewer, &mut report);
        // Persist each identity. A write failure is reported but does not abort the run — the issue
        // exists on GitHub either way, and losing the whole publish over a store write would be worse.
        for id in identities {
            if let Err(e) = store.set_github_identity(&id.r#ref, id.gh_number, id.gh_node_id.as_deref()) {
                report.push(crate::Outcome {
                    id: format!("link:{}", id.r#ref),
                    status: Status::Error,
                    detail: Some(format!("published as #{} but the plan row could not be updated: {e}", id.gh_number)),
                });
            }
        }
    }
    emit(&report, args.json, Some(source.describe()))
}

fn emit(report: &Report, json: bool, source: Option<String>) -> Result<(), String> {
    if json {
        println!("{}", serde_json::to_string_pretty(report).map_err(|e| e.to_string())?);
    } else {
        if let Some(s) = source {
            println!("token: {s}");
        }
        for o in &report.outcomes {
            let status = match o.status {
                Status::Created => "created",
                Status::Exists => "exists",
                Status::Skipped => "skipped",
                Status::Error => "ERROR",
            };
            match &o.detail {
                Some(d) => println!("  {status:<8} {}  ({d})", o.id),
                None => println!("  {status:<8} {}", o.id),
            }
        }
    }
    if report.any_error() {
        return Err("publish finished with errors — see the report above".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_args_reads_the_value_flags_and_rejects_an_unknown_one() {
        let a = parse_args(vec![
            "run".into(), "--token".into(), "t".into(), "--title".into(), "My Plan".into(),
            "--private".into(), "--json".into(),
        ])
        .unwrap();
        assert_eq!(a.positional, vec!["run"]);
        assert_eq!(a.token.as_deref(), Some("t"));
        assert_eq!(a.title.as_deref(), Some("My Plan"));
        assert!(a.private && a.json);
        assert!(parse_args(vec!["--nope".into()]).is_err());
        // A value flag with no value is an error, not a silent empty.
        assert!(parse_args(vec!["--token".into()]).is_err());
    }

    #[test]
    fn the_default_command_is_run_so_bare_bsc_publish_publishes() {
        let a = parse_args(vec![]).unwrap();
        assert!(a.positional.is_empty());
        assert_eq!(a.positional.first().cloned().unwrap_or_else(|| "run".into()), "run");
    }

    #[test]
    fn a_report_with_any_error_is_a_nonzero_exit() {
        // A partial failure must NOT be reported as a clean publish — the exit code is what an
        // unattended director branches on.
        let mut r = Report::default();
        r.push(crate::Outcome { id: "repo:o/r".into(), status: Status::Created, detail: None });
        assert!(emit(&r, false, None).is_ok());
        r.push(crate::Outcome { id: "issue:x".into(), status: Status::Error, detail: Some("boom".into()) });
        assert!(emit(&r, false, None).is_err());
    }
}
