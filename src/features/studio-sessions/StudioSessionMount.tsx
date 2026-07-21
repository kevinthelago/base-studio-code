// StudioSessionMount (#3357) — the persistent host that keeps ONE app-owned studio session (designer /
// librarian / architect) alive on the shared TerminalHost. The exact shape of `DebugSessionMount` (#3326),
// generalised over the studio registry.
//
// WHY A HIDDEN `primary` SLOT: TerminalHost renders a <TerminalView> for a paneId only WHILE that paneId
// has at least one claim; when the last claim deregisters, the view unmounts and the PTY is torn down. A
// fleet terminal survives a morph-close because its console GRID CELL is a permanent claim. A studio
// session has no cell — so THIS mount is its permanent `primary` claim. It:
//   • supplies the launch props (cwd + resume initCmd) as the primary, and
//   • sits OFF-SCREEN (NOT `display:none`, so the parked xterm still fits to a real size) — keeping the
//     PTY warm while the user is on another page.
// The studio page dock and the Glance node morph each drop a second, VISIBLE viewer slot for the same
// paneId; being the last claim, whichever is open owns the terminal, so the host re-parents the live
// terminal into it and back here on close. That re-parent is a plain appendChild MOVE, so the xterm
// scrollback and the PTY survive untouched — which is the whole point of the migration: before #3357 the
// studios ran their own single-mount xterm (`useScreenSession`), which the host could not re-parent, so
// their Glance nodes could not morph.
//
// POSTURE: unlike the DEBUG session (full-capability, role-less — the `isFullCapabilitySession` carve-out),
// a studio session is heavily RESTRICTED, and that posture is now fully role-derived. This mount sets
// `paneRoles[paneId]` and NOTHING permission-shaped beyond it: `buildSessionSettings` reads the role,
// computes `restrictedRoleCommands(role)` as the session's ONLY allowed commands, flips `restrictedAllow`
// (suppressing every Bash baseline tier), grants `Read`, renders the role's git/gh/write/web denies, and
// forces `bypass:false` for a restricted role. `buildAgentEnv` emits the same `BSC_SCOPES` the bespoke
// launch did. CRITICALLY, no `paneProfiles` entry is set — a profile's `allowedCommands` are ADDED to the
// restricted surface, so assigning one would WIDEN the session.
import { useEffect, useState } from "react";
import { useAppStore } from "@/store";
import { safeInvoke } from "@/shared/lib/core/safeInvoke";
import { Box } from "@/shared/ui/layout/Box";
import { TerminalSlot } from "@/app/console/terminal/TerminalSlot";
import { BUILTIN_PERSONAS } from "@/features/personas";
import { STUDIO_INIT_CMD, STUDIO_SESSIONS, type StudioId, type StudioSessionDef } from "./lib/studioSessions";

/** The studio persona's start prompt — the store copy (user edits win), else the packaged seed. */
export function studioStartPrompt(personaId: string): string {
  const fromStore = useAppStore.getState().personas.find((p) => p.id === personaId);
  return (fromStore ?? BUILTIN_PERSONAS.find((p) => p.id === personaId))?.startPrompt ?? "";
}

/**
 * Seed every store field the GENERIC launch path (`TerminalView` → `buildAgentEnv` /
 * `buildSessionSettings` / `pty_create`) reads for this pane, reproducing the bespoke `use*Terminal`
 * launch exactly:
 *   • `paneRoles`             → the whole restricted permission payload (see the file header).
 *   • `paneStartupPromptText` → the persona kickoff, BAKED into the launch arg (never typed after idle
 *                               detection). Omitted when the persona has no prompt, so `pty_create` gets
 *                               `undefined` rather than an empty initial message.
 *   • `paneContinue`          → `claude --continue`, so a relaunch resumes the prior conversation.
 *   • `paneMcpServers` / `paneHooks` / `paneSkills` → pinned EMPTY. Without these the generic path falls
 *     back to the GLOBAL sets, which would attach every configured MCP server (i.e. extra tools) and the
 *     global skills to a session deliberately confined to one store CLI. The bespoke launch passed none;
 *     pinning empty keeps that boundary.
 * Exported for the unit test — the permission payload is the security-critical half of this migration.
 */
export function seedStudioLaunchState(def: StudioSessionDef): void {
  const prompt = studioStartPrompt(def.personaId);
  useAppStore.setState((st) => {
    const startupPrompts = { ...st.paneStartupPromptText };
    if (prompt) startupPrompts[def.paneId] = prompt;
    else delete startupPrompts[def.paneId];
    return {
      paneRoles:             { ...st.paneRoles, [def.paneId]: def.role },
      paneStartupPromptText: startupPrompts,
      paneContinue:          { ...st.paneContinue, [def.paneId]: true },
      paneMcpServers:        { ...st.paneMcpServers, [def.paneId]: [] },
      paneHooks:             { ...st.paneHooks, [def.paneId]: [] },
      paneSkills:            { ...st.paneSkills, [def.paneId]: [] },
    };
  });
}

/**
 * Keeps ONE studio session's PTY warm on TerminalHost. Renders nothing visible (the terminal is shown by
 * the page dock / the Glance morph); returns null until the workspace command hands back a real cwd —
 * a studio session must never launch against an empty cwd, which would skip `ensure_session_settings`
 * and run it permission-less (#1819).
 */
export function StudioSessionMount({ studio }: { studio: StudioId }) {
  const def = STUDIO_SESSIONS[studio];
  // undefined = still resolving; null = setup failed (no session); string = the workspace cwd.
  const [cwd, setCwd] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    void (async () => {
      // The studio's global workspace (e.g. ~/.base-studio-code/design-studio/) + its spec CLAUDE.md.
      const paths = await safeInvoke<Record<string, string> | null>(
        def.setupCommand, undefined, null,
        (e: unknown) => console.error(`${def.id} workspace setup failed:`, e),
      );
      if (!alive) return;
      const dir = paths?.[def.dirKey];
      if (!dir) { setCwd(null); return; }
      seedStudioLaunchState(def);
      // Session roster (#2497): register the studio session so a paired phone lists it alongside the
      // console/fleet/planner panes. Plain store state — useTunnelSync only pushes while the relay runs,
      // so this is inert without a tunnel. Deregistered in the cleanup below.
      useAppStore.getState().registerTunnelPanes(def.id, [{
        id: def.paneId, cwd: dir, name: def.rosterName, status: "running", kind: def.id,
      }]);
      setCwd(dir);
    })();
    return () => { alive = false; useAppStore.getState().registerTunnelPanes(def.id, []); };
  }, [def]);

  if (!cwd) return null;
  return (
    // Off-screen (NOT display:none, so the parked xterm still fits to a real size) permanent `primary`
    // claim. A visible viewer slot re-parents the terminal out of here when a surface opens it.
    <Box
      aria-hidden
      data-testid={`studio-mount-${def.id}`}
      style={{
        position: "absolute", left: -99999, top: 0, width: 800, height: 600,
        overflow: "hidden", pointerEvents: "none", display: "flex", flexDirection: "column",
      }}
    >
      {/* `parked`: this claim can register at ANY time (its cwd resolves async), so it must never take
          ownership away from a visible dock/morph that claimed first — it owns the terminal only when it
          is the last claim standing. */}
      <TerminalSlot paneId={def.paneId} primary parked visible={false} initialCwd={cwd} initCmd={STUDIO_INIT_CMD} />
    </Box>
  );
}
