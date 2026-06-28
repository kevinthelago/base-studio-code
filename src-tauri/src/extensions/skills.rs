use crate::*;

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
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let mut doc = String::from("---\n");
        doc.push_str(&format!("name: {}\n", yaml_quote(&s.name)));
        doc.push_str(&format!("description: {}\n", yaml_quote(&s.description)));
        if !s.tools.is_empty() {
            doc.push_str(&format!("allowed-tools: {}\n", yaml_quote(&s.tools.join(", "))));
        }
        doc.push_str("---\n\n");
        doc.push_str(&s.prompt);
        std::fs::write(dir.join("SKILL.md"), doc).map_err(|e| e.to_string())?;
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
    let path = crate::bsc_base_dir().join("skills.db");
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
