//! What SHOULD happen — decided without touching the network.
//!
//! Every interesting rule in a deploy is a decision about two facts (what the device has, what we
//! built) and a refusal condition. Keeping that pure is what lets the rules be tested at all: the IO
//! half needs four real machines, and three of them are currently unreachable.

use crate::roster::Device;

/// What a device currently has, as read from it. `None` fields mean "could not tell", which is never
/// the same as "nothing" — see [`Plan::decide`].
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RemoteState {
    /// sha256 of the binary `current` points at, if the device could be read.
    pub current_sha: Option<String>,
    /// sha256 of the binary `previous` points at — what a rollback would restore.
    pub previous_sha: Option<String>,
    /// `uname -m` as actually reported, if the device answered.
    pub arch: Option<String>,
}

/// The decision.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Plan {
    /// Already running these exact bytes. Content-addressed, so this is knowable rather than assumed.
    UpToDate,
    /// Ship it.
    Deploy,
    /// Do not ship, and why. A refusal is a RESULT, not an error to be retried.
    Refuse(String),
}

impl Plan {
    /// Decide, given the device we mean to reach, the sha of the artifact we built, the architecture
    /// we built it FOR, and whatever we could learn from the device.
    ///
    /// The ordering is deliberate: **architecture is checked before staleness.** A mismatched binary
    /// that happens to share a sha with what is installed is still the wrong binary, and answering
    /// "up to date" there would be a lie that hides a broken roster.
    pub fn decide(
        device: &Device,
        artifact_sha: &str,
        artifact_arch: &str,
        remote: &RemoteState,
    ) -> Plan {
        // The roster's recorded arch is the first gate, and it works OFFLINE — an unreachable device
        // still gets a correct refusal rather than an unknown.
        if device.arch != artifact_arch {
            return Plan::Refuse(format!(
                "device '{}' is {} and this artifact is {} — build for {} or fix the roster",
                device.name, device.arch, artifact_arch, device.arch
            ));
        }
        // …and the device's OWN answer is the second, because a roster is a claim and hardware is a
        // fact. Disagreement means the roster is wrong, and shipping on a wrong roster is exactly how
        // an x86_64 binary lands on a Pi.
        if let Some(actual) = &remote.arch {
            if actual != &device.arch {
                return Plan::Refuse(format!(
                    "device '{}' reports {actual} but the roster says {} — fix the roster before deploying",
                    device.name, device.arch
                ));
            }
        }
        match &remote.current_sha {
            // Identical bytes. Not a restart, not a "success" — a no-op, and saying so is the point.
            Some(sha) if sha == artifact_sha => Plan::UpToDate,
            // Either it has something else, or it has nothing (a first deploy). Both ship.
            _ => Plan::Deploy,
        }
    }
}

/// What a health probe concluded, and therefore whether the swap stands.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Outcome {
    /// The new binary ran on the device. The swap stands.
    Healthy,
    /// It did not. The symlink must go back.
    RollBack(String),
    /// It did not, AND there is nothing to go back to — a first deploy that failed its probe.
    /// Distinct from [`Outcome::RollBack`] because the operator's next move is different: there is no
    /// previous binary to restore, so the device is left with a staged-but-unswapped `current`.
    FailedWithNoPrevious(String),
}

/// Read a probe result into an outcome. `previous_sha` is what the device could roll back TO.
pub fn outcome(probe_ok: bool, detail: &str, previous_sha: Option<&str>) -> Outcome {
    if probe_ok {
        return Outcome::Healthy;
    }
    match previous_sha {
        Some(_) => Outcome::RollBack(detail.to_string()),
        None => Outcome::FailedWithNoPrevious(detail.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dev(arch: &str) -> Device {
        Device { name: "monitor".into(), ssh: "lan@10.99.5.10".into(), arch: arch.into(), service: None }
    }

    #[test]
    fn identical_bytes_are_a_no_op_rather_than_a_restart() {
        let r = RemoteState { current_sha: Some("abc".into()), ..Default::default() };
        assert_eq!(Plan::decide(&dev("aarch64"), "abc", "aarch64", &r), Plan::UpToDate);
    }

    #[test]
    fn different_bytes_deploy_and_so_does_an_empty_device() {
        let has_other = RemoteState { current_sha: Some("old".into()), ..Default::default() };
        assert_eq!(Plan::decide(&dev("aarch64"), "new", "aarch64", &has_other), Plan::Deploy);
        let first_time = RemoteState::default();
        assert_eq!(Plan::decide(&dev("aarch64"), "new", "aarch64", &first_time), Plan::Deploy);
    }

    #[test]
    fn an_arch_mismatch_is_refused_from_the_roster_alone_so_it_works_offline() {
        // The acceptance criterion: never ship x86_64 to an aarch64 host. This must hold with the
        // device unreachable, which is why the roster records arch instead of only probing it.
        let unreachable = RemoteState::default();
        let p = Plan::decide(&dev("aarch64"), "abc", "x86_64", &unreachable);
        match p {
            Plan::Refuse(m) => assert!(m.contains("aarch64") && m.contains("x86_64"), "got: {m}"),
            other => panic!("expected a refusal, got {other:?}"),
        }
    }

    #[test]
    fn the_arch_check_runs_before_the_staleness_check() {
        // A mismatched binary that happens to share a sha with what is installed is still the wrong
        // binary. Reporting "up to date" would hide a broken roster behind a reassuring word.
        let same_sha = RemoteState { current_sha: Some("abc".into()), ..Default::default() };
        assert!(matches!(
            Plan::decide(&dev("aarch64"), "abc", "x86_64", &same_sha),
            Plan::Refuse(_)
        ));
    }

    #[test]
    fn the_device_overrules_the_roster_when_they_disagree() {
        // A roster is a claim; `uname -m` is a fact. Trusting the claim is how the wrong binary lands.
        let reports_arm = RemoteState { arch: Some("aarch64".into()), ..Default::default() };
        let p = Plan::decide(&dev("x86_64"), "abc", "x86_64", &reports_arm);
        match p {
            Plan::Refuse(m) => assert!(m.contains("reports aarch64"), "got: {m}"),
            other => panic!("expected a refusal, got {other:?}"),
        }
    }

    #[test]
    fn a_failed_probe_rolls_back_when_there_is_something_to_roll_back_to() {
        assert_eq!(outcome(false, "boom", Some("old")), Outcome::RollBack("boom".into()));
    }

    #[test]
    fn a_failed_first_deploy_is_its_own_outcome_not_a_rollback() {
        // Distinct because the operator's next move differs: there is no previous binary to restore.
        // Collapsing it into RollBack would report a restore that never happened.
        assert_eq!(
            outcome(false, "boom", None),
            Outcome::FailedWithNoPrevious("boom".into())
        );
    }

    #[test]
    fn a_healthy_probe_stands() {
        assert_eq!(outcome(true, "", Some("old")), Outcome::Healthy);
    }
}
