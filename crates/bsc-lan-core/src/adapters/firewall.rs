//! [`FirewallAdapter`]: pf tables and rules. Implemented by
//! `bsc-lan-adapter-opnsense`.

use crate::action::{FirewallRuleId, FirewallRuleSpec, PfTable};
use crate::error::{ControlError, ObservationError};
use crate::evidence::{Observed, Verified};
use crate::target::Target;

/// One firewall rule as read back from the live ruleset: its identity, the
/// spec it was created from (as best the adapter can reconstruct it), and
/// whether it is currently enabled. `rule_explain()` and `verify_rules()`
/// both work by evaluating this against a flow tuple or a structural
/// predicate in the *caller*, not in the adapter -- see
/// `topology-health-and-capacity-tools`.
#[derive(Debug, Clone, PartialEq)]
pub struct FirewallRuleState {
    pub id: FirewallRuleId,
    pub spec: FirewallRuleSpec,
    pub enabled: bool,
}

/// pf tables and rules on OPNsense.
pub trait FirewallAdapter: Send + Sync {
    /// Add `target` to `table`, idempotently. `Verified::was_idempotent`
    /// tells the caller whether it was already present -- the containment-
    /// actions contract requires `dns_block` and friends to be idempotent
    /// rather than duplicating entries.
    fn add_table_entry(
        &self,
        table: &PfTable,
        target: &Target,
    ) -> impl std::future::Future<Output = Result<Verified<bool>, ControlError>> + Send;

    /// Remove `target` from `table`, idempotently (removing an absent
    /// entry is a successful no-op, not an error).
    fn remove_table_entry(
        &self,
        table: &PfTable,
        target: &Target,
    ) -> impl std::future::Future<Output = Result<Verified<bool>, ControlError>> + Send;

    /// Every target currently in `table`, for dry-run idempotency previews
    /// and for `drift()`/`verify_rules()`.
    fn read_table(
        &self,
        table: &PfTable,
    ) -> impl std::future::Future<Output = Result<Observed<Vec<Target>>, ObservationError>> + Send;

    /// Add a new rule. There is deliberately no `remove_rule` -- rules are
    /// only ever added or disabled; see [`crate::action::Action`]'s module
    /// docs on why delete is absent from the catalog entirely.
    fn add_rule(
        &self,
        spec: &FirewallRuleSpec,
    ) -> impl std::future::Future<Output = Result<Verified<Option<FirewallRuleId>>, ControlError>> + Send;

    /// Enable or disable an existing rule. `Verified::prior` is the rule's
    /// enabled state before this call.
    fn set_rule_enabled(
        &self,
        rule: &FirewallRuleId,
        enabled: bool,
    ) -> impl std::future::Future<Output = Result<Verified<bool>, ControlError>> + Send;

    /// The full live ruleset, for `rule_explain()`, `verify_rules()` and
    /// `drift()`, all of which evaluate it in the caller rather than asking
    /// OPNsense to do the matching.
    fn read_ruleset(
        &self,
    ) -> impl std::future::Future<Output = Result<Observed<Vec<FirewallRuleState>>, ObservationError>>
           + Send;
}
