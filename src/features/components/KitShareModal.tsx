// Share & import component kits (#2305 slice 1c) — the Design Studio's distribution surface. IMPORT a
// kit from a gist URL / share code, or SHARE the active kit as a no-account copy-paste code and (when
// signed in to GitHub) a one-click public gist. Rides the typed `component-kit` gist envelope (lib/
// kitGist.ts); the store's `importKit` lands the result as a collision-safe user kit.
import { useState } from "react";
import { useAppStore } from "@/store";
import { ModalCard } from "@/shared/ui/overlay/ModalCard";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import { Button } from "@/shared/ui/controls/Button";
import { SegmentedControl } from "@/shared/ui/controls/SegmentedControl";
import { InlineError } from "@/shared/ui/feedback/InlineError";
import { Code } from "@/shared/ui/data/Code";
import type { ComponentRecord, Kit } from "./lib/model";
import { importKitFromGist, kitFromCode, kitShareCode, publishKitToGist, type PublishedKitPin } from "./lib/kitGist";

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
  const login = useAppStore((s) => s.githubUser)?.login;
  const importKit = useAppStore((s) => s.importKit);
  const [tab, setTab] = useState<"import" | "share">(kit ? "share" : "import");
  const [ref, setRef] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [publishedUrl, setPublishedUrl] = useState<string | null>(null);
  // The published kit's store pin (#2465): id@version + sha256 — what a blueprint records to
  // reference this exact artifact. `warning` surfaces a local-store refusal (immutability).
  const [publishedPin, setPublishedPin] = useState<PublishedKitPin | null>(null);
  const [publishWarning, setPublishWarning] = useState<string | null>(null);
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
    setBusy(true); setError(null); setPublishedUrl(null); setPublishedPin(null); setPublishWarning(null);
    // `publisher` (#2465): stamp the kit-store identity + register the published bytes in the
    // local versioned kit store, so the share carries a pinnable { id, version, hash } and the
    // gist URL becomes its `source`.
    const res = await publishKitToGist(token, kit, components, { public: true, publisher: login ?? "user" });
    setBusy(false);
    if (!res.ok) { setError(res.error); return; }
    setPublishedUrl(res.url);
    setPublishedPin(res.pin ?? null);
    setPublishWarning(res.warning ?? null);
  };

  return (
    <ModalCard title="Share & import kits" onClose={onClose} width={480}>
        <Box>
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
                    <Box style={{ display: "flex", flexDirection: "column", gap: 6, padding: "8px 11px", borderRadius: 8, background: "color-mix(in oklch, var(--success), transparent 90%)", border: "1px solid color-mix(in oklch, var(--success), transparent 70%)" }}>
                      <Box style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <Text size={11.5} tone="success">Published →</Text>
                        <Text mono size={11} tone="accent" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{publishedUrl}</Text>
                        <Box style={{ flex: 1 }} />
                        <Button variant="ghost" size="sm" onClick={() => { void navigator.clipboard?.writeText(publishedUrl); }}>copy url</Button>
                      </Box>
                      {publishedPin && (
                        <Text mono size={10} tone="dim" title={publishedPin.hash} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          pin {publishedPin.id}@{publishedPin.version} · sha256 {publishedPin.hash.slice(0, 12)}… — in your kit store; blueprints can pin it
                        </Text>
                      )}
                    </Box>
                  )}
                  {publishWarning && <InlineError>{publishWarning}</InlineError>}
                  {error && <InlineError>{error}</InlineError>}
                </>
              )}
            </Box>
          )}
        </Box>
    </ModalCard>
  );
}
