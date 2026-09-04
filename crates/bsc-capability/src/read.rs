//! Assembling a network's capabilities from the stores that actually know.
//!
//! Every source is INJECTED rather than reached for, so the aggregation is testable without a
//! populated machine — the rules that matter here (which project belongs to which network, what
//! counts as never-observed) are the ones a live read is worst at exercising, because a real box
//! always has *some* data and never the awkward shapes.

use crate::freshness::Observation;
use crate::model::{Capability, CapabilityKind, NetworkCapabilities, ProjectCapabilities};

/// A device as the deploy roster knows it. Mirrors `bsc-deploy`'s `Device` without depending on it:
/// this crate must stay lean, and a roster entry is three strings.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DeviceRow {
    pub name: String,
    pub arch: String,
    /// What was read from it, and when. `None` for the whole observation means nothing has looked.
    pub observed: Observation,
}

/// Everything the aggregation needs, handed in.
pub struct Sources {
    /// `(project_key, network_id)` for every project that has a network. A project with none is
    /// deliberately absent rather than carrying a sentinel — "unfiled" is a real state and belongs to
    /// the caller's vocabulary, not to this one.
    pub project_networks: Vec<(String, String)>,
    /// The deploy roster. Network-wide rather than per-project: a device serves the whole domain.
    pub devices: Vec<DeviceRow>,
}

/// What `<network>` can do.
///
/// A network with no projects and no devices returns an EMPTY value, not an error — "this network has
/// built nothing yet" is an answer, and [`NetworkCapabilities::to_context`] renders it as one.
pub fn capabilities_of(network: &str, src: &Sources) -> NetworkCapabilities {
    let mut projects: Vec<ProjectCapabilities> = src
        .project_networks
        .iter()
        .filter(|(_, n)| n == network)
        .map(|(p, _)| ProjectCapabilities { project: p.clone(), capabilities: Vec::new() })
        .collect();
    // Stable order so two reads agree — a screen that reorders itself between polls reads as churn,
    // and a context whose lines move defeats a diff.
    projects.sort_by(|a, b| a.project.cmp(&b.project));

    let shared = src
        .devices
        .iter()
        .map(|d| Capability {
            id: format!("device:{}", d.name),
            kind: CapabilityKind::Device,
            name: d.name.clone(),
            how: format!("bsc deploy status {}", d.name),
            observed: d.observed.clone(),
        })
        .collect();

    NetworkCapabilities { network: network.to_string(), projects, shared }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn src() -> Sources {
        Sources {
            project_networks: vec![
                ("income-engine".into(), "network-finance".into()),
                ("finance-command".into(), "network-finance".into()),
                ("glauxb".into(), "network-kitchen".into()),
            ],
            devices: vec![DeviceRow {
                name: "lumpy-space".into(),
                arch: "x86_64".into(),
                observed: Observation::seen("current", 1_000),
            }],
        }
    }

    #[test]
    fn a_network_gets_only_its_own_projects() {
        let c = capabilities_of("network-finance", &src());
        let names: Vec<&str> = c.projects.iter().map(|p| p.project.as_str()).collect();
        assert_eq!(names, vec!["finance-command", "income-engine"], "sorted, and kitchen's is absent");
    }

    #[test]
    fn a_network_with_nothing_is_empty_rather_than_an_error() {
        // "This network has built nothing yet" is an ANSWER. Returning an error here would make an
        // ordinary state look like a broken read, and the caller would report the wrong thing.
        let c = capabilities_of("network-legal", &src());
        assert!(c.projects.is_empty());
        assert_eq!(c.total(), 1, "it still sees the network-wide devices");
    }

    #[test]
    fn a_device_carries_the_command_that_drives_it() {
        let c = capabilities_of("network-finance", &src());
        let d = &c.shared[0];
        assert_eq!(d.how, "bsc deploy status lumpy-space");
        assert_eq!(d.kind, CapabilityKind::Device);
    }

    #[test]
    fn a_never_observed_device_stays_never_observed() {
        // The shape a live read is worst at producing: a roster entry nothing has probed. It must not
        // acquire a timestamp on the way through, or it would render as fresh.
        let s = Sources {
            project_networks: vec![],
            devices: vec![DeviceRow {
                name: "monitor".into(),
                arch: "aarch64".into(),
                observed: Observation::never(),
            }],
        };
        let c = capabilities_of("network-finance", &s);
        assert_eq!(c.shared[0].observed.at_ms, None);
        assert!(c.shared[0].presented(9_999_999, 1_000).contains("never observed"));
    }

    #[test]
    fn the_order_is_stable_across_reads() {
        // A screen that reorders between polls reads as churn; a context whose lines move defeats a
        // diff. Cheap to guarantee, expensive to notice missing.
        let a = capabilities_of("network-finance", &src());
        let b = capabilities_of("network-finance", &src());
        assert_eq!(a, b);
    }
}
