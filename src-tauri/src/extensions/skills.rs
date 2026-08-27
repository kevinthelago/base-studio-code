use crate::prelude::*;

/// Write each resolved Skill as a Claude Code Skill file at
/// `<cwd_root>/.claude/skills/<slug>/SKILL.md` (slug derived from the name). The
/// file is YAML frontmatter (`name`, `description`, optional `allowed-tools`) then
/// the prompt body. Skills with an empty slug are skipped; an empty set is a no-op.
///
/// Additive only: this writer creates/updates skill files but never deletes them,
/// so toggling a skill off does not remove its file yet (follow-up).
pub(crate) fn write_session_skills(cwd_root: &std::path::Path, skills: &[SkillCfg]) -> Result<(), String> {
    if cwd_root.as_os_str().is_empty() || skills.is_empty() { return Ok(()); }
    let skills_root = cwd_root.join(".claude").join("skills");
    for s in skills {
        let slug = skill_slug(&s.name);
        if slug.is_empty() { continue; }
        let dir = skills_root.join(&slug);
        std::fs::create_dir_all(&dir).str_err()?;
        let mut doc = String::from("---\n");
        doc.push_str(&format!("name: {}\n", yaml_quote(&s.name)));
        doc.push_str(&format!("description: {}\n", yaml_quote(&s.description)));
        if !s.tools.is_empty() {
            doc.push_str(&format!("allowed-tools: {}\n", yaml_quote(&s.tools.join(", "))));
        }
        doc.push_str("---\n\n");
        doc.push_str(&s.prompt);
        std::fs::write(dir.join("SKILL.md"), doc).str_err()?;
    }
    Ok(())
}

/// Count an ATTACH of each skill (#A): a session getting these skills written is a "use" of them, so
/// bump the global usage counter via skilldb. `ensure_session_settings` is the single backend
/// chokepoint both manual launches and fleet workers funnel through, so usage is counted UNIFORMLY +
/// model-agnostically — not scraped from the Claude-only skill log (which under-counts every
/// non-Claude caller). Skills with no id (older payloads) are skipped. Best-effort: a missing/locked
/// `skills.db` never blocks a launch. Deliberately SEPARATE from `write_session_skills` (a pure
/// writer) so unit tests that call that writer don't mutate the real global store.
pub(crate) fn record_skill_uses(skills: &[SkillCfg]) {
    let ids: Vec<&str> = skills.iter().map(|s| s.id.trim()).filter(|id| !id.is_empty()).collect();
    if ids.is_empty() {
        return;
    }
    let path = crate::skills_db();
    if !path.exists() {
        return; // no global store yet — nothing to count against
    }
    match skilldb::Store::open(&path) {
        Ok(store) => {
            for id in ids {
                let _ = store.record_use(id); // best-effort: a missing row just affects 0 rows
            }
        }
        Err(e) => log::warn!("record_skill_uses: open {}: {e}", path.display()),
    }
}

/// Render a string as a YAML double-quoted scalar so frontmatter values with
/// colons, `#`, leading specials, or newlines can't break the `SKILL.md` header.
pub(crate) fn yaml_quote(s: &str) -> String {
    let escaped = s.replace('\\', "\\\\").replace('"', "\\\"").replace('\n', "\\n");
    format!("\"{}\"", escaped)
}
/// Slug a skill name: lowercase, keep `[a-z0-9-]`, collapse any run of other
/// chars to a single `-`, and trim leading/trailing `-`. May return empty.
pub(crate) fn skill_slug(name: &str) -> String {
    let mut out = String::new();
    let mut pending_dash = false;
    for c in name.to_lowercase().chars() {
        if c.is_ascii_alphanumeric() || c == '-' {
            if pending_dash && !out.is_empty() { out.push('-'); }
            pending_dash = false;
            out.push(c);
        } else {
            pending_dash = true;
        }
    }
    out.trim_matches('-').to_string()
}

#[cfg(test)]
mod relocated_tests {
    #![allow(unused_imports)]
    use super::*;
    use crate::testutil::prelude::*;

    /// The `$BSC_AGENT_SKILLS` payload and the `SkillCfg` the Claude path writes are THE SAME SHAPE,
    /// which is the property that lets one resolver feed both harnesses.
    ///
    /// This is a contract test, not a formality: the frontend serializes one array
    /// (`sessionSkillCfgs`) and it is consumed in two places — written to `.claude/skills` here, and
    /// parsed for the attach count in `pty_create`. If the payload ever stopped deserializing into
    /// `SkillCfg`, the local half would silently stop being counted, which is the exact failure this
    /// item was filed about: a channel that goes quiet and looks like an empty set.
    #[test]
    fn the_bsc_agent_skills_payload_deserializes_as_the_same_skillcfg_claude_gets() {
        // The literal JSON `sessionSkillCfgs` produces (toSkillCfgs → id/name/description/prompt/tools).
        let payload = r#"[
            {"id":"open-pr","name":"Open a clean PR","description":"Open a tidy pull request",
             "prompt":"Do the PR steps.","tools":["create_pr","git_diff"]}
        ]"#;
        let parsed: Vec<SkillCfg> =
            serde_json::from_str(payload).expect("the env payload must parse as SkillCfg");
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].id, "open-pr");
        assert_eq!(parsed[0].name, "Open a clean PR");
        assert_eq!(parsed[0].prompt, "Do the PR steps.");
        assert_eq!(parsed[0].tools, vec!["create_pr", "git_diff"]);

        // And it round-trips through the writer, so a skill delivered by env is byte-identical to one
        // delivered the Claude way — the two harnesses cannot be handed different content.
        let dir = std::env::temp_dir().join(format!("bsc-skills-env-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        write_session_skills(&dir, &parsed).unwrap();
        let written = std::fs::read_to_string(
            dir.join(".claude").join("skills").join("open-a-clean-pr").join("SKILL.md"),
        ).unwrap();
        assert!(written.contains("Do the PR steps."));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_session_skills_writes_skill_files() {
        let dir = std::env::temp_dir().join(format!("bsc-skills-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let skills = vec![
            SkillCfg {
                id: "open-pr".into(),
                name: "Open a clean PR".into(),
                description: "Open a tidy pull request".into(),
                prompt: "Do the PR steps.".into(),
                tools: vec!["create_pr".into(), "git_diff".into()],
            },
            SkillCfg {
                id: "review-docs".into(),
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
}
