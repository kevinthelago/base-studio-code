//! `bsc app release` — cut a release in one go (see CLAUDE.md § "Cutting a release").
//!
//! Ported from `scripts/release.mjs`.
//!
//! Bumps the app version in BOTH `package.json` and `src-tauri/tauri.conf.json`, stamps the
//! CHANGELOG `[Unreleased]` section as the new version, commits, tags `vX.Y.Z`, and pushes
//! `--follow-tags` so the tag-triggered `release.yml` builds the installers and cuts the GitHub
//! Release. Only those two files carry the app version; `src-tauri/Cargo.toml` keeps its crate
//! version.
//!
//! **IT REFUSES a dirty TRACKED tree.** Only tracked changes block a release — the release commits
//! the version bump and the changelog stamp, and untracked files (nested worktrees at the repo root,
//! local scratch assets) are not part of it. `--untracked-files=no`, so those do not wedge the cut
//! when the tracked tree is clean.
//!
//! **IT PUSHES**, which is the one verb in this crate that reaches a remote, and it is the user's
//! deliberate act rather than something a session does on its own. `--no-push` does everything else.

/// The version bump a caller asked for.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Bump {
    Major,
    Minor,
    Patch,
    Exact(String),
}

/// Parse the CLI's version argument. `None` means no argument, which is a patch bump — the `1.0.4n`
/// cadence.
pub fn parse_spec(spec: Option<&str>) -> Result<Bump, String> {
    match spec {
        None | Some("patch") => Ok(Bump::Patch),
        Some("minor") => Ok(Bump::Minor),
        Some("major") => Ok(Bump::Major),
        Some(v) if is_semver(v) => Ok(Bump::Exact(v.to_string())),
        Some(bad) => Err(format!("bad version/bump arg: '{bad}' (use x.y.z | major | minor | patch)")),
    }
}

/// `x.y.z` with an optional `-pre` / `+build` tail — the JavaScript's `/^\d+\.\d+\.\d+([-+].+)?$/`.
fn is_semver(v: &str) -> bool {
    let (core, tail) = match v.find(['-', '+']) {
        Some(i) => (&v[..i], &v[i + 1..]),
        None => (v, ""),
    };
    // A tail must be non-empty when its separator is present — `1.0.0-` is not a version.
    if v.len() > core.len() && tail.is_empty() {
        return false;
    }
    let parts: Vec<&str> = core.split('.').collect();
    parts.len() == 3
        && parts.iter().all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
}

/// The next version, given the current one.
pub fn next_version(current: &str, bump: &Bump) -> Result<String, String> {
    if let Bump::Exact(v) = bump {
        return finish(current, v.clone());
    }
    let parts: Vec<u64> = current
        .split('.')
        .map(|p| p.parse::<u64>().map_err(|_| format!("current version '{current}' is not x.y.z")))
        .collect::<Result<_, _>>()?;
    if parts.len() != 3 {
        return Err(format!("current version '{current}' is not x.y.z"));
    }
    let idx = match bump {
        Bump::Major => 0,
        Bump::Minor => 1,
        Bump::Patch => 2,
        Bump::Exact(_) => unreachable!("handled above"),
    };
    let mut p = parts;
    p[idx] += 1;
    // Everything to the RIGHT of the bumped position resets.
    for slot in p.iter_mut().skip(idx + 1) {
        *slot = 0;
    }
    finish(current, format!("{}.{}.{}", p[0], p[1], p[2]))
}

fn finish(current: &str, next: String) -> Result<String, String> {
    if next == current {
        return Err(format!("next version equals current ({current})."));
    }
    Ok(next)
}

/// Replace the FIRST `"version": "..."` in a JSON source, preserving formatting.
///
/// A regex-style replace rather than parse-and-reserialize, deliberately: `package.json` and
/// `tauri.conf.json` are hand-maintained files, and round-tripping them through a JSON writer would
/// reformat every line and bury the one-line version bump in noise.
pub fn set_version(src: &str, next: &str) -> Option<String> {
    let key = src.find("\"version\"")?;
    let colon = src[key..].find(':')? + key;
    let open = src[colon..].find('"')? + colon;
    let close = src[open + 1..].find('"')? + open + 1;
    Some(format!("{}{}{}", &src[..open + 1], next, &src[close..]))
}

/// Stamp the CHANGELOG: keep an empty `[Unreleased]`, add the dated version beneath it.
pub fn stamp_changelog(src: &str, next: &str, date: &str) -> Result<String, String> {
    const MARKER: &str = "## [Unreleased]";
    let at = src
        .lines()
        .position(|l| l.starts_with(MARKER))
        .ok_or("CHANGELOG.md has no '## [Unreleased]' section to stamp.")?;
    let mut lines: Vec<String> = src.lines().map(str::to_string).collect();
    lines.splice(at + 1..at + 1, [String::new(), format!("## [{next}] — {date}")]);
    let mut out = lines.join("\n");
    if src.ends_with('\n') {
        out.push('\n');
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_bare_call_is_a_patch_bump_the_1_0_4n_cadence() {
        assert_eq!(parse_spec(None).unwrap(), Bump::Patch);
        assert_eq!(next_version("1.0.41", &Bump::Patch).unwrap(), "1.0.42");
    }

    #[test]
    fn a_minor_or_major_bump_resets_everything_to_its_right() {
        assert_eq!(next_version("1.0.41", &Bump::Minor).unwrap(), "1.1.0");
        assert_eq!(next_version("1.2.3", &Bump::Major).unwrap(), "2.0.0");
    }

    #[test]
    fn an_explicit_version_is_taken_as_given() {
        // The themed-step case: `1.0.5` sorts BEFORE `1.0.41` by semver, and that is deliberate in
        // this repo (see the versioning policy). Nothing here may "fix" it.
        assert_eq!(parse_spec(Some("1.0.5")).unwrap(), Bump::Exact("1.0.5".into()));
        assert_eq!(next_version("1.0.41", &Bump::Exact("1.0.5".into())).unwrap(), "1.0.5");
        assert_eq!(parse_spec(Some("2.0.0-rc.1")).unwrap(), Bump::Exact("2.0.0-rc.1".into()));
    }

    #[test]
    fn refuses_a_bad_spec_rather_than_guessing_a_bump() {
        for bad in ["1.0", "v1.0.0", "banana", "1.0.0.0", "1.0.x", "1.0.0-"] {
            assert!(parse_spec(Some(bad)).is_err(), "{bad} should be refused");
        }
    }

    #[test]
    fn refuses_when_the_next_version_equals_the_current_one() {
        assert!(next_version("1.0.5", &Bump::Exact("1.0.5".into())).is_err());
    }

    #[test]
    fn set_version_replaces_only_the_first_version_and_keeps_formatting() {
        let src = "{\n  \"name\": \"x\",\n  \"version\": \"1.0.41\",\n  \"deps\": { \"version\": \"9.9.9\" }\n}\n";
        let out = set_version(src, "1.0.42").expect("has a version field");
        assert!(out.contains("\"version\": \"1.0.42\""));
        assert!(out.contains("\"version\": \"9.9.9\""), "a nested version must be left alone");
        assert_eq!(out.lines().count(), src.lines().count(), "formatting is preserved");
    }

    #[test]
    fn set_version_reports_absence_rather_than_writing_a_broken_file() {
        assert_eq!(set_version("{\n  \"name\": \"x\"\n}\n", "1.0.42"), None);
    }

    #[test]
    fn stamp_changelog_keeps_an_empty_unreleased_above_the_dated_version() {
        let src = "# Changelog\n\n## [Unreleased]\n\n- something new\n\n## [1.0.41] — 2026-08-01\n";
        let out = stamp_changelog(src, "1.0.42", "2026-09-02").unwrap();
        let lines: Vec<&str> = out.lines().collect();
        let at = lines.iter().position(|l| *l == "## [Unreleased]").unwrap();
        assert_eq!(lines[at + 1], "", "the Unreleased section stays, and stays empty");
        assert_eq!(lines[at + 2], "## [1.0.42] — 2026-09-02");
        assert!(out.contains("- something new"), "the existing entries move UNDER the new version");
        assert!(out.ends_with('\n'), "the trailing newline survives");
    }

    #[test]
    fn stamp_changelog_refuses_a_file_with_no_unreleased_section() {
        assert!(stamp_changelog("# Changelog\n\n## [1.0.41]\n", "1.0.42", "2026-09-02").is_err());
    }
}
