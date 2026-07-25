// useStoreProjector (#2498) — the generic mobile projector, mounted ONCE in App beside
// useTunnelSync. Subscribes to each scoped store_state domain's sources (the SAME data the
// desktop pages read — see the #2496 inventory) and pushes the pure projections
// (lib/storeProjections.ts) through the shared domain publisher, which debounces per domain,
// dedups unchanged payloads, and stamps monotonic revs. Everything no-ops while the relay is
// down. The `plan` domain is the one exception published elsewhere: the stage/gate board only
// exists inside the live planner (usePlannerTunnelSync), so the planner pushes it.
//
// Alerts: this hook also drives the app-wide alert pipeline — coord-log alerts (agent-paused /
// worker-question / fleet-failed / fleet-landed) from the polled CoordState, and prompt-waiting
// from the focus queue's awaiting set. The planner contributes gate-ready + planner-waiting
// from its own transitions. All converge on the alert hub (inbox domain + FCM push).

import { useEffect, useMemo, useRef, useState } from "react";
import { useAppStore } from "@/store";
import { usePoll } from "@/shared/hooks/usePoll";
import { readCoordState } from "@/shared/lib/fleet/useCoordLog";
import { logsTail } from "@/shared/lib/core/logsBridge";
import { paneIdFor } from "@/app/console/lib/paneIdentity";
import { useGlanceProjects, useGlanceFaults, useProjectFleet } from "@/features/glance";
import { resolveKitLibraryRefs } from "@/features/designs";
import { loadPendingLessons } from "@/features/skills";
import { resolveAllInstalledMcp } from "@/features/mcp";
import { deriveConsoles, buildAuditRows, APP_ROLES } from "@/features/security";
import type { Lesson } from "@/features/skills/lib/lessons";
import {
  buildGlancePayload, buildOrgPayload, buildBlueprintsPayload, buildSkillsPayload,
  buildComponentsPayload, buildThemesPayload, buildAutomationsPayload, buildMcpPayload,
  buildSecurityPayload,
} from "./lib/storeProjections";
import { publishTunnelDomain, resetTunnelDomains } from "./lib/tunnelDomains";
import { recordTunnelAlerts, seedTunnelAlerts } from "./lib/alertHub";
import { coordAlerts, promptAlerts, type AwaitingPane } from "./lib/alerts";

const LESSONS_POLL_MS = 15_000;
const COORD_POLL_MS = 2_000;
// The audit log is a CLI read (no store slice); poll it modestly for the mobile mirror — the
// desktop Agents page polls faster (3s) but only while its Activity tab is open (#2530).
const AUDIT_POLL_MS = 15_000;

export function useStoreProjector(): void {
  const tunnelRunning = useAppStore((s) => s.tunnelRunning);

  // A relay (re)start forgets the last-sent cache so the fresh Rust-side store repopulates
  // even when the frontend store hasn't changed since the previous run.
  const wasRunning = useRef(false);
  useEffect(() => {
    if (tunnelRunning && !wasRunning.current) resetTunnelDomains();
    wasRunning.current = tunnelRunning;
  }, [tunnelRunning]);

  // Personas: read once, shared by the glance payload (stream-role resolution, #2530) + the org payload.
  const personas = useAppStore((s) => s.personas);

  // Components/kits/kit-usage: read once — shared by the glance kit + library BANDS (#3743) and the
  // `components` domain below. `libraryRefs` is the cross-graph algorithm/sound roll-up (#3133), the same
  // `resolveKitLibraryRefs(components)` the Glance workspace feeds `buildGlanceData`.
  const components = useAppStore((s) => s.components);
  const kits = useAppStore((s) => s.kits);
  const kitUsage = useAppStore((s) => s.kitUsage);
  const libraryRefs = useMemo(() => resolveKitLibraryRefs(components), [components]);

  // ── glance — projects + links + faults + drill + PER-PROJECT fleets + stream roles (#2530) ──
  const projects = useGlanceProjects(tunnelRunning);
  const faults = useGlanceFaults(tunnelRunning ? projects.map((p) => p.id) : []);
  const links = useAppStore((s) => s.projectLinks);
  const drill = useAppStore((s) => s.glanceDrill);
  const planFleet = useAppStore((s) => s.planFleet);
  // The active project's fleet is already mirrored in the store; any other drilled project's is
  // loaded from its own plan.db — the same preference the Glance workspace applies. Ship EVERY loaded
  // fleet keyed by project (not just the drilled one) so any project node drills on mobile (#2530),
  // merging the on-demand drilled fleet in when the store doesn't already hold it.
  const drillFleetLoaded = useProjectFleet(tunnelRunning ? drill : null);
  const fleets = useMemo(
    () => (drill && drillFleetLoaded && !planFleet[drill] ? { ...planFleet, [drill]: drillFleetLoaded } : planFleet),
    [planFleet, drill, drillFleetLoaded],
  );
  useEffect(() => {
    if (!tunnelRunning) return;
    // #3743: carry the kit + library bands (kitUsage/kits/libraryRefs) so mobile rebuilds the FULL cockpit.
    publishTunnelDomain(
      "glance",
      buildGlancePayload({ projects, links, faults, drill, fleets, personas, kitUsage, kits, libraryRefs }),
    );
  }, [tunnelRunning, projects, links, faults, drill, fleets, personas, kitUsage, kits, libraryRefs]);

  // ── org — the org library + pared persona refs ────────────────────────────────
  const teams = useAppStore((s) => s.teams);
  useEffect(() => {
    if (!tunnelRunning) return;
    // Wire domain + payload field stay "org"/`orgs` (mobile tunnel contract, #2700); only the store read renamed.
    publishTunnelDomain("org", buildOrgPayload({ orgs: teams, personas }));
  }, [tunnelRunning, teams, personas]);

  // ── blueprints — library cards + the active blueprint's team graph ────────────
  const blueprints = useAppStore((s) => s.blueprints);
  const activeBlueprintId = useAppStore((s) => s.activeBlueprintId);
  useEffect(() => {
    if (!tunnelRunning) return;
    publishTunnelDomain("blueprints", buildBlueprintsPayload({ blueprints, activeBlueprintId }));
  }, [tunnelRunning, blueprints, activeBlueprintId]);

  // ── skills — library + groups + the active project's pending lessons ──────────
  const skills = useAppStore((s) => s.skills);
  const skillGroups = useAppStore((s) => s.skillGroups);
  const activeKey = useAppStore((s) => s.planningSessionKey || s.activeProjectId || "");
  const [lessons, setLessons] = useState<{ project: string; pending: Lesson[] } | null>(null);
  usePoll(async (isCancelled) => {
    if (!tunnelRunning || !activeKey) {
      setLessons(null); // React bails out when already null
      return;
    }
    const pending = await loadPendingLessons(activeKey);
    if (isCancelled()) return;
    setLessons({ project: activeKey, pending });
  }, LESSONS_POLL_MS, [tunnelRunning, activeKey]);
  useEffect(() => {
    if (!tunnelRunning) return;
    publishTunnelDomain("skills", buildSkillsPayload({ skills, groups: skillGroups, lessons }));
  }, [tunnelRunning, skills, skillGroups, lessons]);

  // ── components + themes — kits/components summaries · the theme registry ──────
  // (components/kits/kitUsage are read once above — shared with the glance bands, #3743.)
  useEffect(() => {
    if (!tunnelRunning) return;
    publishTunnelDomain("components", buildComponentsPayload({ kits, components, usage: kitUsage }));
  }, [tunnelRunning, kits, components, kitUsage]);

  const kitThemes = useAppStore((s) => s.kitThemes);
  const kitTheme = useAppStore((s) => s.kitTheme);
  useEffect(() => {
    if (!tunnelRunning) return;
    publishTunnelDomain("themes", buildThemesPayload({ themes: kitThemes, active: kitTheme }));
  }, [tunnelRunning, kitThemes, kitTheme]);

  // ── automations + mcp ──────────────────────────────────────────────────────────
  const automations = useAppStore((s) => s.automations);
  const hooks = useAppStore((s) => s.hooks);
  useEffect(() => {
    if (!tunnelRunning) return;
    publishTunnelDomain("automations", buildAutomationsPayload({ automations, hooks }));
  }, [tunnelRunning, automations, hooks]);

  const mcpServers = useAppStore((s) => s.mcpServers);
  useEffect(() => {
    if (!tunnelRunning) return;
    const installedIds = resolveAllInstalledMcp(mcpServers).map((s) => s.id);
    publishTunnelDomain("mcp", buildMcpPayload({ servers: mcpServers, installedIds }));
  }, [tunnelRunning, mcpServers]);

  // ── security — application roles + assignable profiles + console model + per-pane assignments +
  // recent audit (#2530 / #3754) ──
  // Profiles + assignments are live store slices; the console model is derived from the workspace tabs
  // (the SAME deriveConsoles the desktop Security page uses), and the audit log is a CLI read (no store
  // slice), polled like lessons/coord. The audit `decision` + pane→console name are computed HERE via
  // buildAuditRows (the desktop's one source of truth) so mobile never re-derives a security verdict.
  const agentProfiles = useAppStore((s) => s.agentProfiles);
  const paneRoles = useAppStore((s) => s.paneRoles);
  const paneProfiles = useAppStore((s) => s.paneProfiles);
  const tabs = useAppStore((s) => s.tabs);
  const paneNames = useAppStore((s) => s.paneNames);
  const disabledPanes = useAppStore((s) => s.disabledPanes);
  const activeRepoName = useAppStore((s) => s.activeRepoName);
  const secConsoles = useMemo(
    () => deriveConsoles({ tabs, paneNames, disabledPanes, paneProfiles, activeRepoName }),
    [tabs, paneNames, disabledPanes, paneProfiles, activeRepoName],
  );
  const [auditLines, setAuditLines] = useState<string[]>([]);
  usePoll(async (isCancelled) => {
    if (!tunnelRunning) { setAuditLines([]); return; } // React bails when already []
    const lines = await logsTail("audit", 300);
    if (isCancelled()) return;
    setAuditLines(lines);
  }, AUDIT_POLL_MS, [tunnelRunning]);
  const auditRows = useMemo(
    () => buildAuditRows(auditLines, { consoles: secConsoles, profiles: agentProfiles, paneProfiles, paneRoles }),
    [auditLines, secConsoles, agentProfiles, paneProfiles, paneRoles],
  );
  useEffect(() => {
    if (!tunnelRunning) return;
    publishTunnelDomain("security", buildSecurityPayload({
      appRoles: APP_ROLES, profiles: agentProfiles, consoles: secConsoles, paneRoles, paneProfiles, auditRows,
    }));
  }, [tunnelRunning, agentProfiles, secConsoles, paneRoles, paneProfiles, auditRows]);

  // ── alerts — coord-log events + the focus queue's awaiting set ────────────────
  // Coord entries carry their own `at`, so re-derivation is idempotent (the hub dedups by id).
  // The FIRST successful read after the relay starts SEEDS the inbox without pushing — the
  // historical log fills the mobile inbox but never fires a burst of stale FCM notifications.
  const coordSeeded = useRef(false);
  useEffect(() => {
    if (!tunnelRunning) coordSeeded.current = false;
  }, [tunnelRunning]);
  usePoll(async (isCancelled) => {
    if (!tunnelRunning) return;
    const res = await readCoordState(1000);
    if (isCancelled() || !res) return;
    const candidates = coordAlerts(res.state);
    if (coordSeeded.current) {
      recordTunnelAlerts(candidates);
    } else {
      coordSeeded.current = true;
      seedTunnelAlerts(candidates);
    }
  }, COORD_POLL_MS, [tunnelRunning]);

  // Prompt-waiting is a transition (no durable log): diff the awaiting set against the previous
  // tick; a pane that resolves and awaits again re-alerts. (`tabs`/`paneNames` are read once above
  // for the security console model.)
  const focusQueue = useAppStore((s) => s.focusQueue);
  const prevAwaiting = useRef<AwaitingPane[]>([]);
  useEffect(() => {
    if (!tunnelRunning) {
      prevAwaiting.current = [];
      return;
    }
    const awaiting: AwaitingPane[] = focusQueue.map((q) => ({
      paneId: paneIdFor(tabs[q.tab], q.tab, q.pane),
      name: paneNames[q.tab]?.[q.pane] ?? `console-${q.tab + 1}-${q.pane + 1}`,
    }));
    recordTunnelAlerts(promptAlerts(prevAwaiting.current, awaiting, Date.now()));
    prevAwaiting.current = awaiting;
  }, [tunnelRunning, focusQueue, tabs, paneNames]);
}
