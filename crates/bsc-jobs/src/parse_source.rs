use crate::{Source, SourceKind};

/// `manual`, or `resume:<path>` · `note:<image>` · `memory:<id>`. Anything but `manual` must say WHAT it
/// was read out of — a source with no reference is a claim with nothing behind it.
pub fn parse_source(raw: &str) -> Result<Source, String> {
    let s = raw.trim();
    if s == "manual" {
        return Ok(Source { kind: SourceKind::Manual, reference: None });
    }
    let (kind, reference) = s.split_once(':').unwrap_or((s, ""));
    let kind = match kind {
        "resume" => SourceKind::Resume,
        "note" => SourceKind::Note,
        "memory" => SourceKind::Memory,
        _ => return Err(format!("`{raw}` is not a source — manual, resume:<path>, note:<image> or memory:<id>")),
    };
    let reference = reference.trim();
    if reference.is_empty() {
        return Err(format!("source `{raw}` names no reference — say what it was read out of, e.g. {s}:<…>"));
    }
    Ok(Source { kind, reference: Some(reference.to_string()) })
}
