// Share & import component kits (#2305 slice 1c) — the Design Studio's distribution surface. IMPORT a
// kit from a gist URL / share code, or SHARE the active kit as a no-account copy-paste code and (when
// signed in to GitHub) a one-click public gist. Rides the typed `component-kit` gist envelope (lib/
// kitGist.ts); the store's `importKit` lands the result as a collision-safe user kit.
import { useState } from "react";
import { useAppStore } from "@/store";
import { ModalScrim } from "@/shared/ui/overlay/ModalScrim";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import { Button } from "@/shared/ui/controls/Button";
import { IconButton } from "@/shared/ui/controls/IconButton";
import { SegmentedControl } from "@/shared/ui/controls/SegmentedControl";
import { InlineError } from "@/shared/ui/feedback/InlineError";
import { Code } from "@/shared/ui/data/Code";
import type { ComponentRecord, Kit } from "./lib/model";
import { importKitFromGist, kitFromCode, kitShareCode, publishKitToGist } from "./lib/kitGist";

interface Props {
  /** The active kit (offered for Share); null hides the Share tab's target. */
  kit: Kit | null;
  /** The active kit's components (what Share publishes). */
  components: ComponentRecord[];
  onClose: () => void;
  /** Called with the landed (possibly re-id'd) kit after a successful import. */
  onImported: (kit: Kit) => void;
}

export function KitShareModal({ kit, components, onClose, onImported }: Props) {
  const token = useAppStore((s) => s.githubToken);
  const importKit = useAppStore((s) => s.importKit);
  const [tab, setTab] = useState<"import" | "share">(kit ? "share" : "import");
  const [ref, setRef] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [publishedUrl, setPublishedUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const doImport = async () => {
    const text = ref.trim();
    if (!text || busy) return;
    setBusy(true); setError(null);
    // A gist URL / id → fetch it; anything else is treated as a copy-paste share code.
    const res = /gist|github\.com|^[0-9a-f]{8,}$/i.test(text) ? await importKitFromGist(text, token) : kitFromCode(text);
    setBusy(false);
    if (!res.ok) { setError(res.error); return; }
    onImported(importKit(res.kit, res.components));
    onClose();
  };

  const code = kit ? kitShareCode(kit, components) : "";
  const copy = () => { void navigator.clipboard?.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 1400); };

  const publish = async () => {
    if (!kit || busy) return;
    setBusy(true); setError(null); setPublishedUrl(null);
    const res = await publishKitToGist(token, kit, components, { public: true });
    setBusy(false);
    if (!res.ok) { setError(res.error); return; }
    setPublishedUrl(res.url);
  };

  return (
    <ModalScrim onDismiss={onClose} blur style={{ padding: 36 }}>
      <Box style={{ width: 480, maxWidth: "92vw", background: "var(--bg-elev, var(--bg-soft))", border: "1px solid var(--border)", borderRadius: 12, overflow: "hidden", boxShadow: "0 24px 70px rgba(0,0,0,.5)" }}>
        <Box style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "13px 16px", borderBottom: "1px solid var(--border-soft, var(--border))" }}>
          <Text weight={600} size={14}>Share &amp; import kits</Text>
          <IconButton onClick={onClose} title="Close" aria-label="Close" />
        </Box>

        <Box style={{ padding: 16 }}>
          <SegmentedControl label="" options={[
            { label: "↓ Import", on: tab === "import", onClick: () => { setTab("import"); setError(null); } },
            { label: "↑ Share", on: tab === "share", onClick: () => { setTab("share"); setError(null); } },
          ]} />

          {tab === "import" ? (
            <Box style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 10 }}>
              <Text size={12} tone="muted" style={{ lineHeight: 1.5 }}>Paste a <b style={{ color: "var(--fg)" }}>gist URL</b> or a <b style={{ color: "var(--fg)" }}>share code</b>. A kit is a single portable file — no account needed to import.</Text>
              <Box style={{ display: "flex", alignItems: "center", height: 34, padding: "0 11px", background: "var(--bg-soft)", border: "1px solid var(--border)", borderRadius: 8 }}>
                {/* eslint-disable-next-line no-restricted-syntax -- bespoke bare paste box */}
                <input value={ref} onChange={(e) => setRef(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void doImport(); }} placeholder="https://gist.github.com/…  or a share code" aria-label="Kit gist URL or share code" style={{ flex: 1, background: "none", border: "none", color: "var(--fg)", fontSize: 12.5, fontFamily: "inherit", outline: "none" }} />
              </Box>
              {error && <InlineError>{error}</InlineError>}
              <Box style={{ display: "flex", justifyContent: "flex-end" }}>
                <Button variant="primary" size="sm" onClick={doImport} disabled={busy || !ref.trim()}>{busy ? "importing…" : "Import kit"}</Button>
              </Box>
            </Box>
          ) : (
            <Box style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 12 }}>
              {!kit ? (
                <Text size={12} tone="dim">Select a kit to share it.</Text>
              ) : (
                <>
                  <Text size={12} tone="muted" style={{ lineHeight: 1.5 }}>Sharing <b style={{ color: "var(--fg)" }}>{kit.name}</b> ({components.length} components).</Text>
                  <Box>
                    <Box style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 5 }}>
                      <Text mono size="xxs" tone="dim" style={{ letterSpacing: ".06em", textTransform: "uppercase" }}>Share code (no account)</Text>
                      <Button variant="ghost" size="sm" onClick={copy}>{copied ? "copied ✓" : "copy"}</Button>
                    </Box>
                    <Code maxHeight={90} wrap>{code}</Code>
                  </Box>
                  <Box style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, paddingTop: 4, borderTop: "1px solid var(--border-soft, var(--border))" }}>
                    <Text size={11.5} tone="muted">Publish as a free public GitHub gist{token ? "" : " (sign in to GitHub first)"}.</Text>
                    <Button variant="primary" size="sm" onClick={publish} disabled={busy || !token}>{busy ? "publishing…" : "Publish to gist ↗"}</Button>
                  </Box>
                  {publishedUrl && (
                    <Box style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 11px", borderRadius: 8, background: "color-mix(in oklch, var(--success), transparent 90%)", border: "1px solid color-mix(in oklch, var(--success), transparent 70%)" }}>
                      <Text size={11.5} tone="success">Published →</Text>
                      <Text mono size={11} tone="accent" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{publishedUrl}</Text>
                      <Box style={{ flex: 1 }} />
                      <Button variant="ghost" size="sm" onClick={() => { void navigator.clipboard?.writeText(publishedUrl); }}>copy url</Button>
                    </Box>
                  )}
                  {error && <InlineError>{error}</InlineError>}
                </>
              )}
            </Box>
          )}
        </Box>
      </Box>
    </ModalScrim>
  );
}
