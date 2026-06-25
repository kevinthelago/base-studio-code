//! Vendor-neutral platform-behavior model (#1193, #1195).
//!
//! A data scan copies *rows*; to **replace** a system you must also carry its
//! *behavior* — the logic that made those rows mean something. Every connector
//! contributes to one [`PlatformScan`] regardless of vendor (Salesforce, QuickBooks,
//! Quickbase, …), so the planner can summarize and the generated app can reproduce
//! automations, business processes, and derived logic **uniformly**.
//!
//! Read-only (#782): behavior is captured and reproduced in the new app — never
//! written back into the system of record.

use serde::{Deserialize, Serialize};

/// A read-only capture of a source platform's behavioral layer.
///
/// Sibling to the inferred Data Model: the data scan answers "what rows exist",
/// this answers "what the system *does*".
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformScan {
    pub automations: Vec<Automation>,
    pub business_processes: Vec<BusinessProcess>,
    pub derived_logic: Vec<DerivedLogic>,
}

impl PlatformScan {
    /// True when nothing behavioral was captured (e.g. a data-only connector like CSV).
    pub fn is_empty(&self) -> bool {
        self.automations.is_empty()
            && self.business_processes.is_empty()
            && self.derived_logic.is_empty()
    }
}

/// What kind of automation this is, across vendors.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AutomationKind {
    /// A reject-on-write rule (Salesforce validation rule, Quickbase form rule, a CHECK constraint).
    Validation,
    /// A trigger-on-write rule with actions (Salesforce workflow rule, a Quickbase automation).
    Workflow,
    /// A flow (Salesforce true Flow, a Quickbase Pipeline).
    Flow,
    /// Legacy Salesforce **Process Builder** (a `Flow` with `ProcessType = Workflow`). Deprecated
    /// upstream, which makes capturing it for migration *more* important, not less.
    ProcessBuilder,
    /// A scheduled / recurring automation (a QuickBooks recurring transaction, a scheduled flow).
    Recurring,
    /// Anything else a connector wants to record.
    Other,
}

/// A trigger- or schedule-driven automation.
/// Maps to a generated rule or job in the new app.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Automation {
    /// The connector the behavior came from (recorded as lineage).
    pub source: String,
    pub kind: AutomationKind,
    pub name: String,
    /// The entity/table it acts on; empty when global.
    pub object: String,
    pub active: bool,
    /// When it fires — free-form per vendor (`onCreateOrUpdate`, `recurring:monthly`, …).
    pub trigger: String,
    /// The gating condition / formula; empty when unconditional.
    pub condition: String,
    /// What it does (action names / descriptions).
    pub actions: Vec<String>,
}

/// A multi-step business process gating a record's state (an approval process, a stage workflow).
/// Maps to a generated approval/stage workflow.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BusinessProcess {
    pub source: String,
    pub name: String,
    pub object: String,
    pub active: bool,
    /// Step labels in order; may be empty when the connector can't enumerate them.
    pub steps: Vec<String>,
}

/// Whether derived logic is declarative or imperative.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DerivedKind {
    /// A declarative formula (Salesforce formula field, a Quickbase formula).
    Formula,
    /// Imperative code (Salesforce Apex, a DB trigger / stored procedure).
    Code,
}

/// Derived logic that computes a value or runs imperatively.
/// Maps to a computed field or a service function; summarized for re-implementation, not auto-ported.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DerivedLogic {
    pub source: String,
    pub kind: DerivedKind,
    pub name: String,
    /// The entity it belongs to, when applicable.
    pub object: Option<String>,
    /// The formula expression or code body — summarized for a worker to re-implement.
    pub expression: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_scan_is_empty() {
        assert!(PlatformScan::default().is_empty());
    }

    #[test]
    fn a_scan_with_any_category_is_not_empty() {
        let scan = PlatformScan {
            automations: vec![Automation {
                source: "x".into(),
                kind: AutomationKind::Flow,
                name: "n".into(),
                object: "Account".into(),
                active: true,
                trigger: "onCreate".into(),
                condition: String::new(),
                actions: vec![],
            }],
            ..Default::default()
        };
        assert!(!scan.is_empty());
    }
}
