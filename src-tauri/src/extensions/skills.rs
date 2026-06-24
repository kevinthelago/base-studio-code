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
