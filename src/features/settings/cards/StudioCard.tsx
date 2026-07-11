import { useCallback, useEffect, useState } from "react";
import { Card } from "@/shared/ui/data/Card";
import { Banner } from "@/shared/ui/feedback/Banner";
import { Button } from "@/shared/ui/controls/Button";
import { Checkbox } from "@/shared/ui/controls/Checkbox";
import { TextField } from "@/shared/ui/controls/Field";
import { Row } from "@/shared/ui/layout/Row";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
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
              <Button variant="ghost" size="sm" onClick={() => void doUpload(s.id, s.name)} disabled={busy || !githubToken}>
                Upload to gist
              </Button>
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
    </Card>
  );
}
