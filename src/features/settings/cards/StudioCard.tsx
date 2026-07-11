import { useCallback, useEffect, useState } from "react";
import { Card } from "@/shared/ui/data/Card";
import { Banner } from "@/shared/ui/feedback/Banner";
import { Button } from "@/shared/ui/controls/Button";
import { Checkbox } from "@/shared/ui/controls/Checkbox";
import { TextField } from "@/shared/ui/controls/Field";
import { Row } from "@/shared/ui/layout/Row";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import { Dialog } from "@/shared/ui/overlay/Dialog";
import { useAppStore } from "@/store";
import { bsc, bscJson, bscWrite } from "@/shared/lib/core/bsc";
import { exportStudioToGist, importStudioFromGist, type Studio } from "@/features/studio";

/** One saved studio's headline metadata — the shape `bsc studio list` returns (not the full snapshot). */
type StudioMeta = { id: string; name: string; description?: string };

// Save / share **Studios** (#2889) — a Studio is a self-contained snapshot of the app's library state
// (teams · personas · components · kits · variants · themes · blueprints). This card saves the current
// state as a studio (via `bsc studio save`), lists saved ones, and uploads/imports them as GitHub gists
// (reusing the app's OAuth gist transport, like the demo/blueprint/kit shares). Mirrors DemoStateCard.
export function StudioCard() {
  const githubToken = useAppStore((s) => s.githubToken);

  const [studios, setStudios] = useState<StudioMeta[]>([]);
  const [saveName, setSaveName] = useState("");
  const [importUrl, setImportUrl] = useState("");
  const [makePublic, setMakePublic] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  // The studio awaiting an apply confirmation (null = the confirm dialog is closed).
  const [applyTarget, setApplyTarget] = useState<StudioMeta | null>(null);

  const flash = (tone: "ok" | "err", text: string) => {
    setNotice({ tone, text });
    setTimeout(() => setNotice(null), 8000);
  };

  const refresh = useCallback(async () => {
    // Store unreachable (bridge absent) → keep the current list rather than blanking it.
    try { setStudios(await bscJson<StudioMeta[]>(null, ["studio", "list"], [])); } catch { /* keep current */ }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  const doSave = async () => {
    const name = saveName.trim();
    if (!name) return;
    setBusy(true);
    try {
      await bsc(null, ["studio", "save", name]);
      setSaveName("");
      flash("ok", `Saved studio "${name}" — a snapshot of your current libraries.`);
      await refresh();
    } catch (e) {
      flash("err", `Save failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally { setBusy(false); }
  };

  const doUpload = async (id: string, name: string) => {
    setBusy(true);
    try {
      const studio = await bscJson<Studio | null>(null, ["studio", "get", id], null);
      if (!studio) { flash("err", `Studio "${name}" not found.`); return; }
      const res = await exportStudioToGist(studio, githubToken, { public: makePublic });
      if (res.ok) flash("ok", `Uploaded "${name}" as a gist: ${res.url}`);
      else flash("err", res.error);
    } finally { setBusy(false); }
  };

  // Re-hydrate every library the app boots from, so the UI reflects the freshly re-seeded stores
  // WITHOUT a restart. These are the exact store actions `useAppBoot` runs on boot — `hydrateComponents`
  // covers both components + kits; the rest cover themes, variants, kit-usage, personas, and teams (the
  // `orgs` store). (Blueprints have no boot-time hydrate action — they re-load on the next app start.)
  const rehydrateLibraries = async () => {
    const s = useAppStore.getState();
    await Promise.all([
      s.hydrateComponents(),
      s.hydrateThemes(),
      s.hydrateVariants(),
      s.hydrateKitUsage(),
      s.hydratePersonas(),
      s.hydrateOrgs(),
    ]);
  };

  // Apply a saved studio — REPLACE the current libraries with its snapshot. `saveFirst` snapshots the
  // current state as a rollback studio ("Before <name>") before applying, mirroring the blueprint-switch
  // "export first" escape hatch. Always re-hydrates + re-lists on success.
  const doApply = async (saveFirst: boolean) => {
    if (!applyTarget) return;
    const { id, name } = applyTarget;
    setApplyTarget(null);
    setBusy(true);
    try {
      if (saveFirst) await bsc(null, ["studio", "save", `Before ${name}`]);
      await bsc(null, ["studio", "apply", id]);
      await rehydrateLibraries();
      flash("ok", `Applied studio "${name}" — your libraries were re-seeded from it.${saveFirst ? " Your previous state was saved first." : ""}`);
      await refresh();
    } catch (e) {
      flash("err", `Apply failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally { setBusy(false); }
  };

  const doImport = async () => {
    const url = importUrl.trim();
    if (!url) return;
    setBusy(true);
    try {
      const res = await importStudioFromGist(url, githubToken);
      if (!res.ok) { flash("err", res.error); return; }
      await bscWrite(null, ["studio", "set"], res.studio); // write the imported studio into the store
      setImportUrl("");
      flash("ok", `Imported studio "${res.studio.name}".`);
      await refresh();
    } catch (e) {
      flash("err", `Import failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally { setBusy(false); }
  };

  return (
    <Card style={{ padding: 14, display: "flex", flexDirection: "column", gap: 12 }}>
      <Box>
        <Text as="div" mono size={12.5} weight={600} style={{ color: "var(--fg)" }}>Studios</Text>
        <Text as="p" tone="muted" size={11.5} style={{ margin: "4px 0 0", lineHeight: 1.55 }}>
          A <b>Studio</b> is a self-contained snapshot of your library state — teams, personas, components,
          kits, variants, themes &amp; blueprints — that you can save, reuse, and share. Save the current
          state, then upload it as a gist to distribute it. A snapshot never includes tokens or keys.
        </Text>
      </Box>

      <Row gap={8} wrap style={{ alignItems: "center" }}>
        <Box style={{ flex: 1, minWidth: 200 }}>
          <TextField
            value={saveName} onChange={setSaveName}
            placeholder="Name this studio…" aria-label="Studio name"
            onKeyDown={(e) => { if (e.key === "Enter") void doSave(); }}
          />
        </Box>
        <Button variant="ghost" onClick={() => void doSave()} disabled={busy || !saveName.trim()}>
          Save current state
        </Button>
      </Row>

      {studios.length > 0 && (
        <Box style={{ border: "1px solid var(--border-soft)", borderRadius: 8, overflow: "hidden" }}>
          {studios.map((s, i) => (
            <Row key={s.id} gap={8} style={{
              alignItems: "center", justifyContent: "space-between", padding: "8px 11px",
              borderTop: i === 0 ? undefined : "1px solid var(--border-soft)",
            }}>
              <Box style={{ minWidth: 0 }}>
                <Text as="div" size={11.5} weight={600} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.name}</Text>
                {s.description && <Text as="div" tone="dim" size={10.5}>{s.description}</Text>}
              </Box>
              <Row gap={6} style={{ flexShrink: 0 }}>
                <Button variant="ghost" size="sm" onClick={() => setApplyTarget(s)} disabled={busy}>
                  Apply
                </Button>
                <Button variant="ghost" size="sm" onClick={() => void doUpload(s.id, s.name)} disabled={busy || !githubToken}>
                  Upload to gist
                </Button>
              </Row>
            </Row>
          ))}
        </Box>
      )}

      <Row gap={10} wrap style={{ alignItems: "center" }}>
        <label style={{ display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer", fontSize: 11.5, color: "var(--fg-muted)" }}>
          <Checkbox checked={makePublic} onChange={() => setMakePublic((v) => !v)} aria-label="Make the gist public" />
          Public gist
        </label>
        {!githubToken && <Text as="span" tone="dim" size={11}>connect GitHub (gist scope) to upload</Text>}
      </Row>

      <Row gap={8} wrap style={{ alignItems: "center" }}>
        <Box style={{ flex: 1, minWidth: 200 }}>
          <TextField
            value={importUrl} onChange={setImportUrl}
            placeholder="…or import a studio from a gist URL or id" aria-label="Studio gist URL or id"
            onKeyDown={(e) => { if (e.key === "Enter") void doImport(); }}
          />
        </Box>
        <Button variant="ghost" onClick={() => void doImport()} disabled={busy || !importUrl.trim()}>Import from gist</Button>
      </Row>

      {notice && (
        <Banner tone={notice.tone === "ok" ? "success" : "danger"} style={{ wordBreak: "break-all" }}>
          {notice.text}
        </Banner>
      )}

      {applyTarget && (
        <Dialog
          title={`Apply "${applyTarget.name}"?`}
          onDismiss={() => setApplyTarget(null)}
          actions={
            <>
              <Button onClick={() => setApplyTarget(null)}>cancel</Button>
              <Button disabled={busy} onClick={() => void doApply(true)}>save current first, then apply</Button>
              <Button danger disabled={busy} onClick={() => void doApply(false)}>apply</Button>
            </>
          }
        >
          Applying this studio <b>replaces your current libraries</b> — teams, personas, components, kits,
          variants, themes &amp; blueprints — with the snapshot it captured. Your current libraries for
          those systems are overwritten. Choose how to proceed:
          <ul style={{ margin: "10px 0 0", paddingLeft: 18, lineHeight: 1.6 }}>
            <li><b>Save current first, then apply</b> — snapshot your current state as a new studio (a rollback point) before applying.</li>
            <li><b>Apply</b> — replace your libraries now. This can't be undone.</li>
            <li><b>Cancel</b> — leave everything as it is.</li>
          </ul>
        </Dialog>
      )}
    </Card>
  );
}
