import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store";

// A two-step confirm button: the first click arms it (turns red), the second
// click within the same focus fires. Blur disarms, so a stray click is safe.
function ConfirmButton({ label, armedLabel, onConfirm }: {
  label: string; armedLabel: string; onConfirm: () => void | Promise<void>;
}) {
  const [armed, setArmed] = useState(false);
  return (
    <button
      onClick={() => { if (armed) { setArmed(false); void onConfirm(); } else { setArmed(true); } }}
      onBlur={() => setArmed(false)}
      style={{
        alignSelf: "flex-start",
        padding: "8px 14px", borderRadius: 6, cursor: "pointer",
        fontFamily: "var(--mono)", fontSize: 11.5,
        background: armed ? "var(--danger)" : "var(--bg-elev)",
        color: armed ? "var(--bg-canvas)" : "var(--danger)",
        border: "1px solid " + (armed
          ? "var(--danger)"
          : "color-mix(in oklch, var(--danger), transparent 55%)"),
      }}
    >{armed ? armedLabel : label}</button>
  );
}

function ResetCard({ title, desc, children }: {
  title: string; desc: string; children: React.ReactNode;
}) {
  return (
    <div style={{
      display: "flex", flexDirection: "column", gap: 10,
      padding: 16, borderRadius: 8,
      background: "var(--bg-panel)", border: "1px solid var(--border-soft)",
    }}>
      <div style={{ fontFamily: "var(--sans)", fontSize: 13, color: "var(--fg)" }}>{title}</div>
      <div style={{ fontFamily: "var(--sans)", fontSize: 11.5, lineHeight: 1.5, color: "var(--fg-muted)" }}>{desc}</div>
      {children}
    </div>
  );
}

export function DeveloperSettings() {
  const resetProjectData = useAppStore((s) => s.resetProjectData);

  // Delete the on-disk plan files (best-effort) so a store clear actually sticks —
  // otherwise the planning poll re-reads them and repopulates. The backend command
  // preserves cloned repos (they are subdirectories).
  const clearPlanFiles = async () => {
    try { await invoke("clear_all_plan_files"); } catch { /* best effort */ }
  };

  // Files first, then the store, so no poll can repopulate from a still-present file.
  const clearProjects = async () => {
    await clearPlanFiles();
    resetProjectData();
  };

  // Wipe stored app state + on-disk plan files, then reload to a clean first-run.
  const resetFresh = async () => {
    await clearPlanFiles();
    await useAppStore.persist.clearStorage();
    window.location.reload();
  };

  return (
    <div style={{ maxWidth: 640, display: "flex", flexDirection: "column", gap: 20 }}>
      <div>
        <div style={{ fontFamily: "var(--sans)", fontSize: 16, color: "var(--fg)", marginBottom: 6 }}>Developer</div>
        <div style={{ fontFamily: "var(--sans)", fontSize: 11.5, lineHeight: 1.5, color: "var(--fg-muted)" }}>
          Tools for testing the app from a clean slate. Your cloned repos are always
          preserved — only the planner's generated files and the app's stored state
          are removed.
        </div>
      </div>

      <ResetCard
        title="Reset to fresh state"
        desc="Clears everything the app has stored — GitHub and Claude credentials, the project list, all plans, agent profiles, panes and UI — and deletes the on-disk plan files, then reloads to the first-run experience. Your cloned repos under ~/.base-studio-code/projects are preserved."
      >
        <ConfirmButton
          label="Reset to fresh state"
          armedLabel="Click again to confirm — this signs you out"
          onConfirm={resetFresh}
        />
      </ResetCard>

      <ResetCard
        title="Clear projects & plans"
        desc="Forgets every project, plan, fleet, and per-project setting, and deletes the on-disk plan files (goal, issues, phases, fleet, the context docs) so planning starts truly empty. Keeps your credentials and profiles so you can re-plan without signing back in; your cloned repos are preserved."
      >
        <ConfirmButton
          label="Clear projects & plans"
          armedLabel="Click again to confirm"
          onConfirm={clearProjects}
        />
      </ResetCard>

      <div style={{ fontFamily: "var(--sans)", fontSize: 10.5, lineHeight: 1.5, color: "var(--fg-dim)" }}>
        Only the planner's generated plan files are removed — the cloned repos (your
        actual code) under ~/.base-studio-code/projects are always kept. To delete a
        single project entirely, use the delete action on its card in the Projects list.
      </div>
    </div>
  );
}
