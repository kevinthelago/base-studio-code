//! Which ProjectV2 board a publish should land on — ported from `src/shared/lib/github/projectSync.ts`
//! under `epic-frontend-logic-over-backend-resources-belongs-in-rust`, proved against
//! `src/shared/lib/github/projectSync.fixtures.json`.
//!
//! # The defect this exists to close
//!
//! [`crate::ensure_project_board`] resolves the board TWO ways — a recorded id, else create — and never
//! looks for an existing same-title board. Its GraphQL asks `repositoryOwner(login){ id }` and nothing
//! more, so it cannot adopt even in principle. That is precisely the bug #444 fixed on the frontend
//! path, whose own header records it: creation "used to fire blindly and mint a *second* board on every
//! re-sync of a same-titled project". A publish through `bsc publish run` can therefore still duplicate
//! a board whose id is not recorded.
//!
//! This module is the DECISION only. Wiring it into `ensure_project_board` changes that function's
//! query and its behaviour on a live publish path, so it is its own item with its own revert —
//! `the-publish-path-adopts-an-existing-board`.
//!
//! # The title matcher is the part that drifts
//!
//! It is the shared matcher (#380), and every one of its rules is a case a careless port gets wrong:
//! ends are TRIMMED but inner whitespace is NOT collapsed, comparison is case-folded, a BLANK target
//! matches nothing at all (even a blank-titled board), and the FIRST match wins.

/// A ProjectV2 board, as the owner lookup returns it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BoardRef {
    pub id: String,
    pub number: i64,
    pub url: String,
    pub title: String,
}

/// How the board was resolved. The three arms are distinct outcomes a caller reports differently, so
/// they are an enum rather than an id plus a flag.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BoardChoice {
    /// Already linked — nothing was queried and nothing created.
    Linked { id: String },
    /// An existing board with the same title was adopted.
    Adopted { id: String, number: i64, url: String },
    /// No board matched, so one is to be created.
    Create,
}

/// The first board whose title matches, or `None`.
///
/// Trims the ends and case-folds, mirroring the shared matcher so "a project with this title exists"
/// is judged one way for both the local draft-title guard and this adopt check. A BLANK target returns
/// `None` rather than matching a blank-titled board — a sentinel meaning "no title to match on".
pub fn find_board_by_title<'a>(boards: &'a [BoardRef], title: &str) -> Option<&'a BoardRef> {
    let target = title.trim().to_lowercase();
    if target.is_empty() {
        return None;
    }
    boards.iter().find(|b| b.title.trim().to_lowercase() == target)
}

/// Resolve which board a publish should use, given the boards the owner already has.
///
/// `active_project_id` is the board already recorded for this project. An EMPTY string is not a linked
/// board — the TypeScript tests it for truthiness, so `""` falls through to the adopt-or-create path,
/// and a port that checked only for `Some` would short-circuit on it.
///
/// Returns [`BoardChoice::Create`] rather than creating anything: this decides, the caller acts.
pub fn choose_board(active_project_id: Option<&str>, boards: &[BoardRef], title: &str) -> BoardChoice {
    if let Some(id) = active_project_id.filter(|s| !s.is_empty()) {
        return BoardChoice::Linked { id: id.to_string() };
    }
    match find_board_by_title(boards, title) {
        Some(b) => BoardChoice::Adopted { id: b.id.clone(), number: b.number, url: b.url.clone() },
        None => BoardChoice::Create,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    /// Resolved BY FILENAME under `src/`, the rule every generated contract here uses. Exactly one
    /// match; zero or a collision fails hard rather than taking a silent first hit.
    fn fixture() -> Value {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../src");
        let mut found: Vec<std::path::PathBuf> = Vec::new();
        fn walk(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
            let Ok(rd) = std::fs::read_dir(dir) else { return };
            for e in rd.flatten() {
                let p = e.path();
                if p.is_dir() {
                    walk(&p, out);
                } else if p.file_name().and_then(|n| n.to_str()) == Some("projectSync.fixtures.json") {
                    out.push(p);
                }
            }
        }
        walk(&root, &mut found);
        assert_eq!(found.len(), 1, "expected exactly one projectSync.fixtures.json, got {found:?}");
        serde_json::from_str(&std::fs::read_to_string(&found[0]).unwrap()).unwrap()
    }

    fn board_of(v: &Value) -> BoardRef {
        BoardRef {
            id: v["id"].as_str().unwrap().to_string(),
            number: v["number"].as_i64().unwrap(),
            url: v["url"].as_str().unwrap().to_string(),
            title: v["title"].as_str().unwrap().to_string(),
        }
    }

    /// Reports every mismatch at once — a wrong port is wrong in a pattern.
    #[test]
    fn the_board_choice_matches_the_typescript_case_for_case() {
        let doc = fixture();
        let mut bad: Vec<String> = Vec::new();

        for c in doc["findByTitle"].as_array().expect("findByTitle") {
            let boards: Vec<BoardRef> = c["boards"].as_array().unwrap().iter().map(board_of).collect();
            let got = find_board_by_title(&boards, c["title"].as_str().unwrap());
            let want = c["found"].as_object().map(|_| board_of(&c["found"]));
            // WHOLE BOARD compared — a matcher that finds the right one and returns the wrong fields
            // passes an id-only check.
            if got.cloned() != want {
                bad.push(format!("  findByTitle {:?}: ts {want:?}, rust {:?}", c["label"], got));
            }
        }

        for c in doc["ensure"].as_array().expect("ensure") {
            let label = c["label"].as_str().unwrap();
            let active = c["activeProjectId"].as_str();
            // Inputs read FROM THE FIXTURE, never reconstructed from the expected result — that would
            // make the case-insensitive case assert nothing, since the reconstruction would use the
            // target title.
            let boards: Vec<BoardRef> = c["ownerBoards"].as_array().map(|a| a.iter().map(board_of).collect()).unwrap_or_default();
            let title = c["title"].as_str().unwrap();
            let ts = &c["result"];
            let action = ts["action"].as_str().unwrap();
            let got = choose_board(active, &boards, title);
            let ok = match (action, &got) {
                ("linked", BoardChoice::Linked { id }) => Some(id.as_str()) == ts["id"].as_str(),
                ("adopted", BoardChoice::Adopted { id, number, url }) => {
                    Some(id.as_str()) == ts["id"].as_str()
                        && Some(*number) == ts["number"].as_i64()
                        && Some(url.as_str()) == ts["url"].as_str()
                }
                ("created", BoardChoice::Create) => true,
                _ => false,
            };
            if !ok {
                bad.push(format!("  ensure {label:?}: ts {ts}, rust {got:?}"));
            }
        }

        assert!(bad.is_empty(), "the Rust board choice disagrees with the live TypeScript:\n{}", bad.join("\n"));
    }

    /// The four matcher rules, asserted directly. Each is a case a corpus of ordinary distinct titles
    /// would never separate.
    #[test]
    fn the_title_matcher_trims_folds_case_and_refuses_a_blank() {
        let b = |id: &str, title: &str| BoardRef { id: id.into(), number: 1, url: "u".into(), title: title.into() };

        assert_eq!(find_board_by_title(&[b("p1", "  Studio Code  ")], "\tStudio Code\n").map(|x| x.id.as_str()), Some("p1"));
        assert_eq!(find_board_by_title(&[b("p1", "STUDIO code")], "studio CODE").map(|x| x.id.as_str()), Some("p1"));
        // Inner whitespace is NOT collapsed — only the ends are trimmed.
        assert!(find_board_by_title(&[b("p1", "Studio  Code")], "Studio Code").is_none());
        // FIRST match wins.
        assert_eq!(
            find_board_by_title(&[b("p1", "Studio Code"), b("p2", "studio code")], "Studio Code").map(|x| x.id.as_str()),
            Some("p1")
        );
        // A blank target matches NOTHING, even a blank-titled board.
        assert!(find_board_by_title(&[b("p1", "")], "").is_none());
        assert!(find_board_by_title(&[b("p1", "   ")], "   ").is_none());
    }

    /// An EMPTY linked id is falsy in the TypeScript, so it must not short-circuit as linked — the
    /// sentinel a port that only checks `Some` gets wrong.
    #[test]
    fn an_empty_linked_id_is_not_a_linked_board() {
        let boards = vec![BoardRef { id: "p9".into(), number: 7, url: "u".into(), title: "Studio Code".into() }];
        assert_eq!(choose_board(Some(""), &boards, "Studio Code"), BoardChoice::Adopted { id: "p9".into(), number: 7, url: "u".into() });
        assert_eq!(choose_board(None, &boards, "Studio Code"), BoardChoice::Adopted { id: "p9".into(), number: 7, url: "u".into() });
        assert_eq!(choose_board(Some("real"), &boards, "Studio Code"), BoardChoice::Linked { id: "real".into() });
    }

    /// A linked board wins WITHOUT consulting the boards at all — the short-circuit that makes the
    /// owner query unnecessary in that arm.
    #[test]
    fn a_linked_board_is_returned_without_looking_at_the_others() {
        let boards = vec![BoardRef { id: "other".into(), number: 1, url: "u".into(), title: "Studio Code".into() }];
        assert_eq!(choose_board(Some("linked-id"), &boards, "Studio Code"), BoardChoice::Linked { id: "linked-id".into() });
    }
}
