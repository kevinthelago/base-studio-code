// Blueprint Author — SOUND KIT picker (#3372, epic #3071 phase 4). The sounds twin of
// `UiKitPickerCard` (#2465), sitting beside it in the Capabilities view: the blueprint-WIDE sound-kit
// pin, a lockfile entry `{ id, version, hash, source? }` against the GLOBAL versioned sound-kit
// release store (`bsc sound release`, #3371):
//   · new blueprints arrive default-pinned to the packaged `bsc/signal` kit;
//   · switch to any kit already in the store (one shared copy, zero downloads);
//   · import a kit by gist URL — it's added to the store FIRST, then pinned.
// The card also resolves the current pin live (store hit / fetch-verify / loud hash-mismatch
// rejection), so a broken pin is visible where it's authored — never a silent fallback.
//
// No theme row (the UI twin's #2489 block): a theme restyles a component kit's tokens, and a sound
// kit has no token contract — its cues ARE the palette.
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
import type { BlueprintSoundKit } from "@/features/planner/stages/blueprints";
import {
  soundKitRef, listStoreSoundKits, packagedSoundKitPin, resolveSoundKitPin, importSoundKitByGistUrl,
  type SoundKitStoreManifest, type SoundKitResolution,
} from "../soundKitPin";
import { Lbl, type AuthorViewProps } from "./shared";

export function SoundKitPickerCard({ bp, onChange }: Pick<AuthorViewProps, "bp" | "onChange">) {
  const token = useAppStore((s) => s.githubToken);
  const pin = bp.soundKit;
  const setPin = (soundKit: BlueprintSoundKit | undefined) => onChange({ ...bp, soundKit });

  const [storeKits, setStoreKits] = useState<SoundKitStoreManifest[]>([]);
  const [resolved, setResolved] = useState<{ key: string; res: SoundKitResolution } | null>(null);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);

  // The pickable store entries. One kind today (`sound-kit`), but filtered anyway so a future sibling
  // artifact kind can't leak into the picker the way `design-files` would have on the UI side.
  useEffect(() => {
    let live = true;
    void listStoreSoundKits().then((kits) => {
      if (live) setStoreKits(kits.filter((k) => k.kind === "sound-kit"));
    });
    return () => { live = false; };
  }, [pin?.id, pin?.version]); // refresh after an import lands a new entry

  // Resolve the current pin: store lookup → fetch+verify only when missing. Keyed on the exact ref so
  // switching pins re-resolves and an already-cached kit is never re-fetched; while the stored
  // result's key doesn't match the current pin, the render derives "resolving…".
  const refKey = pin ? soundKitRef(pin) : "";
  useEffect(() => {
    if (!pin) return;
    let live = true;
    void resolveSoundKitPin(pin, token).then((res) => {
      if (live) setResolved({ key: refKey, res });
    });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the pin's identity (refKey), not the object
  }, [refKey, token]);
  const resolve: SoundKitResolution | null = pin && resolved?.key === refKey ? resolved.res : null;

  const pinStoreKit = (m: SoundKitStoreManifest) =>
    setPin({ id: m.id, version: m.version, hash: m.sha256, ...(m.source && m.source !== "packaged" ? { source: m.source } : {}) });

  const doImport = async () => {
    const ref = url.trim();
    if (!ref || busy) return;
    setBusy(true); setImportError(null);
    const res = await importSoundKitByGistUrl(ref, token);
    setBusy(false);
    if (!res.ok) { setImportError(res.error); return; }
    setUrl("");
    setPin(res.pin);
  };

  const packaged = packagedSoundKitPin();

  return (
    <Card style={{ padding: "12px 13px" }}>
      <Lbl hint="the sound kit apps built from this blueprint ship on — an immutable id@version from the global sound-kit store">Sound kit</Lbl>
      {pin ? (
        <Row gap={8} align="center" style={{ marginTop: 4, flexWrap: "wrap" }}>
          <Text as="span" mono size={12} weight={600}>{soundKitRef(pin)}</Text>
          <Text as="span" mono size={9.5} tone="dim" title={pin.hash}>sha256 {pin.hash.slice(0, 12)}…</Text>
          {!resolve && <Chip>resolving…</Chip>}
          {resolve?.ok && <Chip color="var(--success)">{resolve.cached ? "in store ✓" : "fetched + verified ✓"}</Chip>}
          <Box style={{ flex: 1 }} />
          <Button variant="ghost" size="sm" onClick={() => setPin(undefined)}>unpin</Button>
        </Row>
      ) : (
        <Row gap={8} align="center" style={{ marginTop: 4 }}>
          <Text as="span" size={12} tone="muted">No sound kit pinned — this blueprint doesn&apos;t prescribe one.</Text>
          <Box style={{ flex: 1 }} />
          <Button variant="ghost" size="sm" onClick={() => setPin(packaged)}>Pin the packaged kit ({soundKitRef(packaged)})</Button>
        </Row>
      )}
      {resolve && !resolve.ok && <InlineError>{resolve.error}</InlineError>}

      {storeKits.some((m) => !pin || soundKitRef(m) !== soundKitRef(pin)) && (
        <Box style={{ marginTop: 10 }}>
          <Text as="div" mono size={9.5} tone="dim" style={{ letterSpacing: ".06em", textTransform: "uppercase", marginBottom: 5 }}>Switch to a stored kit</Text>
          <Box className="pipe-add">
            {storeKits.filter((m) => !pin || soundKitRef(m) !== soundKitRef(pin)).map((m) => (
              // eslint-disable-next-line no-restricted-syntax -- bespoke .chip-sug suggestion chip (not .btn family), matching the UI-kit picker above
              <button className="chip-sug" key={soundKitRef(m)} title={m.source === "packaged" ? "packaged with the app" : m.source} onClick={() => pinStoreKit(m)}>
                + {soundKitRef(m)}
              </button>
            ))}
          </Box>
        </Box>
      )}

      <Stack gap={6} style={{ marginTop: 10 }}>
        <Text as="div" mono size={9.5} tone="dim" style={{ letterSpacing: ".06em", textTransform: "uppercase" }}>Import a sound kit by gist URL</Text>
        <Row gap={8} align="center">
          <Box style={{ flex: 1, display: "flex", alignItems: "center", height: 30, padding: "0 10px", background: "var(--bg-soft)", border: "1px solid var(--border)", borderRadius: 8 }}>
            {/* eslint-disable-next-line no-restricted-syntax -- bespoke bare paste box (mirrors the UI-kit picker's) */}
            <input value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void doImport(); }}
              placeholder="https://gist.github.com/…" aria-label="Sound kit gist URL"
              style={{ flex: 1, background: "none", border: "none", color: "var(--fg)", fontSize: 12, fontFamily: "inherit", outline: "none" }} />
          </Box>
          <Button variant="ghost" size="sm" onClick={doImport} disabled={busy || !url.trim()}>{busy ? "importing…" : "Add to store + pin"}</Button>
        </Row>
        {importError && <InlineError>{importError}</InlineError>}
      </Stack>
    </Card>
  );
}
