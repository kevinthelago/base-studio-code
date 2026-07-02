// usePlanSectionPoll (#1474) — the planner's 2-second plan.db + section-file poll, extracted
// verbatim from Planning.tsx. While the planning page is visible it reflects every DB-owned
// artifact (issues / features / repos / fleet / deploy / deps / mcp / blueprint) plus the
// `read_plan_sections` file poll into the store, with per-artifact change-guards so an unchanged
// blob never churns state. Side-effect only — owns its guard refs internally and returns nothing.

import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { bscJson, bscWrite } from "@/shared/lib/core/bsc";
import { useAppStore, type AutomationSuggestion } from "@/store";
import { type PlanIssue } from "../issues/planIssues";
import { type PlanFeature } from "../issues/featureList";
import { FLEET_KEY } from "../fleet/planFleet";
import { FEATURES_KEY, canonicalTopicKey } from "../stages/planTopics";
import { parseDependencyManifest, DEPENDENCIES_KEY } from "../issues/dependencies";
import { AUTHORING_BLUEPRINT_ID } from "../stages/blueprints";
import { parseDeployConfigTag } from "../lib/deployConfig";
import { applyMcpAssign } from "../lib/planExtensions";
import { catalogLink } from "@/features/mcp/lib/mcpInstall";
import { coerceBlueprint } from "../blueprints/blueprintShare";
import { scriptDocRelpath } from "./planningSession";
import { sanitizeProjectKey } from "@/shared/lib/core/projectPaths";
import { wantsSandboxLaunch } from "./plannerSandbox";
import { plannerLaunchConfig } from "./plannerLaunch";

/** A per-repo startup script row from plan.db (`bsc plan startup`, #2010). */
interface StartupScriptRow { repo: string; mode: "dev" | "triage"; path: string }

interface SectionPollDeps {
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

export function usePlanSectionPoll({ visible, projectId: effectiveProjectId, publishRepos, enqueueMcpDownloads, planningDir }: SectionPollDeps): void {
  // Per-artifact change-guards: skip re-applying an unchanged DB blob each 2s tick. `depsImportedRef`
  // gates the one-time legacy dependencies.json import; `mcpAppliedRef` the per-name MCP resolve;
  // `lastBpJsonRef` the authored-blueprint coercion (reset on project switch).
  const deployAppliedRef = useRef<Record<string, string>>({});
  const depsAppliedRef = useRef<Record<string, string>>({});
  const depsImportedRef = useRef<Set<string>>(new Set());
  const mcpAppliedRef = useRef<Set<string>>(new Set());
  const autoAppliedRef = useRef<Record<string, string>>({});
  const startupAppliedRef = useRef<Record<string, string>>({});
  const lastBpJsonRef = useRef<string>("");

  // Poll the section files Claude writes every 2 seconds while visible. Each
  // documented topic is its own file ({key}.md / phases.json / _skipped.md);
  // read_plan_sections returns them all dynamically, keyed by file stem. Writing
  // to the store drives the derived `sections`/`skipped` — confirmed sections
  // stay frozen. This file poll is more reliable than the raw <plan_update>
  // stream and is what surfaces brand-new topics as their own cards.
  useEffect(() => {
    if (!visible) return;
    lastBpJsonRef.current = ""; // reset the blueprint.json change-guard on project switch

    const poll = async () => {
      try {
        const store = useAppStore.getState();
        const saved = store.planSections[effectiveProjectId] ?? {};
        const confirmed = new Set(store.planConfirmedSections[effectiveProjectId] ?? []);

        // Sandbox (#1988): a planner launched INSIDE the WSL2 cage writes plan.db + section files into
        // the distro hub. Mirror the in-distro plan.db back to the host FIRST, so the DB-owned reads
        // below (issues/features/fleet/deploy/deps/mcp/automations/startup/blueprint) — and publish +
        // fleet launch, which read the host plan.db — reflect the sandboxed planner's work. Sections
        // (file-based) are read from the distro directly further down.
        const sandboxed = wantsSandboxLaunch(store.sandboxConsoles, plannerLaunchConfig(store, {}).providerId, planningDir);
        if (sandboxed) {
          await invoke("sync_sandbox_plan_db", { key: effectiveProjectId }).catch(() => { /* no in-distro db yet — ignore */ });
        }

        // Issues are owned by plan.db now (#plan-db) — the canonical store, not an issues.json
        // file. Read them straight from the DB and reflect into the "issues" section so every
        // downstream consumer (publish, structure card, grading, the mobile mirror) is unchanged.
        try {
          const dbIssues = await bscJson<PlanIssue[]>(effectiveProjectId, ["plan", "list", "--full", "--json"], []);
          const json = JSON.stringify(dbIssues ?? []);
          if (json !== (saved["issues"] ?? "")) store.setPlanSection(effectiveProjectId, "issues", json);
        } catch { /* plan.db not created until the planner adds its first issue — ignore */ }

        // Features are DB-owned too (#plan-db) — titles-first roster in plan.db, not a features.json
        // file. Reflect them into the "features" section so the Features board + gate read unchanged.
        try {
          const dbFeatures = await bscJson<PlanFeature[]>(effectiveProjectId, ["plan", "feature", "list", "--json"], []);
          const json = JSON.stringify(dbFeatures ?? []);
          if (json !== (saved[FEATURES_KEY] ?? "")) store.setPlanSection(effectiveProjectId, FEATURES_KEY, json);
        } catch { /* plan.db not created until the planner registers its first feature — ignore */ }

        // Linked repos are DB-owned too (#1012) — restore them from the hub's plan.db into the store
        // so a zustand/app-state reset can't lose the links (the store-only persistence proved fragile).
        try {
          const dbRepos = await bscJson<string[]>(effectiveProjectId, ["plan", "repo", "list", "--json"], []);
          for (const r of dbRepos ?? []) store.addProjectRepo(effectiveProjectId, r);
        } catch { /* plan.db not created until the first repo is linked — ignore */ }

        // Fleet (streams + per-stream permissions/flows + director/topology) is DB-owned too (#1018) —
        // plan.db is the SOLE fleet source (#1805): there is no fleet.json reader anymore. Reflect the
        // fleet from plan.db into the "fleet" section so the fleet sync effect (parseFleetFile →
        // setPlanFleet) reads it unchanged. `fleet get --full` returns the whole FleetPlan blob (the
        // same shape the old `plan_get_fleet` command wrapped). Guard on a non-null fleet so an empty
        // DB doesn't churn the section.
        try {
          const dbFleet = await bscJson<unknown | null>(effectiveProjectId, ["plan", "fleet", "get", "--full", "--json"], null);
          if (dbFleet) {
            const json = JSON.stringify(dbFleet);
            if (json !== (saved[FLEET_KEY] ?? "")) store.setPlanSection(effectiveProjectId, FLEET_KEY, json);
          }
        } catch { /* plan.db not created until the planner sets the fleet — ignore */ }

        // Deploy config is DB-owned (#1020) — coerce the stored blob through the same parseDeployConfigTag
        // the old <deploy_config> tag used and push it into planDeployConfig, so the `deploy` gate clears
        // from the plan. Skip an unchanged blob so we don't churn the store every tick.
        try {
          const dbDeploy = await bscJson<unknown | null>(effectiveProjectId, ["plan", "deploy", "get", "--json"], null);
          if (dbDeploy) {
            const raw = JSON.stringify(dbDeploy);
            if (raw !== deployAppliedRef.current[effectiveProjectId]) {
              deployAppliedRef.current[effectiveProjectId] = raw;
              const cfg = parseDeployConfigTag(raw, publishRepos);
              if (cfg) store.setPlanDeployConfig(effectiveProjectId, cfg);
            }
          }
        } catch { /* plan.db not created until the planner sets deploy — ignore */ }

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
              if (raw !== (saved[DEPENDENCIES_KEY] ?? "")) store.setPlanSection(effectiveProjectId, DEPENDENCIES_KEY, raw);
            }
          } else if (!depsImportedRef.current.has(effectiveProjectId)) {
            // One-time legacy import: the file content surfaced as the DEPENDENCIES section by an earlier
            // `read_plan_sections` tick. Re-serialize through the tolerant parser so a bare-array (#1111)
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

        // Automations are DB-owned (#2009) — the planner assigns them with `bsc plan automations add`
        // (replacing the <automation_assign> stream tag). Reflect the stored list into planAutomations
        // (a full replace, which the `automations` gate reads). Guard on the serialized list so an
        // unchanged set doesn't churn the store every tick.
        try {
          const dbAutos = await bscJson<AutomationSuggestion[]>(effectiveProjectId, ["plan", "automations", "list", "--json"], []);
          const raw = JSON.stringify(dbAutos ?? []);
          if (raw !== autoAppliedRef.current[effectiveProjectId]) {
            autoAppliedRef.current[effectiveProjectId] = raw;
            store.setPlanAutomations(effectiveProjectId, dbAutos ?? []);
          }
        } catch { /* plan.db not created until the planner assigns an automation — ignore */ }

        // Startup scripts are DB-owned (#2010) — the planner assigns per-repo kickoff/triage prompt
        // docs with `bsc plan startup add` (replacing the <startup_script> stream tag). Resolve each
        // `path` to a unified-store relpath and auto-assign it as that repo's dev/triage startup doc,
        // so opening the repo's console or triage pane launches with it. Guard on the serialized list.
        try {
          const dbStartup = await bscJson<StartupScriptRow[]>(effectiveProjectId, ["plan", "startup", "list", "--json"], []);
          const raw = JSON.stringify(dbStartup ?? []);
          if (raw !== startupAppliedRef.current[effectiveProjectId]) {
            startupAppliedRef.current[effectiveProjectId] = raw;
            const key = sanitizeProjectKey(effectiveProjectId);
            for (const sc of dbStartup ?? []) {
              const relpath = scriptDocRelpath(key, sc.path);
              if (sc.mode === "triage") store.setRepoTriagePromptDoc(effectiveProjectId, sc.repo, relpath);
              else                      store.setRepoStartupPromptDoc(effectiveProjectId, sc.repo, relpath);
            }
          }
        } catch { /* plan.db not created until the planner assigns a startup script — ignore */ }

        // Authored blueprint is DB-owned (#1022) — the authoring planner records it with `bsc-plan
        // blueprint set`; coerce the stored JSON into the in-progress blueprint (the same coerceBlueprint
        // the import path uses) so the authoring panes render the stages it designed. Guard on the JSON
        // changing so a 2s re-read can't clobber a live UI edit, and pin the binding to the authoring
        // lifecycle so it can't revert to default on restart (#923).
        try {
          const dbBp = await bscJson<unknown | null>(effectiveProjectId, ["plan", "blueprint", "get", "--json"], null);
          if (dbBp) {
            const raw = JSON.stringify(dbBp);
            if (raw !== lastBpJsonRef.current) {
              lastBpJsonRef.current = raw;
              try {
                const parsed = coerceBlueprint(dbBp, { allowEmptySections: true });
                if (parsed) {
                  store.setAuthoredBlueprint(effectiveProjectId, parsed);
                  if (store.projectBlueprintId[effectiveProjectId] !== AUTHORING_BLUEPRINT_ID) {
                    store.setProjectBlueprintId(effectiveProjectId, AUTHORING_BLUEPRINT_ID);
                  }
                }
              } catch { /* mid-write / invalid shape — ignore, the planner re-writes */ }
            }
          }
        } catch { /* plan.db not created until the planner sets the blueprint — ignore */ }

        // Section files: a planner launched INSIDE the WSL2 cage (#1988) writes them into the distro
        // hub, so read from there (via `read_sandbox_plan_sections`) when this session is sandboxed
        // (`sandboxed`, computed above) — else the host hub. Fall back to the host read if the distro
        // read is empty (e.g. the relocation fell back to host at launch), so sections never vanish.
        let result: Record<string, string>;
        if (sandboxed) {
          result = await invoke<Record<string, string>>("read_sandbox_plan_sections", { key: effectiveProjectId })
            .catch(() => ({} as Record<string, string>));
          if (Object.keys(result).length === 0) {
            result = await invoke<Record<string, string>>("read_plan_sections", { projectKey: effectiveProjectId });
          }
        } else {
          result = await invoke<Record<string, string>>("read_plan_sections", { projectKey: effectiveProjectId });
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
          if (content && content !== (saved[key] ?? "") && !confirmed.has(key)) {
            store.setPlanSection(effectiveProjectId, key, content);
          }
        }
      } catch {
        // plans dir may not exist yet — ignore
      }
    };

    poll();
    const id = setInterval(poll, 2000);
    return () => clearInterval(id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, effectiveProjectId]);
}
