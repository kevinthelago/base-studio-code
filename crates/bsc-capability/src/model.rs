//! What a network can DO — the shape both the screen and the session read.

use crate::freshness::{presented_state, Freshness, Observation, DEFAULT_BUDGET_MS};
use serde::{Deserialize, Serialize};

/// What KIND of thing this is. Deliberately a closed set: an open string would let each source invent
/// its own word for the same thing, and the screen would then group by a vocabulary nobody agreed.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CapabilityKind {
    /// A machine this app deploys to (`bsc deploy`).
    Device,
    /// A command surface a finished project exposes.
    Surface,
    /// A long-running service.
    Service,
    /// An MCP server a session can be given.
    Mcp,
}

impl CapabilityKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            CapabilityKind::Device => "device",
            CapabilityKind::Surface => "surface",
            CapabilityKind::Service => "service",
            CapabilityKind::Mcp => "mcp",
        }
    }
}

/// One thing that can be used now.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Capability {
    pub id: String,
    pub kind: CapabilityKind,
    pub name: String,
    /// How to actually drive it — the command or address a session would use. This is what makes the
    /// serialized form USEFUL to a session rather than merely descriptive: a capability the model
    /// cannot invoke is trivia.
    pub how: String,
    pub observed: Observation,
}

impl Capability {
    /// The state to SHOW — never the raw reading. See [`crate::freshness`].
    pub fn presented(&self, now_ms: u64, budget_ms: u64) -> String {
        presented_state(&self.observed, now_ms, budget_ms)
    }

    pub fn freshness(&self, now_ms: u64, budget_ms: u64) -> Freshness {
        Freshness::of(&self.observed, now_ms, budget_ms)
    }
}

/// One project's usable surface.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProjectCapabilities {
    pub project: String,
    pub capabilities: Vec<Capability>,
}

/// A whole network's answer to "what can I do here".
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct NetworkCapabilities {
    pub network: String,
    pub projects: Vec<ProjectCapabilities>,
    /// Capabilities the network owns that belong to no single project — the deploy roster is the
    /// first of these, because a device serves the whole network rather than one project.
    #[serde(default)]
    pub shared: Vec<Capability>,
}

impl NetworkCapabilities {
    pub fn total(&self) -> usize {
        self.shared.len() + self.projects.iter().map(|p| p.capabilities.len()).sum::<usize>()
    }

    fn all(&self) -> impl Iterator<Item = &Capability> {
        self.shared.iter().chain(self.projects.iter().flat_map(|p| p.capabilities.iter()))
    }

    /// How many capabilities may currently be believed.
    pub fn believable(&self, now_ms: u64, budget_ms: u64) -> usize {
        self.all().filter(|c| c.freshness(now_ms, budget_ms).is_believable()).count()
    }

    /// The CONTEXT a network's root session reads.
    ///
    /// Generated from this value, never hand-written — that is the whole point, and the failure it
    /// exists to prevent is `docs/llm-operator/context.md`, which was maintained by hand and was seven
    /// weeks wrong. Every line carries the presented state, so a stale capability reaches the model as
    /// unknown rather than as a fact it will then act on.
    pub fn to_context(&self, now_ms: u64, budget_ms: u64) -> String {
        let mut out = format!("# What `{}` can do right now\n", self.network);
        if self.total() == 0 {
            // An EXPLAINED empty, not a blank. A model handed nothing cannot tell "this network has
            // built nothing yet" from "the read failed", and will happily invent the difference.
            out.push_str(
                "\nThis network exposes NO capabilities yet — nothing it owns has been deployed or \
                 published. That is an answer, not a failure: there is nothing here to drive.\n",
            );
            return out;
        }
        out.push_str(&format!(
            "\n{} capability(ies); {} fresh enough to act on. Anything shown as `unknown` must be \
             re-checked before you rely on it — do not treat a stale reading as current.\n",
            self.total(),
            self.believable(now_ms, budget_ms)
        ));
        if !self.shared.is_empty() {
            out.push_str("\n## Network-wide\n");
            for c in &self.shared {
                out.push_str(&format!(
                    "- **{}** ({}) — {} · `{}`\n",
                    c.name,
                    c.kind.as_str(),
                    c.presented(now_ms, budget_ms),
                    c.how
                ));
            }
        }
        for p in &self.projects {
            if p.capabilities.is_empty() {
                continue;
            }
            out.push_str(&format!("\n## {}\n", p.project));
            for c in &p.capabilities {
                out.push_str(&format!(
                    "- **{}** ({}) — {} · `{}`\n",
                    c.name,
                    c.kind.as_str(),
                    c.presented(now_ms, budget_ms),
                    c.how
                ));
            }
        }
        out
    }

    /// The rows a SCREEN renders — the same values the context carries, flattened.
    ///
    /// Deliberately derived from `self` rather than assembled by the caller: it is what makes
    /// `the_screen_and_the_session_cannot_disagree` provable.
    pub fn rows(&self, now_ms: u64, budget_ms: u64) -> Vec<(String, String, String, String)> {
        let shared = self.shared.iter().map(|c| (String::new(), c));
        let owned = self
            .projects
            .iter()
            .flat_map(|p| p.capabilities.iter().map(move |c| (p.project.clone(), c)));
        shared
            .chain(owned)
            .map(|(proj, c)| {
                (proj, c.name.clone(), c.kind.as_str().to_string(), c.presented(now_ms, budget_ms))
            })
            .collect()
    }
}

/// The default budget, re-exported so a caller need not reach into `freshness`.
pub const BUDGET_MS: u64 = DEFAULT_BUDGET_MS;

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: u64 = 1_000_000_000;

    fn cap(name: &str, state: &str, age_ms: u64) -> Capability {
        Capability {
            id: format!("cap-{name}"),
            kind: CapabilityKind::Device,
            name: name.into(),
            how: format!("bsc deploy status {name}"),
            observed: Observation::seen(state, NOW - age_ms),
        }
    }

    fn net() -> NetworkCapabilities {
        NetworkCapabilities {
            network: "finance".into(),
            shared: vec![cap("lumpy-space", "current", 1000)],
            projects: vec![ProjectCapabilities {
                project: "income-engine".into(),
                capabilities: vec![cap("monitor", "current", BUDGET_MS + 1)],
            }],
        }
    }

    #[test]
    fn the_screen_and_the_session_cannot_disagree() {
        // The reason this is data first. Both views are derived from ONE value, so a capability the
        // context calls unknown cannot render as current on the screen. If the screen ever grows its
        // own query, this test is what should stop it.
        let n = net();
        let ctx = n.to_context(NOW, BUDGET_MS);
        for (_, name, _, presented) in n.rows(NOW, BUDGET_MS) {
            assert!(
                ctx.contains(&presented),
                "the screen shows '{presented}' for {name}, which the session's context does not say"
            );
        }
    }

    #[test]
    fn a_stale_capability_reaches_the_model_as_unknown() {
        // `monitor` was observed as "current", but too long ago. The context must not say "current".
        let ctx = net().to_context(NOW, BUDGET_MS);
        // ASSERT ON THE LINE, not on the document. `contains("unknown")` over the whole context is
        // VACUOUS — the header itself says "Anything shown as `unknown` must be re-checked", so that
        // assertion passed even with the freshness rule deleted. Caught by biting this file.
        let stale_line = ctx.lines().find(|l| l.contains("monitor")).unwrap_or_default();
        assert!(
            stale_line.contains("unknown"),
            "a stale capability was presented as fact: {stale_line}"
        );
        assert!(!stale_line.contains("current"), "the stale reading leaked through: {stale_line}");
        let fresh_line = ctx.lines().find(|l| l.contains("lumpy-space")).unwrap_or_default();
        assert!(fresh_line.contains("current"), "the FRESH one still reads as current: {fresh_line}");
    }

    #[test]
    fn an_empty_network_explains_itself_rather_than_returning_a_blank() {
        // A model handed nothing cannot distinguish "nothing is deployed" from "the read failed", and
        // will invent the difference. So the empty case says which.
        let empty = NetworkCapabilities { network: "kitchen".into(), projects: vec![], shared: vec![] };
        let ctx = empty.to_context(NOW, BUDGET_MS);
        assert!(ctx.contains("NO capabilities"), "got: {ctx}");
        assert!(ctx.contains("not a failure"), "it must say the empty is an answer: {ctx}");
        assert_eq!(empty.total(), 0);
        assert!(empty.rows(NOW, BUDGET_MS).is_empty());
    }

    #[test]
    fn believable_counts_only_what_is_fresh() {
        let n = net();
        assert_eq!(n.total(), 2);
        assert_eq!(n.believable(NOW, BUDGET_MS), 1, "the stale one does not count as usable");
    }

    #[test]
    fn every_capability_carries_how_to_drive_it() {
        // A capability a session cannot invoke is trivia. The context must hand over the command.
        let ctx = net().to_context(NOW, BUDGET_MS);
        assert!(ctx.contains("bsc deploy status lumpy-space"), "got: {ctx}");
    }

    #[test]
    fn the_context_warns_against_acting_on_a_stale_reading() {
        // The model is the consumer most likely to treat any line as fact, so the instruction rides
        // with the data rather than living in a prompt somewhere else that can drift from it.
        let ctx = net().to_context(NOW, BUDGET_MS);
        assert!(ctx.contains("re-checked"), "got: {ctx}");
    }

    #[test]
    fn a_project_with_no_capabilities_is_not_given_an_empty_heading() {
        let n = NetworkCapabilities {
            network: "x".into(),
            shared: vec![cap("d", "current", 0)],
            projects: vec![ProjectCapabilities { project: "silent".into(), capabilities: vec![] }],
        };
        assert!(!n.to_context(NOW, BUDGET_MS).contains("silent"));
    }
}
