import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Card } from "@/shared/ui/data/Card";
import { Button } from "@/shared/ui/controls/Button";
import { Checkbox } from "@/shared/ui/controls/Checkbox";
import { Row } from "@/shared/ui/layout/Row";

// Export / import the entire app configuration as one portable bundle (#2027 P3). The bundle is a
// versioned JSON of every file under the runtime config dir (~/.base-studio-code/config/) — prompts,
// taxonomies, blueprints, roles, skills, permissions, stage directives. Backed by the Rust
// `export_config_bundle` / `import_config_bundle` commands; the pickers reuse the app's rfd dialogs.
export function ConfigBundleCard() {
  const [busy, setBusy] = useState(false);
  const [replace, setReplace] = useState(false);
  const [notice, setNotice] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

  const flash = (tone: "ok" | "err", text: string) => {
    setNotice({ tone, text });
    setTimeout(() => setNotice(null), 8000);
  };

  const doExport = async () => {
    setBusy(true);
    try {
      const path = await invoke<string | null>("pick_save_file", { defaultName: "bsc-config-bundle.json" });
      if (!path) return; // cancelled
      const count = await invoke<number>("export_config_bundle", { path });
      flash("ok", `Exported ${count} config file${count === 1 ? "" : "s"} to ${path}`);
    } catch (e) {
      flash("err", `Export failed: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const doImport = async () => {
    setBusy(true);
    try {
      const path = await invoke<string | null>("pick_open_file", {});
      if (!path) return; // cancelled
      const count = await invoke<number>("import_config_bundle", { path, replace });
      flash("ok", `Imported ${count} config file${count === 1 ? "" : "s"} — restart the app to apply.`);
    } catch (e) {
      flash("err", `Import failed: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card style={{ padding: 14, display: "flex", flexDirection: "column", gap: 12 }}>
      <div>
        <div className="mono" style={{ fontSize: 12.5, color: "var(--fg)", fontWeight: 600 }}>Configuration bundle</div>
        <p style={{ color: "var(--fg-muted)", margin: "4px 0 0", fontSize: 11.5, lineHeight: 1.55 }}>
          Export the entire app configuration — prompts, taxonomies, blueprints, roles, skills, permissions,
          stage directives — as one portable, versioned file, and import one back to restore or share a setup.
          Imported changes take effect on the <b>next launch</b>.
        </p>
      </div>

      <Row gap={10} wrap>
        <Button onClick={() => void doExport()} disabled={busy}>Export…</Button>
        <Button onClick={() => void doImport()} disabled={busy}>Import…</Button>
        <label style={{ display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer", fontSize: 11.5, color: "var(--fg-muted)" }}>
          <Checkbox checked={replace} onChange={() => setReplace((v) => !v)} aria-label="Replace existing config on import" />
          Replace on import <span style={{ color: "var(--fg-dim)" }}>(else merge)</span>
        </label>
      </Row>

      {notice && (
        <div
          className="mono"
          style={{ fontSize: 11, lineHeight: 1.5, wordBreak: "break-all", color: notice.tone === "ok" ? "var(--success)" : "var(--danger)" }}
        >
          {notice.text}
        </div>
      )}
    </Card>
  );
}
