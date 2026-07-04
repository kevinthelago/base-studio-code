import { useState } from "react";
import { Card } from "@/shared/ui/data/Card";
import { Banner } from "@/shared/ui/feedback/Banner";
import { Button } from "@/shared/ui/controls/Button";
import { Checkbox } from "@/shared/ui/controls/Checkbox";
import { TextField } from "@/shared/ui/controls/Field";
import { Row } from "@/shared/ui/layout/Row";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import { useAppStore } from "@/store";
import { loadDemoFromGist, saveDemoToGist } from "@/store/appStateGist";

// Load / save a "demoable" app-state as a typed gist (#2272). A demo overlays the demoable store
// slices (projects, the Glance graph, the libraries, plans/fleets, automations) so the app looks
// alive; the pre-demo state is stashed so "Clear" restores exactly what was there. The snapshot is
// allowlist-filtered — it never carries a token, key, or machine path.
export function DemoStateCard() {
  const demoActive = useAppStore((s) => s.demoActive);
  const clearDemoState = useAppStore((s) => s.clearDemoState);
  const githubToken = useAppStore((s) => s.githubToken);

  const [url, setUrl] = useState("");
  const [makePublic, setMakePublic] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

  const flash = (tone: "ok" | "err", text: string) => {
    setNotice({ tone, text });
    setTimeout(() => setNotice(null), 8000);
  };

  const doLoad = async () => {
    if (!url.trim()) return;
    setBusy(true);
    try {
      const res = await loadDemoFromGist(url.trim(), githubToken);
      if (res.ok) { flash("ok", `Loaded demo "${res.name}". Clear it to return to your own state.`); setUrl(""); }
      else flash("err", res.error);
    } finally { setBusy(false); }
  };

  const doSave = async () => {
    setBusy(true);
    try {
      const res = await saveDemoToGist(githubToken, "Demo app-state", { public: makePublic });
      if (res.ok) flash("ok", `Published this state as a gist: ${res.url}`);
      else flash("err", res.error);
    } finally { setBusy(false); }
  };

  return (
    <Card style={{ padding: 14, display: "flex", flexDirection: "column", gap: 12 }}>
      <Box>
        <Text as="div" mono size={12.5} weight={600} style={{ color: "var(--fg)" }}>Demo app-state</Text>
        <Text as="p" tone="muted" size={11.5} style={{ margin: "4px 0 0", lineHeight: 1.55 }}>
          Load a curated demo — a populated app (projects, the Glance graph, the libraries, plans &amp; fleets,
          automations) — from a gist, to see everything alive without setting it up. It overlays your real state
          and <b>Clear</b> restores it. A snapshot never includes tokens, keys, or machine paths.
        </Text>
      </Box>

      {demoActive && (
        <Banner tone="warn">
          A demo state is loaded, overlaying your real data. <b>Clear demo</b> restores what was here before.
        </Banner>
      )}

      <Row gap={8} wrap style={{ alignItems: "center" }}>
        <Box style={{ flex: 1, minWidth: 200 }}>
          <TextField
            value={url} onChange={setUrl}
            placeholder="gist URL or id…" aria-label="Demo gist URL or id"
            onKeyDown={(e) => { if (e.key === "Enter") void doLoad(); }}
          />
        </Box>
        <Button onClick={() => void doLoad()} disabled={busy || !url.trim()}>Load demo</Button>
        {demoActive && <Button variant="ghost" onClick={() => clearDemoState()} disabled={busy}>Clear demo</Button>}
      </Row>

      <Row gap={10} wrap style={{ alignItems: "center" }}>
        <Button variant="ghost" onClick={() => void doSave()} disabled={busy || !githubToken}>
          Save current state as a gist…
        </Button>
        <label style={{ display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer", fontSize: 11.5, color: "var(--fg-muted)" }}>
          <Checkbox checked={makePublic} onChange={() => setMakePublic((v) => !v)} aria-label="Make the gist public" />
          Public gist
        </label>
        {!githubToken && <Text as="span" tone="dim" size={11}>connect GitHub (gist scope) to publish</Text>}
      </Row>

      {notice && (
        <Banner tone={notice.tone === "ok" ? "success" : "danger"} style={{ wordBreak: "break-all" }}>
          {notice.text}
        </Banner>
      )}
    </Card>
  );
}
