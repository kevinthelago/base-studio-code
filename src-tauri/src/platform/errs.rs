//! Command error ergonomics (#2082). Every `#[tauri::command]` returns `Result<T, String>` (the wire
//! error type), so a fallible call whose error isn't already a `String` was stringified with the
//! pervasive `.map_err(|e| e.to_string())` — 121 near-identical closures. [`StrErr::str_err`] collapses
//! that to a single call. The error type stays `String` (no wire change); this only removes the closure.

/// Map a `Result`'s error to its `Display` string — the shape every Tauri command returns.
pub(crate) trait StrErr<T> {
    /// Stringify the error via `Display`, yielding the `Result<T, String>` a command returns.
    /// Replaces `.map_err(|e| e.to_string())`.
    fn str_err(self) -> Result<T, String>;
}

impl<T, E: std::fmt::Display> StrErr<T> for Result<T, E> {
    fn str_err(self) -> Result<T, String> {
        self.map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn str_err_stringifies_the_error_via_display() {
        let err: Result<(), std::io::Error> = Err(std::io::Error::other("boom"));
        assert_eq!(err.str_err(), Err("boom".to_string()));
    }

    #[test]
    fn str_err_passes_ok_through() {
        let ok: Result<u8, std::fmt::Error> = Ok(7);
        assert_eq!(ok.str_err(), Ok(7));
    }
}
