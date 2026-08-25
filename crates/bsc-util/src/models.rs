//! The canonical model-tier registry — ONE list for the app and every `bsc-*` CLI.
//!
//! A tier is what the user, a persona, a team placement or a fleet stream selects; the harness maps
//! it to `claude --model <alias>`, and the alias always resolves to the newest model in that family,
//! which is why the trailing version in the id is cosmetic.
//!
//! ## Why this is a registry and not three literals
//!
//! The vocabulary was written twice and reachable from neither CLI: `@data/console/models.json` (the
//! catalog the UI renders) and a `match` in `src-tauri/src/session/launch.rs` (the alias the launch
//! injects). Nothing pinned the two together, and neither could be seen from `bsc persona` or
//! `bsc teams` — so the verbs that write a model would have needed a THIRD copy to validate against.
//! This is that one copy; `claude_model_flag` reads it, and a guard test in `src-tauri/src/tests.rs`
//! fails if the UI catalog drifts from it.
//!
//! ## An unset model is a real state
//!
//! Nothing here has a default. A persona, a placement or a pane with no model launches Claude Code
//! with no `--model` at all, on the harness's own default — so "unset" means "whatever the claude
//! CLI picks", not a tier this list gets to choose on its behalf.

/// One selectable model tier.
pub struct ModelTier {
    /// The id every store writes and the UI renders (`"haiku-4.5"`).
    pub id: &'static str,
    /// The alias Claude Code's `--model` flag accepts (`"haiku"`) — a family, so it tracks the latest
    /// model in that family rather than pinning the version the id happens to name.
    pub alias: &'static str,
    /// One-word character of the tier, as the model menu labels it (fast / balanced / deep).
    pub tone: &'static str,
}

/// Every selectable tier, cheapest → most capable. The order is the model menu's order, and
/// `@data/console/models.json` must list exactly these ids in exactly this order (guard test).
pub const MODEL_TIERS: &[ModelTier] = &[
    ModelTier { id: "haiku-4.5", alias: "haiku", tone: "fast" },
    ModelTier { id: "sonnet-4.5", alias: "sonnet", tone: "balanced" },
    ModelTier { id: "opus-4.5", alias: "opus", tone: "deep" },
];

/// The alias `claude --model` takes for a tier id, or `None` for anything unrecognized.
///
/// `None` is the safe answer, not an error: the caller then launches with no `--model` and the
/// session runs on Claude Code's own default. It also means only a fixed literal from this table is
/// ever interpolated into a shell command — there is no injection surface even for a caller that
/// hands over an arbitrary string.
pub fn model_alias(id: &str) -> Option<&'static str> {
    MODEL_TIERS.iter().find(|m| m.id == id).map(|m| m.alias)
}

/// Whether `id` names a tier this app can launch. Trims, so a value that arrived through argv or a
/// hand-edited store record is judged on its content.
pub fn is_model_id(id: &str) -> bool {
    model_alias(id.trim()).is_some()
}

/// Every tier id, in menu order — for an error that names what the caller could have said instead of
/// only what they did.
pub fn model_ids() -> Vec<&'static str> {
    MODEL_TIERS.iter().map(|m| m.id).collect()
}

/// The tier ids as one `haiku-4.5 | sonnet-4.5 | opus-4.5` string, for usage lines and errors.
pub fn model_id_list() -> String {
    model_ids().join(" | ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_tier_maps_to_its_cli_alias() {
        assert_eq!(model_alias("haiku-4.5"), Some("haiku"));
        assert_eq!(model_alias("sonnet-4.5"), Some("sonnet"));
        assert_eq!(model_alias("opus-4.5"), Some("opus"));
    }

    /// An unknown tier resolves to `None` rather than to a guess. This is what keeps a typo from
    /// launching a session on a model the caller never asked for: no `--model` is injected and the
    /// harness default applies, which is a state the user can observe and correct.
    #[test]
    fn an_unknown_tier_is_none_not_a_default() {
        for junk in ["", "opus", "haiku-4", "gpt-4o", "  ", "OPUS-4.5"] {
            assert_eq!(model_alias(junk), None, "{junk:?} is not a tier id");
        }
    }

    /// `is_model_id` trims but does not otherwise normalize — a store record or an argv value with
    /// stray whitespace is still the tier it names, while a differently-cased one is not (the ids are
    /// written verbatim by every store, so case is identity, not presentation).
    #[test]
    fn validation_trims_and_stays_case_sensitive() {
        assert!(is_model_id(" sonnet-4.5\n"));
        assert!(!is_model_id("Sonnet-4.5"));
        assert!(!is_model_id(""));
    }

    /// The alias is a FAMILY, never the versioned id — the whole reason the trailing version is
    /// cosmetic. An alias that ever equalled its id would silently pin a session to one model.
    #[test]
    fn no_alias_is_a_versioned_id() {
        for m in MODEL_TIERS {
            assert!(!m.alias.contains('.'), "{} is a versioned alias, not a family", m.alias);
            assert_ne!(m.alias, m.id);
        }
    }

    #[test]
    fn the_id_list_names_every_tier_in_menu_order() {
        assert_eq!(model_id_list(), "haiku-4.5 | sonnet-4.5 | opus-4.5");
    }
}
