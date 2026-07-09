// usePlanStagePoll (#1474) — the planner's 2-second plan.db + section-file poll, extracted
// verbatim from Planning.tsx. While the planning page is visible it reflects every DB-owned
// artifact (issues / features / repos / fleet / deploy / deps / mcp / blueprint) plus the
// `read_plan_stages` file poll into the store, with per-artifact change-guards so an unchanged
// blob never churns state. Side-effect only — owns its guard refs internally and returns nothing.

import { useEffect, useRef } from "react";
import { usePoll } from "@/shared/hooks/usePoll";
import { invoke } from "@tauri-apps/api/core";
import { bscJson, bscRun, bscWrite } from "@/shared/lib/core/bsc";
import { hashString } from "@/shared/lib/core/hashString";
import { useAppStore, type AutomationSuggestion } from "@/store";
import { FLEET_KEY } from "../fleet/planFleet";
import { FEATURES_KEY, canonicalTopicKey } from "../stages/planTopics";
import { reconcileConfirmations, reconcileSkips, type ConfirmRow } from "../stages/confirmReconcile";
import { parseDependencyManifest, DEPENDENCIES_KEY } from "../issues/dependencies";
import { AUTHORING_BLUEPRINT_ID } from "../stages/blueprints";
import { parseDeployConfigTag } from "../lib/deployConfig";
import { coerceMarketConfig } from "../lib/marketConfig";
import { coerceTransformationRows } from "../lib/transformations";
import { applyMcpAssign } from "../lib/planExtensions";
import { catalogLink } from "@/features/mcp";
import { coerceBlueprint } from "../blueprints/blueprintShare";
import { scriptDocRelpath } from "./planningSession";
import { sanitizeProjectKey } from "@/shared/lib/core/projectPaths";
import { wantsSandboxLaunch } from "./plannerSandbox";
import { plannerLaunchConfig } from "./plannerLaunch";

/** A per-repo startup script row from plan.db (`bsc plan startup`, #2010). */
interface StartupScriptRow { repo: string; mode: "dev" | "triage"; path: string }

interface StagePollDeps {
  visible: boolean;
  projectId: string;
  /** Linked repos, passed to the deploy-config coercion. */
  publishRepos: string[];
  /** Queue first-party MCP servers for the download-confirmation modal. */
  enqueueMcpDownloads: (names: string[]) => void;
  /** The host hub dir — non-empty once `setup_workspaces` resolves. Drives the sandbox-read decision
   *  (#1988): a planner launched into the WSL2 cage writes its sections into the distro hub. */
  planningDir: string;
}

export function usePlanStagePoll({ visible, projectId: effectiveProjectId, publishRepos, enqueueMcpDownloads, planningDir }: StagePollDeps): void {
  // Per-artifact change-guards: skip re-applying an unchanged DB blob each 2s tick. `depsImportedRef`
  // gates the one-time legacy dependencies.json import; `mcpAppliedRef` the per-name MCP resolve;
  // `lastBpJsonRef` the authored-blueprint coercion (reset on project switch).
  const deployAppliedRef = useRef<Record<string, string>>({});
  const marketAppliedRef = useRef<Record<string, string>>({});
  const transformationsAppliedRef = useRef<Record<string, string>>({});
  const depsAppliedRef = useRef<Record<string, string>>({});
  const depsImportedRef = useRef<Set<string>>(new Set());
  const mcpAppliedRef = useRef<Set<string>>(new Set());
  const autoAppliedRef = useRef<Record<string, string>>({});
  const startupAppliedRef = useRef<Record<string, string>>({});
  const lastBpJsonRef = useRef<string>("");
  // Projects whose pre-#2256 app-state confirmations have already been forward-migrated into plan.db
  // (one-time per project, so the migration doesn't re-run every 2s tick).
  const confirmMigratedRef = useRef<Set<string>>(new Set());
  // The same one-time-per-project guard for the pre-#2267 app-state skips forward-migration.
  const skipMigratedRef = useRef<Set<string>>(new Set());

  // Poll the section files Claude writes every 2 seconds while visible. Each
  // documented topic is its own file ({key}.md / phases.json / _skipped.md);
  // read_plan_stages returns them all dynamically, keyed by file stem. Writing
  // to the store drives the derived `sections`/`skipped` — confirmed sections
  // stay frozen. This file poll is more reliable than the raw <plan_update>
  // stream and is what surfaces brand-new topics as their own cards.
  // Reset the blueprint.json change-guard on a project switch, before the first poll below.
  useEffect(() => { if (visible) lastBpJsonRef.current = ""; }, [visible, effectiveProjectId]);

  usePoll(() => {
    if (!visible) return;
    const poll = async () => {
      try {
        const store = useAppStore.getState();
        const saved = store.planStages[effectiveProjectId] ?? {};

        // Sandbox (#1988): a planner launched INSIDE the WSL2 cage writes plan.db + section files into
        // the distro hub. Mirror the in-distro plan.db back to the host FIRST, so the DB-owned reads
        // below (issues/features/fleet/deploy/deps/mcp/automations/startup/blueprint) — and publish +
        // fleet launch, which read the host plan.db — reflect the sandboxed planner's work. Sections
        // (file-based) are read from the distro directly further down.
        const sandboxed = wantsSandboxLaunch(store.sandboxConsoles, plannerLaunchConfig(store, {}).providerId, planningDir);
        if (sandboxed) {
          await invoke("sync_sandbox_plan_db", { key: effectiveProjectId }).catch(() => { /* no in-distro db yet — ignore */ });
        }

        // Every DB-owned artifact is reflected the SAME way: read it from plan.db, stringify it, and —
        // only when the serialized blob changed since the last tick — apply it to the store. The
        // per-artifact specifics (its `bsc plan` subcommand, its change-guard, its coercion, and its
        // store setter) live as one row per artifact in the descriptor TABLE below; `reflectArtifact`
        // runs one row. Semantics are identical to the former hand-rolled per-artifact blocks: the
        // stringify-compare change-guard, the silent "not created yet" try/catch, the same fetch/
        // stringify fallbacks, coercers, setters, and order. Three artifacts (repos / deps / mcp) don't
        // fit the shape (loop / one-time legacy import / per-name set) and stay as bespoke blocks below.
        interface ArtifactDescriptor {
          /** `bsc plan …` args producing the artifact's JSON. */
          args: string[];
          /** bscJson fallback (empty output / bridge absent → this). */
          fetchFallback: unknown;
          /** Skip the whole reflect on a null/empty read (the artifacts the old code wrapped in `if (db)`). */
          requireTruthy?: boolean;
          /** `db ?? this` before JSON.stringify (the non-`requireTruthy` artifacts' `?? []`). */
          stringifyFallback?: unknown;
          /** Current guard value — a per-project applied-ref, or the store-owned section blob. */
          applied: () => string | undefined;
          /** Record the applied guard value (no-op when the store write is itself the record). */
          setApplied: (raw: string) => void;
          /** Reflect the read into the store. */
          apply: (db: unknown, raw: string) => void;
        }
        const reflectArtifact = async (d: ArtifactDescriptor): Promise<void> => {
          try {
            const db = await bscJson<unknown>(effectiveProjectId, d.args, d.fetchFallback);
            if (d.requireTruthy && !db) return;
            const raw = JSON.stringify(db ?? d.stringifyFallback);
            if (raw !== d.applied()) {
              d.setApplied(raw);
              d.apply(db, raw);
            }
          } catch { /* plan.db not created yet — ignore */ }
        };
        // One row per DB-owned artifact, in the same order the old blocks ran. (The bespoke shapes —
        // repos / deps / mcp — run just after as their own blocks; they're order-independent of these.)
        const ARTIFACTS: ArtifactDescriptor[] = [
          // Issues (#plan-db) → the "issues" section, so publish / structure card / grading / mobile mirror read unchanged.
          {
            args: ["plan", "list", "--full", "--json"], fetchFallback: [], stringifyFallback: [],
            applied: () => saved["issues"] ?? "", setApplied: () => undefined,
            apply: (_db, raw) => store.setPlanStage(effectiveProjectId, "issues", raw),
          },
          // Features (#plan-db) → the "features" section (board + gate).
          {
            args: ["plan", "feature", "list", "--json"], fetchFallback: [], stringifyFallback: [],
            applied: () => saved[FEATURES_KEY] ?? "", setApplied: () => undefined,
            apply: (_db, raw) => store.setPlanStage(effectiveProjectId, FEATURES_KEY, raw),
          },
          // Fleet (#1018/#1805, plan.db is the SOLE fleet source) → the "fleet" section (parseFleetFile → setPlanFleet).
          {
            args: ["plan", "fleet", "get", "--full", "--json"], fetchFallback: null, requireTruthy: true,
            applied: () => saved[FLEET_KEY] ?? "", setApplied: () => undefined,
            apply: (_db, raw) => store.setPlanStage(effectiveProjectId, FLEET_KEY, raw),
          },
          // Deploy config (#1020) → coerced through parseDeployConfigTag into planDeployConfig (the `deploy` gate).
          {
            args: ["plan", "deploy", "get", "--json"], fetchFallback: null, requireTruthy: true,
            applied: () => deployAppliedRef.current[effectiveProjectId],
            setApplied: (raw) => { deployAppliedRef.current[effectiveProjectId] = raw; },
            apply: (_db, raw) => {
              const cfg = parseDeployConfigTag(raw, publishRepos);
              if (cfg) store.setPlanDeployConfig(effectiveProjectId, cfg);
            },
          },
          // Market assessment (#2430) → coerced into planMarketConfig (the `marketDefined` gate + Market body).
          {
            args: ["plan", "market", "get", "--json"], fetchFallback: null, requireTruthy: true,
            applied: () => marketAppliedRef.current[effectiveProjectId],
            setApplied: (raw) => { marketAppliedRef.current[effectiveProjectId] = raw; },
            apply: (db) => {
              const cfg = coerceMarketConfig(db);
              if (cfg) store.setPlanMarketConfig(effectiveProjectId, cfg);
            },
          },
          // Transformations (#2509) → coerced rows into planTransformations (the bottom-up confirm queue + gate).
          {
            args: ["plan", "transformation", "list", "--json"], fetchFallback: [], stringifyFallback: [],
            applied: () => transformationsAppliedRef.current[effectiveProjectId],
            setApplied: (raw) => { transformationsAppliedRef.current[effectiveProjectId] = raw; },
            apply: (db) => store.setPlanTransformations(effectiveProjectId, coerceTransformationRows(db)),
          },
          // Automations (#2009) → full replace of planAutomations (the `automations` gate).
          {
            args: ["plan", "automations", "list", "--json"], fetchFallback: [], stringifyFallback: [],
            applied: () => autoAppliedRef.current[effectiveProjectId],
            setApplied: (raw) => { autoAppliedRef.current[effectiveProjectId] = raw; },
            apply: (db) => store.setPlanAutomations(effectiveProjectId, (db as AutomationSuggestion[] | null) ?? []),
          },
          // Startup scripts (#2010) → per-repo dev/triage startup prompt docs (each `path` resolved to a unified-store relpath).
          {
            args: ["plan", "startup", "list", "--json"], fetchFallback: [], stringifyFallback: [],
            applied: () => startupAppliedRef.current[effectiveProjectId],
            setApplied: (raw) => { startupAppliedRef.current[effectiveProjectId] = raw; },
            apply: (db) => {
              const key = sanitizeProjectKey(effectiveProjectId);
              for (const sc of (db as StartupScriptRow[] | null) ?? []) {
                const relpath = scriptDocRelpath(key, sc.path);
                if (sc.mode === "triage") store.setRepoTriagePromptDoc(effectiveProjectId, sc.repo, relpath);
                else                      store.setRepoStartupPromptDoc(effectiveProjectId, sc.repo, relpath);
              }
            },
          },
          // Authored blueprint (#1022/#923) → coerced into the in-progress blueprint, binding pinned to the
          // authoring lifecycle. Guard is the module-lifetime lastBpJsonRef (reset on project switch above).
          {
            args: ["plan", "blueprint", "get", "--json"], fetchFallback: null, requireTruthy: true,
            applied: () => lastBpJsonRef.current,
            setApplied: (raw) => { lastBpJsonRef.current = raw; },
            apply: (db) => {
              try {
                const parsed = coerceBlueprint(db, { allowEmptySections: true });
                if (parsed) {
                  store.setAuthoredBlueprint(effectiveProjectId, parsed);
                  if (store.projectBlueprintId[effectiveProjectId] !== AUTHORING_BLUEPRINT_ID) {
                    store.setProjectBlueprintId(effectiveProjectId, AUTHORING_BLUEPRINT_ID);
                  }
                }
              } catch { /* mid-write / invalid shape — ignore, the planner re-writes */ }
            },
          },
        ];
        for (const d of ARTIFACTS) await reflectArtifact(d);

        // Linked repos are DB-owned too (#1012) — restore them from the hub's plan.db into the store
        // so a zustand/app-state reset can't lose the links (the store-only persistence proved fragile).
        try {
          const dbRepos = await bscJson<string[]>(effectiveProjectId, ["plan", "repo", "list", "--json"], []);
          for (const r of dbRepos ?? []) store.addProjectRepo(effectiveProjectId, r);
        } catch { /* plan.db not created until the first repo is linked — ignore */ }

        // Dependency manifest is DB-owned (#1191) — the planner records it with `bsc-plan deps set`
        // (was a raw `dependencies.json`). Reflect the stored blob into the DEPENDENCIES section so the
        // gate, DeployView, worker scope, and publish all read it from plan.db unchanged. When the DB is
        // still empty but a legacy `dependencies.json` exists in the section store, import it ONCE
        // (no data loss) so pre-#1191 projects migrate transparently; after that the DB is authoritative.
        try {
          const dbDeps = await bscJson<unknown | null>(effectiveProjectId, ["plan", "deps", "get", "--json"], null);
          if (dbDeps) {
            const raw = JSON.stringify(dbDeps);
            if (raw !== depsAppliedRef.current[effectiveProjectId]) {
              depsAppliedRef.current[effectiveProjectId] = raw;
              if (raw !== (saved[DEPENDENCIES_KEY] ?? "")) store.setPlanStage(effectiveProjectId, DEPENDENCIES_KEY, raw);
            }
          } else if (!depsImportedRef.current.has(effectiveProjectId)) {
            // One-time legacy import: the file content surfaced as the DEPENDENCIES section by an earlier
            // `read_plan_stages` tick. Re-serialize through the tolerant parser so a bare-array (#1111)
            // file is normalized to the full manifest shape before it lands in plan.db.
            const legacy = saved[DEPENDENCIES_KEY] ?? "";
            const manifest = parseDependencyManifest(legacy);
            if (manifest.dependencies.length || Object.keys(manifest.registries).length) {
              depsImportedRef.current.add(effectiveProjectId);
              await bscWrite(effectiveProjectId, ["plan", "deps", "set"], manifest);
            }
          }
        } catch { /* plan.db not created until the planner sets deps — ignore */ }

        // MCP assignments are DB-owned (#1021) — resolve each assigned catalog name into the MCP-servers
        // store (idempotent). First-party servers are queued for the download-confirmation modal
        // (#1055) instead of cloned silently. The applied-set guards against re-applying the same name
        // every 2s tick (and the modal's seen-set guards against re-prompting).
        try {
          const dbMcp = await bscJson<string[]>(effectiveProjectId, ["plan", "mcp", "list", "--json"], []);
          const toDownload: string[] = [];
          for (const name of dbMcp ?? []) {
            const key = `${effectiveProjectId}::${name.toLowerCase()}`;
            if (mcpAppliedRef.current.has(key)) continue;
            mcpAppliedRef.current.add(key);
            applyMcpAssign(store, name, effectiveProjectId, store.bscBaseDir);
            if (catalogLink(name)) toDownload.push(name);
          }
          if (toDownload.length) void enqueueMcpDownloads(toDownload);
        } catch { /* plan.db not created until the planner assigns an MCP server — ignore */ }

        // Section files: a planner launched INSIDE the WSL2 cage (#1988) writes them into the distro
        // hub, so read from there (via `read_sandbox_plan_stages`) when this session is sandboxed
        // (`sandboxed`, computed above) — else the host hub. Fall back to the host read if the distro
        // read is empty (e.g. the relocation fell back to host at launch), so sections never vanish.
        let result: Record<string, string>;
        if (sandboxed) {
          result = await invoke<Record<string, string>>("read_sandbox_plan_stages", { key: effectiveProjectId })
            .catch(() => ({} as Record<string, string>));
          if (Object.keys(result).length === 0) {
            result = await invoke<Record<string, string>>("read_plan_stages", { projectKey: effectiveProjectId });
          }
        } else {
          result = await invoke<Record<string, string>>("read_plan_stages", { projectKey: effectiveProjectId });
        }
        const entries = Object.entries(result);

        for (const [rawKey, content] of entries) {
          // Canonicalize the file stem (e.g. "Tech stack" → "stack") so a title-named file
          // still satisfies the gate (#…).
          const key = canonicalTopicKey(rawKey);
          if (key === "issues" || key === FEATURES_KEY || key === FLEET_KEY || key === "blueprint") continue; // DB-owned (#plan-db/#1018/#1022) — sourced from plan.db above, not a file
          // Dependencies are DB-owned (#1191): once plan.db has supplied the manifest, the DB blob wins
          // over any lingering legacy `dependencies.json`. Until then, let the file through so the
          // one-time legacy import (above) can read it.
          if (key === DEPENDENCIES_KEY && depsAppliedRef.current[effectiveProjectId]) continue;
          // A confirmed stage's content is NO LONGER frozen (#2256): let a changed section through so
          // the confirm-reconcile below can detect the change and reset just that one stage.
          if (content && content !== (saved[key] ?? "")) {
            store.setPlanStage(effectiveProjectId, key, content);
          }
        }

        // Stage confirmations (#2256) — plan.db is the durable store. Rehydrate the confirmed set on
        // revisit, RESET just the stages whose content changed since they were confirmed (fingerprint
        // mismatch), and forward-migrate any pre-#2256 app-state-only confirmations into plan.db once.
        // Runs AFTER all content writes above so the live fingerprints reflect this tick's sections.
        try {
          const rows = await bscJson<ConfirmRow[]>(effectiveProjectId, ["plan", "confirm", "list", "--json"], []);
          const fresh = useAppStore.getState();
          const liveSections = fresh.planStages[effectiveProjectId] ?? {};
          const plan = reconcileConfirmations(
            rows, liveSections,
            new Set(fresh.planConfirmedStages[effectiveProjectId] ?? []),
            confirmMigratedRef.current.has(effectiveProjectId),
          );
          for (const k of plan.rehydrate) fresh.markStageConfirmedLocal(effectiveProjectId, k);
          for (const k of plan.reset) fresh.unconfirmPlanStage(effectiveProjectId, k);
          if (plan.migrate.length) {
            confirmMigratedRef.current.add(effectiveProjectId);
            for (const k of plan.migrate) {
              await bscRun(effectiveProjectId, ["plan", "confirm", "add", k, hashString(liveSections[k] ?? "")]);
            }
          }
        } catch { /* plan.db not created yet — ignore */ }

        // Skipped stages (#2267) — same durability as confirmations, minus the fingerprint/reset (a
        // skip is a plain decision, not content-based). Rehydrate the skipped set on revisit and
        // forward-migrate any pre-#2267 app-state-only skips into plan.db once.
        try {
          const rows = await bscJson<string[]>(effectiveProjectId, ["plan", "skip", "list", "--json"], []);
          const fresh = useAppStore.getState();
          const plan = reconcileSkips(
            rows,
            new Set(fresh.planSkippedStages[effectiveProjectId] ?? []),
            skipMigratedRef.current.has(effectiveProjectId),
          );
          for (const k of plan.rehydrate) fresh.markStageSkippedLocal(effectiveProjectId, k);
          if (plan.migrate.length) {
            skipMigratedRef.current.add(effectiveProjectId);
            for (const k of plan.migrate) await bscRun(effectiveProjectId, ["plan", "skip", "add", k]);
          }
        } catch { /* plan.db not created yet — ignore */ }
      } catch {
        // plans dir may not exist yet — ignore
      }
    };
    return poll();
  }, 2000, [visible, effectiveProjectId]);
}
