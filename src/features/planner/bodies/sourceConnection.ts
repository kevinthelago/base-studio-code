// sourceConnection — the per-source connection state machine for FocusedSourceBody (#1637).
//
// Split out of FocusedSourceBody.tsx: the `useSourceConnection` hook owns the per-source lifecycle
// (declared → connecting → scanning → scanned / error), the OAuth browser-flow launch + completion
// listen, the live read-only scan (with sample-shape fallback), and the secret-masking local state.
// It is the ONLY home for the invoke/listen calls that drive a source forward; the presentational
// card lives in connectorForm.tsx and the container in FocusedSourceBody.tsx.
//
// SECURITY BOUNDARY: a secret's value lives ONLY in `secrets` (local React state) and is saved to
// the OS keychain on connect — it is NEVER written into the persisted SourceConfig and never shared
// with the planning agent, which sees only a redacted handle + the discovered object inventory.

import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { safeInvoke, fireInvoke } from "@/shared/lib/core/safeInvoke";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useAppStore } from "@/store";
import {
  connector, redactedHandle, sampleScan,
  type SourceConfig, type DeclaredSource, type DiscoveredField, type PlatformScanView,
} from "../lib/sourceConfig";

export interface SourceConnection {
  /** Secret field values — LOCAL ONLY, keyed by source uid → field key. Never persisted. */
  secrets: Record<string, Record<string, string>>;
  /** Source uids whose secret field is currently revealed (un-masked). */
  revealed: Set<string>;
  /** Patch one source by uid, reading the latest config from the store (safe across timeouts). */
  patchSource: (uid: string, patch: Partial<DeclaredSource>) => void;
  /** Update a non-secret field value (persisted into the source's config). */
  setField: (uid: string, key: string, v: string) => void;
  /** Update a secret field value (local only). */
  setSecret: (uid: string, key: string, v: string) => void;
  /** Toggle the reveal state of a source's secret field. */
  toggleReveal: (uid: string) => void;
  /** Connect a source — OAuth flow or save-secrets-then-scan for credential connectors. */
  connect: (uid: string) => void;
  /** Reset an errored source back to declared so the user can retry. */
  retry: (uid: string) => void;
  /** Revoke a source's on-device secrets (called when the source is removed, #1194). */
  revokeSecrets: (uid: string) => void;
}

/**
 * The per-source connection state machine + secret-masking state for the Source body.
 *
 * @param pid     the project key (store + keychain scope)
 * @param cfg     the current SourceConfig (the render-time snapshot the actions close over)
 * @param persist writes a new SourceConfig back to the store
 */
export function useSourceConnection(
  pid: string,
  cfg: SourceConfig,
  persist: (next: SourceConfig) => void,
): SourceConnection {
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  // Secret field values — LOCAL ONLY, keyed by source uid → field key. Never persisted.
  const [secrets, setSecrets] = useState<Record<string, Record<string, string>>>({});

  // Patch one source by uid, reading the latest config from the store (safe across timeouts).
  const patchSource = (uid: string, patch: Partial<DeclaredSource>) => {
    const latest = useAppStore.getState().planSourceConfig[pid] ?? cfg;
    persist({ ...latest, sources: latest.sources.map((s) => (s.uid === uid ? { ...s, ...patch } : s)) });
  };

  function setField(uid: string, key: string, v: string) {
    patchSource(uid, { fields: { ...(cfg.sources.find((s) => s.uid === uid)?.fields ?? {}), [key]: v } });
  }
  function setSecret(uid: string, key: string, v: string) {
    setSecrets((p) => ({ ...p, [uid]: { ...(p[uid] ?? {}), [key]: v } }));
  }
  function toggleReveal(uid: string) {
    setRevealed((p) => { const n = new Set(p); if (n.has(uid)) n.delete(uid); else n.add(uid); return n; });
  }

  function revokeSecrets(uid: string) {
    // Revoke any on-device secrets for this source's connector fields (#1194).
    const src = cfg.sources.find((s) => s.uid === uid);
    if (src) {
      for (const f of connector(src.connectorId).spec.fields) {
        if (f.secret) fireInvoke("source_delete_secret", { project: pid, sourceUid: uid, field: f.key });
      }
    }
  }

  // Run the live read-only scan; on a non-live result or error, fall back to the sample shape so
  // the pane stays demonstrable until every connector's live transport / OAuth app is in place.
  async function runScan(uid: string, connectorId: string, fields: Record<string, string>, fallbackHandle: string) {
    try {
      const res = await invoke<{ live: boolean; instance?: string; handle?: string; objects?: { name: string; count: number; fields?: DiscoveredField[] }[]; behaviors?: { label: string }[]; platform?: PlatformScanView }>(
        "data_platform_scan",
        { connectorId, project: pid, sourceUid: uid, fields },
      );
      if (res?.live) {
        patchSource(uid, {
          status: "scanned",
          handle: res.handle || fallbackHandle,
          ...(res.instance ? { instance: res.instance } : {}),
          objects: res.objects ?? [],
          behaviors: res.behaviors ?? [],
          platform: res.platform,
        });
        return;
      }
    } catch { /* fall through to the sample shape */ }
    const scan = sampleScan(connectorId);
    patchSource(uid, { status: "scanned", objects: scan.objects, behaviors: scan.behaviors });
  }

  // OAuth connect: kick off the browser authorization-code flow, then scan once the token lands in
  // the keychain. If OAuth isn't configured (no client id) the begin call returns no URL and we
  // degrade to the sample shape so the pane still works.
  function oauthConnect(uid: string, src: DeclaredSource, c: ReturnType<typeof connector>) {
    const fallbackHandle = redactedHandle({ ...src, instance: src.instance || c.name });
    patchSource(uid, { status: "connecting" });
    void (async () => {
      let begin: { authorizeUrl?: string } | null = null;
      try {
        begin = await invoke<{ authorizeUrl: string }>("source_oauth_begin", {
          connectorId: src.connectorId, project: pid, sourceUid: uid, env: src.env ?? "production",
        });
      } catch { /* not configured / unavailable */ }
      if (!begin?.authorizeUrl) {
        patchSource(uid, { status: "scanning", secretSaved: false, handle: fallbackHandle, instance: src.instance || c.name });
        void runScan(uid, src.connectorId, { ...(src.fields ?? {}) }, fallbackHandle);
        return;
      }
      await openUrl(begin.authorizeUrl).catch(() => {});
      const unlisten = await listen<{ sourceUid: string; ok: boolean; instance?: string; realm?: string; error?: string }>(
        "source-oauth-complete",
        (ev) => {
          const p = ev.payload;
          if (p.sourceUid !== uid) return;
          unlisten();
          if (!p.ok) { patchSource(uid, { status: "error", error: p.error ?? "authorization failed" }); return; }
          // Capture non-secret instance metadata into the config (the token stays in the keychain).
          const fields = { ...(useAppStore.getState().planSourceConfig[pid]?.sources.find((s) => s.uid === uid)?.fields ?? {}) };
          if (p.instance) fields.instanceUrl = p.instance;
          if (p.realm) fields.realm = p.realm;
          const handle = redactedHandle({ ...src, instance: p.instance || c.name });
          patchSource(uid, { status: "scanning", secretSaved: true, instance: p.instance || c.name, handle, fields });
          void runScan(uid, src.connectorId, fields, handle);
        },
      );
    })();
  }

  // Connect: OAuth connectors run the browser flow; credential connectors save each secret to the
  // OS keychain (#1194) — it leaves component state for the device's secure store, never written to
  // the config or shared with the planner — then scan.
  function connect(uid: string) {
    const src = cfg.sources.find((s) => s.uid === uid);
    if (!src) return;
    const c = connector(src.connectorId);
    if (c.spec.auth === "oauth") { oauthConnect(uid, src, c); return; }

    const fallbackHandle = redactedHandle({ ...src, instance: src.instance || c.name });
    const fieldsSnapshot = { ...(src.fields ?? {}) };
    const draft = secrets[uid] ?? {};
    const saved = Object.entries(draft).filter(([, v]) => v.trim());
    const saves = saved.map(([field, value]) =>
      safeInvoke("source_save_secret", { project: pid, sourceUid: uid, field, value }, undefined)
    );

    patchSource(uid, { status: "connecting" });
    // Drop the local secret draft — it's on the device keychain now, never re-shown.
    setSecrets((p) => { const n = { ...p }; delete n[uid]; return n; });
    setRevealed((p) => { const n = new Set(p); n.delete(uid); return n; });

    void Promise.all(saves).then(() => {
      patchSource(uid, { status: "scanning", secretSaved: saved.length > 0, handle: fallbackHandle, instance: src.instance || c.name });
      void runScan(uid, src.connectorId, fieldsSnapshot, fallbackHandle);
    });
  }
  function retry(uid: string) {
    patchSource(uid, { status: "declared", error: undefined });
  }

  return { secrets, revealed, patchSource, setField, setSecret, toggleReveal, connect, retry, revokeSecrets };
}
