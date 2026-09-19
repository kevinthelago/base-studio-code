/// An entry id is a slug: a generated claim cites it, so it must survive a shell, a URL and a JSON
/// document untouched.
pub fn valid_id(id: &str) -> bool {
    (1..=60).contains(&id.len())
        && id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && !id.starts_with('-')
        && !id.ends_with('-')
}
