// Blueprint Author — UI KIT picker (#2465). The blueprint-WIDE kit pin, surfaced in the
// Capabilities view (the author view that already wires the blueprint's attached capabilities —
// skills/MCP per stage; the kit is the same idea one level up). A pin is a lockfile entry
// `{ id, version, hash, source? }` against the GLOBAL versioned kit store:
//   · new blueprints arrive default-pinned to the packaged `bsc/react-ui` kit;
//   · switch to any kit already in the store (one shared copy, zero downloads);
//   · import a kit by gist URL — it's added to the store FIRST, then pinned.
// The card also resolves the current pin live (store hit / fetch-verify / loud hash-mismatch
// rejection), so a broken pin is visible where it's authored.
import { useEffect, useState } from "react";
import { useAppStore } from "@/store";
import { Card } from "@/shared/ui/data/Card";
import { Chip } from "@/shared/ui/data/Chip";
import { Button } from "@/shared/ui/controls/Button";
import { InlineError } from "@/shared/ui/feedback/InlineError";
import { Stack } from "@/shared/ui/layout/Stack";
import { Row } from "@/shared/ui/layout/Row";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import type { BlueprintUiKit } from "@/features/planner/stages/blueprints";
import {
  kitRef, listStoreKits, packagedUiKitPin, resolveUiKitPin, importKitByGistUrl,
  type KitStoreManifest, type UiKitResolution,
} from "../uiKitPin";
import { Lbl, type AuthorViewProps } from "./shared";

export function UiKitPickerCard({ bp, onChange }: Pick<AuthorViewProps, "bp" | "onChange">) {
  const token = useAppStore((s) => s.githubToken);
  const pin = bp.uiKit;
  const setPin = (uiKit: BlueprintUiKit | undefined) => onChange({ ...bp, uiKit });

  const [storeKits, setStoreKits] = useState<KitStoreManifest[]>([]);
  const [resolved, setResolved] = useState<{ key: string; res: UiKitResolution } | null>(null);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);

  // The pickable store entries (component kits only — design-files bundles are sibling artifacts,
  // not a blueprint's component kit).
  useEffect(() => {
    let live = true;
    void listStoreKits().then((kits) => {
      if (live) setStoreKits(kits.filter((k) => k.kind === "component-kit"));
    });
    return () => { live = false; };
  }, [pin?.id, pin?.version]); // refresh after an import lands a new entry

  // Resolve the current pin: store lookup → fetch+verify only when missing. Keyed on the exact
  // ref so switching pins re-resolves and an already-cached kit is never re-fetched; while the
  // stored result's key doesn't match the current pin, the render derives "resolving…".
  const refKey = pin ? kitRef(pin) : "";
  useEffect(() => {
    if (!pin) return;
    let live = true;
    void resolveUiKitPin(pin, token).then((res) => {
      if (live) setResolved({ key: refKey, res });
    });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the pin's identity (refKey), not the object
  }, [refKey, token]);
  const resolve: UiKitResolution | null = pin && resolved?.key === refKey ? resolved.res : null;

  const pinStoreKit = (m: KitStoreManifest) =>
    setPin({ id: m.id, version: m.version, hash: m.sha256, ...(m.source && m.source !== "packaged" ? { source: m.source } : {}) });

  const doImport = async () => {
    const ref = url.trim();
    if (!ref || busy) return;
    setBusy(true); setImportError(null);
    const res = await importKitByGistUrl(ref, token);
    setBusy(false);
    if (!res.ok) { setImportError(res.error); return; }
    setUrl("");
    setPin(res.pin);
  };

  const packaged = packagedUiKitPin();

  return (
    <Card style={{ padding: "12px 13px" }}>
      <Lbl hint="the component kit apps built from this blueprint ship on — an immutable id@version from the global kit store">UI kit</Lbl>
      {pin ? (
        <Row gap={8} align="center" style={{ marginTop: 4, flexWrap: "wrap" }}>
          <Text as="span" mono size={12} weight={600}>{kitRef(pin)}</Text>
          <Text as="span" mono size={9.5} tone="dim" title={pin.hash}>sha256 {pin.hash.slice(0, 12)}…</Text>
          {!resolve && <Chip>resolving…</Chip>}
          {resolve?.ok && <Chip color="var(--success)">{resolve.cached ? "in store ✓" : "fetched + verified ✓"}</Chip>}
          <Box style={{ flex: 1 }} />
          <Button variant="ghost" size="sm" onClick={() => setPin(undefined)}>unpin</Button>
        </Row>
      ) : (
        <Row gap={8} align="center" style={{ marginTop: 4 }}>
          <Text as="span" size={12} tone="muted">No kit pinned — this blueprint doesn't prescribe a component kit.</Text>
          <Box style={{ flex: 1 }} />
          <Button variant="ghost" size="sm" onClick={() => setPin(packaged)}>Pin the packaged kit ({kitRef(packaged)})</Button>
        </Row>
      )}
      {resolve && !resolve.ok && <InlineError>{resolve.error}</InlineError>}

      {storeKits.some((m) => !pin || kitRef(m) !== kitRef(pin)) && (
        <Box style={{ marginTop: 10 }}>
          <Text as="div" mono size={9.5} tone="dim" style={{ letterSpacing: ".06em", textTransform: "uppercase", marginBottom: 5 }}>Switch to a stored kit</Text>
          <Box className="pipe-add">
            {storeKits.filter((m) => !pin || kitRef(m) !== kitRef(pin)).map((m) => (
              // eslint-disable-next-line no-restricted-syntax -- bespoke .chip-sug suggestion chip (not .btn family), matching the skills/MCP pickers above
              <button className="chip-sug" key={kitRef(m)} title={m.source === "packaged" ? "packaged with the app" : m.source} onClick={() => pinStoreKit(m)}>
                + {kitRef(m)}
              </button>
            ))}
          </Box>
        </Box>
      )}

      <Stack gap={6} style={{ marginTop: 10 }}>
        <Text as="div" mono size={9.5} tone="dim" style={{ letterSpacing: ".06em", textTransform: "uppercase" }}>Import a kit by gist URL</Text>
        <Row gap={8} align="center">
          <Box style={{ flex: 1, display: "flex", alignItems: "center", height: 30, padding: "0 10px", background: "var(--bg-soft)", border: "1px solid var(--border)", borderRadius: 8 }}>
            {/* eslint-disable-next-line no-restricted-syntax -- bespoke bare paste box (mirrors KitShareModal's) */}
            <input value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void doImport(); }}
              placeholder="https://gist.github.com/…" aria-label="Kit gist URL"
              style={{ flex: 1, background: "none", border: "none", color: "var(--fg)", fontSize: 12, fontFamily: "inherit", outline: "none" }} />
          </Box>
          <Button variant="ghost" size="sm" onClick={doImport} disabled={busy || !url.trim()}>{busy ? "importing…" : "Add to store + pin"}</Button>
        </Row>
        {importError && <InlineError>{importError}</InlineError>}
      </Stack>
    </Card>
  );
}
