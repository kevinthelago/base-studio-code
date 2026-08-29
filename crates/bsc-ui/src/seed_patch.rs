//! Surgical single-field JSON patch for on-disk SEED files (#109, `bsc ui tests adopt`).
//!
//! A per-component seed under `src-tauri/data/components/app/**` is one record, one file, checked
//! into git — and it is what SHIPS (`emit-records` reads it, not the runtime store `bsc ui set`
//! writes). A full parse-modify-reserialize round trip through `serde_json::Value` reorders every
//! key alphabetically (this workspace does not enable serde_json's `preserve_order` feature), so a
//! one-field change would rewrite the whole file and read as an all-keys diff. This instead walks the
//! raw text byte-for-byte and replaces (or appends) exactly one top-level field's value, leaving
//! every other byte untouched — the same discipline request #109's filer used by hand (encode the old
//! value, assert it occurs exactly once, replace that one substring, re-parse to prove nothing else
//! moved), generalized into a real parser instead of a string search so a decoy substring inside an
//! unrelated field (e.g. `srcText` containing the literal text `"tests":`) cannot be mistaken for the
//! key.

use serde_json::Value;

struct Field {
    key: String,
    /// The literal text from the start of the key's line up to the key's opening quote — reused
    /// verbatim as the indent for an inserted field, and as the base indent a replacement value's
    /// continuation lines are rebased onto.
    indent: String,
    value_start: usize,
    value_end: usize,
}

/// Set (or insert) a top-level field `key` to `value` in the JSON object `raw` (a per-record seed
/// file — one `{ ... }` at the document root). Returns the patched text and whether the field's
/// value actually differs from before (structural equality on the parsed JSON, not textual — so a
/// pre-existing formatting quirk in the old value doesn't read as a change when the content is the
/// same).
///
/// Every byte outside the target field's own span is preserved: no key reordering, no re-indentation
/// of sibling fields. The new value is pretty-printed at 2-space indent (`serde_json::to_string_pretty`,
/// matching every seed file's own convention) and rebased onto the field's existing indentation. A
/// round-trip check (see [`verify_patch`]) refuses to write a result where any OTHER field parses
/// differently than before, so a bug in the span-finding logic fails loudly instead of silently
/// corrupting a neighbouring field.
pub fn set_field(raw: &str, key: &str, value: &Value) -> Result<(String, bool), String> {
    let fields = parse_top_level_fields(raw)?;
    let indent = fields.first().map(|f| f.indent.clone()).unwrap_or_else(|| "  ".to_string());
    let pretty = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    let rebased = rebase_indent(&pretty, &indent);

    let patched = match fields.iter().find(|f| f.key == key) {
        Some(f) => format!("{}{}{}", &raw[..f.value_start], rebased, &raw[f.value_end..]),
        None => {
            let last = fields
                .last()
                .ok_or_else(|| "cannot append a field to a seed record with no fields".to_string())?;
            let insertion = format!(",\n{indent}\"{key}\": {rebased}");
            format!("{}{}{}", &raw[..last.value_end], insertion, &raw[last.value_end..])
        }
    };

    let changed = verify_patch(raw, &patched, key)?;
    Ok((patched, changed))
}

/// Rebase a standalone `serde_json::to_string_pretty` rendering onto `indent`: the first line sits
/// right after `"key": ` on the same line as-is, and every following line gets `indent` prefixed —
/// which is exactly the offset a pretty-printer would have applied had it rendered the value in
/// place one nesting level deeper. (`to_string_pretty` indents 2 spaces per level, same as every
/// seed file, so re-basing by the field's own indent reproduces the file's existing style exactly.)
fn rebase_indent(pretty: &str, indent: &str) -> String {
    let mut lines = pretty.lines();
    let mut out = lines.next().unwrap_or("").to_string();
    for line in lines {
        out.push('\n');
        out.push_str(indent);
        out.push_str(line);
    }
    out
}

/// Re-parse both documents and refuse the patch unless every field OTHER than `changed_key` is
/// byte-for-byte the same span and every field's parsed value is unchanged — the guard that turns a
/// span-finding bug into a loud error instead of a corrupted neighbour. Returns whether `changed_key`
/// itself actually changed value.
fn verify_patch(before: &str, after: &str, changed_key: &str) -> Result<bool, String> {
    let old: Value = serde_json::from_str(before).map_err(|e| format!("seed record is not valid JSON: {e}"))?;
    let new: Value = serde_json::from_str(after).map_err(|e| format!("patch produced invalid JSON: {e}"))?;
    let (Value::Object(old_map), Value::Object(new_map)) = (&old, &new) else {
        return Err("seed record is not a JSON object".to_string());
    };
    for (k, v) in old_map {
        if k == changed_key {
            continue;
        }
        match new_map.get(k) {
            Some(nv) if nv == v => {}
            Some(_) => return Err(format!("refusing to write: patch altered unrelated field '{k}'")),
            None => return Err(format!("refusing to write: patch dropped unrelated field '{k}'")),
        }
    }
    for k in new_map.keys() {
        if k != changed_key && !old_map.contains_key(k) {
            return Err(format!("refusing to write: patch introduced unexpected field '{k}'"));
        }
    }
    Ok(old_map.get(changed_key) != new_map.get(changed_key))
}

/// Parse the document's top-level fields — key, source indent, and the byte span of its value — by
/// scanning depth-0 (relative to the outermost object) with a minimal hand-rolled JSON tokenizer.
/// This is NOT a general JSON parser: it only needs to walk PAST nested values (objects, arrays,
/// strings — including ones that themselves contain `{`/`}`/`"key":`-shaped text) without
/// interpreting them, which [`skip_value`] does by tracking string/escape state and bracket depth.
fn parse_top_level_fields(text: &str) -> Result<Vec<Field>, String> {
    let bytes = text.as_bytes();
    let mut i = skip_ws(bytes, 0);
    if bytes.get(i) != Some(&b'{') {
        return Err("seed file does not start with a JSON object".to_string());
    }
    i += 1;
    let mut fields = Vec::new();
    loop {
        i = skip_ws(bytes, i);
        match bytes.get(i) {
            Some(b'}') => break,
            Some(b'"') => {
                let key_start = i;
                let key_end = skip_string(bytes, i)?;
                let key: String = serde_json::from_str(&text[key_start..key_end])
                    .map_err(|e| format!("bad field name at byte {key_start}: {e}"))?;
                let line_start = text[..key_start].rfind('\n').map(|p| p + 1).unwrap_or(0);
                let indent = text[line_start..key_start].to_string();
                i = skip_ws(bytes, key_end);
                if bytes.get(i) != Some(&b':') {
                    return Err(format!("expected ':' after field '{key}'"));
                }
                i = skip_ws(bytes, i + 1);
                let value_start = i;
                let value_end = skip_value(bytes, value_start)?;
                fields.push(Field { key, indent, value_start, value_end });
                i = skip_ws(bytes, value_end);
                match bytes.get(i) {
                    Some(b',') => i += 1,
                    Some(b'}') => break,
                    other => return Err(format!("unexpected byte after field value: {other:?}")),
                }
            }
            other => return Err(format!("expected a field name, found {other:?}")),
        }
    }
    if fields.is_empty() {
        return Err("seed record has no fields".to_string());
    }
    Ok(fields)
}

fn skip_ws(bytes: &[u8], mut i: usize) -> usize {
    while let Some(&b) = bytes.get(i) {
        if b == b' ' || b == b'\t' || b == b'\n' || b == b'\r' {
            i += 1;
        } else {
            break;
        }
    }
    i
}

/// Advance past a JSON string starting at `bytes[start] == '"'`, returning the index just past the
/// closing quote. Escape-aware (`\"` doesn't end it, `\uXXXX` consumes its four hex digits) so a
/// string that contains brace/bracket-shaped text never confuses the caller's depth tracking.
fn skip_string(bytes: &[u8], start: usize) -> Result<usize, String> {
    let mut i = start + 1;
    loop {
        match bytes.get(i) {
            None => return Err("unterminated string in seed JSON".to_string()),
            Some(b'\\') => match bytes.get(i + 1) {
                Some(b'u') => i += 6,
                Some(_) => i += 2,
                None => return Err("unterminated escape in seed JSON".to_string()),
            },
            Some(b'"') => return Ok(i + 1),
            Some(_) => i += 1,
        }
    }
}

/// Advance past one balanced `open`/`close` structure (an object or an array) starting at
/// `bytes[start] == open`, skipping over any string content (which may itself contain `open`/`close`
/// bytes) rather than counting them.
fn skip_balanced(bytes: &[u8], start: usize, open: u8, close: u8) -> Result<usize, String> {
    let mut depth = 0i32;
    let mut i = start;
    loop {
        match bytes.get(i) {
            None => return Err("unterminated structure in seed JSON".to_string()),
            Some(b'"') => i = skip_string(bytes, i)?,
            Some(&c) if c == open => {
                depth += 1;
                i += 1;
            }
            Some(&c) if c == close => {
                depth -= 1;
                i += 1;
                if depth == 0 {
                    return Ok(i);
                }
            }
            Some(_) => i += 1,
        }
    }
}

/// Advance past one JSON value of any kind (string, object, array, or a bare literal — number /
/// `true` / `false` / `null`), returning the index just past it.
fn skip_value(bytes: &[u8], start: usize) -> Result<usize, String> {
    let i = skip_ws(bytes, start);
    match bytes.get(i) {
        Some(b'"') => skip_string(bytes, i),
        Some(b'{') => skip_balanced(bytes, i, b'{', b'}'),
        Some(b'[') => skip_balanced(bytes, i, b'[', b']'),
        Some(_) => {
            let mut j = i;
            while let Some(&b) = bytes.get(j) {
                if matches!(b, b',' | b'}' | b']' | b' ' | b'\t' | b'\n' | b'\r') {
                    break;
                }
                j += 1;
            }
            if j == i {
                return Err("expected a JSON value".to_string());
            }
            Ok(j)
        }
        None => Err("unexpected end of seed JSON".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "{\n  \"id\": \"ui-icon-button\",\n  \"name\": \"IconButton\",\n  \"srcText\": \"a decoy string with \\\"tests\\\": [not a real field] inside it\",\n  \"tests\": [\n    {\n      \"name\": \"old\",\n      \"src\": \"old body\"\n    }\n  ]\n}\n";

    #[test]
    fn replaces_an_existing_field_in_place_leaving_siblings_byte_identical() {
        let value = serde_json::json!([{ "name": "IconButton", "src": "new body" }]);
        let (patched, changed) = set_field(SAMPLE, "tests", &value).unwrap();
        assert!(changed);
        // Every line before "tests" is untouched, including the decoy that LOOKS like a tests key.
        let tests_line = SAMPLE.find("\"tests\"").unwrap();
        assert_eq!(&patched[..tests_line], &SAMPLE[..tests_line]);
        // Rebased one level deeper than the "tests" key itself (2-space indent, same as the rest of
        // the file): the array item's `{` sits at 4 spaces, its fields at 6, closing `}`/`]` back out.
        assert!(patched.contains("\"tests\": [\n    {\n      \"name\": \"IconButton\",\n      \"src\": \"new body\"\n    }\n  ]\n}\n"));
        let reparsed: Value = serde_json::from_str(&patched).unwrap();
        assert_eq!(reparsed["tests"], value);
        assert_eq!(reparsed["id"], "ui-icon-button");
    }

    #[test]
    fn reports_unchanged_when_the_new_value_is_structurally_identical() {
        let value = serde_json::json!([{ "name": "old", "src": "old body" }]);
        let (patched, changed) = set_field(SAMPLE, "tests", &value).unwrap();
        assert!(!changed);
        // Still rewrites the span (re-pretty-printed) even when unchanged — the caller decides
        // whether to skip the write based on `changed`.
        let reparsed: Value = serde_json::from_str(&patched).unwrap();
        assert_eq!(reparsed["tests"], value);
    }

    #[test]
    fn inserts_a_missing_field_after_the_last_one() {
        let no_tests = "{\n  \"id\": \"x\",\n  \"name\": \"X\"\n}\n";
        let value = serde_json::json!([{ "name": "X", "src": "body" }]);
        let (patched, changed) = set_field(no_tests, "tests", &value).unwrap();
        assert!(changed);
        assert_eq!(
            patched,
            "{\n  \"id\": \"x\",\n  \"name\": \"X\",\n  \"tests\": [\n    {\n      \"name\": \"X\",\n      \"src\": \"body\"\n    }\n  ]\n}\n"
        );
        let reparsed: Value = serde_json::from_str(&patched).unwrap();
        assert_eq!(reparsed["id"], "x");
        assert_eq!(reparsed["tests"], value);
    }

    #[test]
    fn a_string_value_containing_braces_does_not_confuse_the_scanner() {
        let raw = "{\n  \"id\": \"x\",\n  \"srcText\": \"function f() { return { a: 1 }; }\",\n  \"tests\": []\n}\n";
        let value = serde_json::json!([{ "name": "n", "src": "s" }]);
        let (patched, _) = set_field(raw, "tests", &value).unwrap();
        let reparsed: Value = serde_json::from_str(&patched).unwrap();
        assert_eq!(reparsed["srcText"], "function f() { return { a: 1 }; }");
        assert_eq!(reparsed["tests"], value);
    }

    #[test]
    fn a_non_object_document_is_refused() {
        assert!(set_field("[1, 2, 3]", "tests", &Value::Null).is_err());
    }

    #[test]
    fn preserves_crlf_and_unicode_inside_the_replaced_value_verbatim() {
        let value = serde_json::json!([{ "name": "X", "src": "line1\r\nline2 — em dash" }]);
        let (patched, _) = set_field(SAMPLE, "tests", &value).unwrap();
        let reparsed: Value = serde_json::from_str(&patched).unwrap();
        assert_eq!(reparsed["tests"][0]["src"], "line1\r\nline2 — em dash");
    }
}
