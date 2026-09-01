//! The integration band's data path (`the-integration-band-gets-its-data-path`).
//!
//! One read serving the Glance integration band: which projects DECLARED which integrations, joined to
//! what each registered connector last VERIFIED.
//!
//! # Why this is a backend read and not a shell-out
//!
//! `src-tauri` already depends on `plandb` and `bsc-data`, so this calls
//! [`plandb::scan_declared_integrations`] and the connector stores DIRECTLY — no subprocess, no `bsc`
//! on PATH, and no parsing a CLI's stdout back into the structs it had just serialized. It is also
//! where this codebase wants the logic: the frontend reports and displays, and policy lives with the
//! resource that owns it.
//!
//! It is the SAME scan `bsc project integrations` runs, not a second implementation. The CLI and the
//! graph must never be able to disagree about which projects declared what, and sharing one function
//! makes that structural rather than a promise somebody has to keep.
//!
//! # The verdict is classified HERE, against the manifest registered now
//!
//! A stored `live: true` whose manifest has since been edited is a green light for a shape nobody ran.
//! `bsc_data::checks::check_state` is what tells those apart, and it needs the CURRENT preset — so the
//! classification happens on this side, where both stores are in hand, rather than shipping a raw
//! verdict the frontend would have to re-derive without the manifest.

use serde::Serialize;

/// One project's declared integration, as the band's projection consumes it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeclaredRow {
    pub project: String,
    pub id: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub name: String,
    pub direction: String,
}

/// One registered connector and the state of its last verification.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorRow {
    pub id: String,
    /// `never-checked` | `live` | `failing` | `stale` — already classified against the manifest
    /// registered NOW, so the frontend never has to hold a manifest to know what a verdict means.
    pub state: bsc_data::checks::CheckState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Both halves of the integration band, in one read.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationBand {
    pub declared: Vec<DeclaredRow>,
    pub connectors: Vec<ConnectorRow>,
    /// Project keys whose plan store could not be READ, so a short list is never mistaken for a
    /// complete one — carried through from the scan rather than dropped at this boundary.
    pub unreadable: Vec<String>,
}

/// Read the band's data from the stores. Pure over the paths, so tests drive it without a real home.
pub(crate) fn read_integration_band(
    plans_dir: &std::path::Path,
    connectors_path: &std::path::Path,
    checks_path: &std::path::Path,
) -> IntegrationBand {
    let scan = plandb::scan_declared_integrations(plans_dir, None);
    let declared = scan
        .integrations
        .into_iter()
        .map(|d| DeclaredRow {
            project: d.project,
            id: d.integration.id,
            name: d.integration.name,
            direction: d.integration.direction,
        })
        .collect();

    // An unreadable connector store is an install with none — the same reading as an absent one, and
    // the normal state on every machine today.
    let presets = bsc_data::load_runtime_presets(connectors_path).unwrap_or_default();
    let checks = bsc_data::checks::load_checks(checks_path).unwrap_or_default();
    let connectors = presets
        .iter()
        .map(|p| {
            let recorded = checks.iter().find(|c| c.id == p.id);
            ConnectorRow {
                id: p.id.clone(),
                state: bsc_data::checks::check_state(recorded, p),
                // The reason is carried ONLY with a live failure. A stale verdict's error describes a
                // manifest that is no longer registered, so surfacing it would explain the wrong thing.
                error: match bsc_data::checks::check_state(recorded, p) {
                    bsc_data::checks::CheckState::Failing => {
                        recorded.and_then(|c| c.error.clone())
                    }
                    _ => None,
                },
            }
        })
        .collect();

    IntegrationBand { declared, connectors, unreadable: scan.unreadable }
}

/// `glance_integration_band` — the band's two inputs, read from this machine's stores.
#[tauri::command]
pub(crate) fn glance_integration_band() -> IntegrationBand {
    let base = crate::platform::paths::bsc_base_dir();
    read_integration_band(
        &base.join("plans"),
        &bsc_data::runtime_store_path(),
        &bsc_data::checks::checks_store_path(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("bsc-band-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// AN EMPTY INSTALL IS AN EMPTY BAND. This is every machine today — zero declared, zero
    /// registered — and it must produce no nodes rather than a placeholder.
    #[test]
    fn nothing_declared_and_nothing_registered_is_an_empty_band() {
        let d = scratch("empty");
        let band = read_integration_band(&d.join("plans"), &d.join("no.json"), &d.join("nc.json"));
        assert_eq!(band, IntegrationBand { declared: vec![], connectors: vec![], unreadable: vec![] });
        let _ = std::fs::remove_dir_all(&d);
    }

    /// The declared half comes back project-tagged, through the SAME scan the CLI runs.
    #[test]
    fn declarations_come_back_tagged_by_project() {
        let d = scratch("declared");
        let plans = d.join("plans");
        std::fs::create_dir_all(&plans).unwrap();
        for (key, id) in [("storefront", "stripe"), ("billing", "stripe")] {
            let s = plandb::Store::open(&plans.join(format!("{key}.db"))).unwrap();
            s.integration_set(&plandb::PlanIntegration {
                id: id.into(),
                name: "Stripe".into(),
                direction: "runtime".into(),
                ..Default::default()
            })
            .unwrap();
        }
        let band = read_integration_band(&plans, &d.join("no.json"), &d.join("nc.json"));
        let pairs: Vec<(&str, &str)> =
            band.declared.iter().map(|r| (r.project.as_str(), r.id.as_str())).collect();
        assert_eq!(pairs, vec![("billing", "stripe"), ("storefront", "stripe")]);
        let _ = std::fs::remove_dir_all(&d);
    }

    /// A registered connector nobody has checked reads as NO SIGNAL, never as healthy.
    #[test]
    fn a_registered_connector_with_no_verdict_is_never_checked() {
        let d = scratch("nocheck");
        let conns = d.join("connectors.json");
        bsc_data::save_runtime_presets(&conns, &[preset("stripe")]).unwrap();
        let band = read_integration_band(&d.join("plans"), &conns, &d.join("nc.json"));
        assert_eq!(band.connectors.len(), 1);
        assert_eq!(band.connectors[0].state, bsc_data::checks::CheckState::NeverChecked);
        let _ = std::fs::remove_dir_all(&d);
    }

    /// THE CLASSIFICATION HAPPENS HERE, and this is the test that proves why. A verdict recorded
    /// against one manifest, with the manifest then edited, must reach the frontend as STALE — the
    /// frontend has no manifest and could not work this out for itself.
    #[test]
    fn a_verdict_whose_manifest_changed_arrives_as_stale_not_live() {
        let d = scratch("stale");
        let conns = d.join("connectors.json");
        let checks = d.join("checks.json");
        let original = preset("stripe");
        bsc_data::save_runtime_presets(&conns, std::slice::from_ref(&original)).unwrap();
        bsc_data::checks::record_check(
            &checks,
            bsc_data::checks::ConnectorCheck {
                id: "stripe".into(),
                at: 1,
                live: true,
                authenticated: false,
                resources: vec![],
                error: None,
                manifest_fingerprint: bsc_data::checks::manifest_fingerprint(&original),
            },
        )
        .unwrap();
        // Unedited: the green verdict stands.
        let band = read_integration_band(&d.join("plans"), &conns, &checks);
        assert_eq!(band.connectors[0].state, bsc_data::checks::CheckState::Live);

        // Edited: the SAME stored verdict must now read stale.
        let mut edited = original;
        edited.base_url = Some("https://elsewhere.test".into());
        bsc_data::save_runtime_presets(&conns, &[edited]).unwrap();
        let band = read_integration_band(&d.join("plans"), &conns, &checks);
        assert_eq!(
            band.connectors[0].state,
            bsc_data::checks::CheckState::Stale,
            "a manifest edit must not inherit the green light",
        );
        let _ = std::fs::remove_dir_all(&d);
    }

    /// A failure's reason travels; a STALE one's does not, because it describes a manifest that is no
    /// longer registered and would explain the wrong thing.
    #[test]
    fn only_a_live_failure_carries_its_reason() {
        let d = scratch("reason");
        let conns = d.join("connectors.json");
        let checks = d.join("checks.json");
        let p = preset("stripe");
        bsc_data::save_runtime_presets(&conns, std::slice::from_ref(&p)).unwrap();
        bsc_data::checks::record_check(
            &checks,
            bsc_data::checks::ConnectorCheck {
                id: "stripe".into(),
                at: 1,
                live: false,
                authenticated: false,
                resources: vec![],
                error: Some("404 on /invoices".into()),
                manifest_fingerprint: bsc_data::checks::manifest_fingerprint(&p),
            },
        )
        .unwrap();
        let band = read_integration_band(&d.join("plans"), &conns, &checks);
        assert_eq!(band.connectors[0].state, bsc_data::checks::CheckState::Failing);
        assert_eq!(band.connectors[0].error.as_deref(), Some("404 on /invoices"));

        let mut edited = p;
        edited.base_url = Some("https://elsewhere.test".into());
        bsc_data::save_runtime_presets(&conns, &[edited]).unwrap();
        let band = read_integration_band(&d.join("plans"), &conns, &checks);
        assert_eq!(band.connectors[0].state, bsc_data::checks::CheckState::Stale);
        assert_eq!(band.connectors[0].error, None, "a stale reason explains the wrong manifest");
        let _ = std::fs::remove_dir_all(&d);
    }

    /// An unreadable plan store is carried through, not dropped at this boundary — a short list must
    /// never reach the graph looking complete.
    #[test]
    fn an_unreadable_plan_store_is_reported_through_to_the_band() {
        let d = scratch("unreadable");
        let plans = d.join("plans");
        std::fs::create_dir_all(&plans).unwrap();
        std::fs::write(plans.join("corrupt.db"), b"not sqlite at all").unwrap();
        let band = read_integration_band(&plans, &d.join("no.json"), &d.join("nc.json"));
        assert_eq!(band.unreadable, vec!["corrupt".to_string()]);
        let _ = std::fs::remove_dir_all(&d);
    }

    fn preset(id: &str) -> bsc_data::RuntimePreset {
        bsc_data::RuntimePreset {
            id: id.into(),
            label: id.into(),
            category: String::new(),
            base_url: Some("https://api.test".into()),
            auth: "token".into(),
            oauth: None,
            resources: vec![bsc_data::RuntimeResource {
                name: "things".into(),
                path: "things".into(),
                array_key: None,
            }],
        }
    }
}
