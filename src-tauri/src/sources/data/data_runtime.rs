//! Agent-authored runtime connector list (#1980, Phase 5a). The native pre-built connector
//! catalog was removed (#1976): every connector is now a runtime REST preset authored by the
//! agent via `bsc data connector`, persisted in the app-wide connectors store
//! (`~/.base-studio-code/connectors.json`, `BSC_CONNECTORS` override). This command surfaces that
//! list to the Source pane so a declared source can resolve its REAL connector name/auth/category
//! instead of the generic fallback shape.
//!
//! Runtime connectors are app-wide — there is no project arg. Read-only; the view is metadata only
//! (id/label/category/auth) — never the secret, which lives in the OS keychain (#1194).

use crate::StrErr;

/// One agent-authored runtime connector, surfaced to the Source pane (#1980). Metadata only — the
/// resources + base URL drive the scan backend (`data_platform_scan`); the pane just needs the
/// label/auth/category to render a declared source's real connector identity.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeConnectorView {
    pub id: String,
    pub label: String,
    pub category: String,
    pub auth: String,
}

/// List the agent-authored runtime REST connectors from the app-wide connectors store (#1980).
/// An absent/empty store ⇒ an empty list (no error). The list is metadata only; secrets stay in
/// the OS keychain (#1194).
#[tauri::command]
pub fn data_runtime_connectors() -> Result<Vec<RuntimeConnectorView>, String> {
    let presets = bsc_data::runtime::load_runtime_presets(&bsc_data::runtime::runtime_store_path())
        .str_err()?;
    Ok(presets
        .into_iter()
        .map(|p| RuntimeConnectorView {
            id: p.id,
            label: p.label,
            category: p.category,
            auth: p.auth,
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use bsc_data::runtime::{save_runtime_presets, RuntimePreset, RuntimeResource};

    #[test]
    fn maps_presets_from_the_store_to_views() {
        // Write a temp connectors store via BSC_CONNECTORS + a RuntimePreset, load it, assert the
        // view mapping (id/label/category/auth carried through).
        let path = std::env::temp_dir().join("bsc-rtcv-test.json");
        let _ = std::fs::remove_file(&path);
        let preset = RuntimePreset {
            id: "acme-crm".to_string(),
            label: "Acme CRM".to_string(),
            category: "crm".to_string(),
            base_url: Some("https://acme.example.com/api".to_string()),
            auth: "token".to_string(),
            oauth: None,
            resources: vec![RuntimeResource {
                name: "contacts".to_string(),
                path: "contacts".to_string(),
                array_key: Some("data".to_string()),
            }],
        };
        save_runtime_presets(&path, std::slice::from_ref(&preset)).unwrap();

        let loaded =
            bsc_data::runtime::load_runtime_presets(&path).expect("load presets from temp store");
        let views: Vec<RuntimeConnectorView> = loaded
            .into_iter()
            .map(|p| RuntimeConnectorView {
                id: p.id,
                label: p.label,
                category: p.category,
                auth: p.auth,
            })
            .collect();

        assert_eq!(views.len(), 1);
        assert_eq!(views[0].id, "acme-crm");
        assert_eq!(views[0].label, "Acme CRM");
        assert_eq!(views[0].category, "crm");
        assert_eq!(views[0].auth, "token");

        let _ = std::fs::remove_file(&path);
    }
}
