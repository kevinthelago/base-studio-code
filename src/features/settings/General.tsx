import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store";
import { MODELS, type ModelId } from "@/app/console/lib/models";
import { Toggle } from "@/shared/ui/Toggle";
import { SettingsCardHead } from "./SettingsControls";

export function ToggleRow({ on, onToggle, title, children }: {
  on: boolean; onToggle: () => void; title: string; children: React.ReactNode;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
      <Toggle on={on} onClick={onToggle} role="switch" ariaChecked={on} />
      <div>
        <div style={{ fontFamily: "var(--mono)", fontSize: 11.5, color: "var(--fg)", marginBottom: 2 }}>
          {title}
        </div>
        <div className="hint">{children}</div>
      </div>
    </div>
  );
}

export function GeneralSettings() {
  const {
    bscBaseDir, setBscBaseDir,
    defaultModel, setDefaultModel,
    autoResumeClaude, setAutoResumeClaude,
    autoAdvanceOnReply, setAutoAdvanceOnReply,
    injectionHardGate, setInjectionHardGate,
  } = useAppStore();

  async function chooseBaseDir() {
    const dir = await invoke<string | null>("pick_directory");
    if (dir) setBscBaseDir(dir);
  }

  return (
    <div style={{ maxWidth: 820 }}>
      <h2 style={{ fontFamily: "var(--mono)", fontSize: 18, margin: "0 0 4px", fontWeight: 600 }}>General</h2>
      <p style={{ color: "var(--fg-muted)", margin: "0 0 22px", fontSize: 12 }}>
        App-wide preferences for workspaces, models, and session behavior.
      </p>

      <div className="card">
        <SettingsCardHead title="Workspace" />
        <div className="field">
          <label>Base directory</label>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              className="input"
              value={bscBaseDir}
              onChange={(e) => setBscBaseDir(e.target.value)}
              placeholder="~/.base-studio-code"
            />
            <button className="btn" onClick={chooseBaseDir}>Choose…</button>
          </div>
          <div className="hint">
            Where projects, clones, and agent worktrees live
            (<code>&lt;base&gt;/projects/&lt;project&gt;/…</code>). Leave blank for the default
            (<code>~/.base-studio-code</code>).
          </div>
        </div>
      </div>

      <div style={{ height: 18 }} />

      <div className="card">
        <SettingsCardHead title="Default model" />
        <div className="field">
          <label>Model new consoles open with</label>
          <select
            className="input"
            value={defaultModel}
            onChange={(e) => setDefaultModel(e.target.value as ModelId)}
          >
            {MODELS.map((m) => (
              <option key={m.id} value={m.id}>{m.id} · {m.tone}</option>
            ))}
          </select>
          <div className="hint">Per-pane override is available from the pane hamburger menu.</div>
        </div>
      </div>

      <div style={{ height: 18 }} />

      <div className="card">
        <SettingsCardHead title="Sessions & console behavior" />
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <ToggleRow
            on={autoResumeClaude}
            onToggle={() => setAutoResumeClaude(!autoResumeClaude)}
            title="Auto-resume Claude on restart"
          >
            Panes that had Claude running at last shutdown relaunch it with <code>--continue</code> when
            the app reopens, restoring the prior conversation. Off means panes start at a bare bash
            prompt; you'd type <code>claude</code> yourself.
          </ToggleRow>
          <ToggleRow
            on={autoAdvanceOnReply}
            onToggle={() => setAutoAdvanceOnReply(!autoAdvanceOnReply)}
            title="Cycle to next console on reply"
          >
            When you send a response to a console, jump focus to the next one waiting in the queue
            (Ctrl+Shift+N cycles manually). Works while maximized.
          </ToggleRow>
        </div>
      </div>

      <div style={{ height: 18 }} />

      <div className="card">
        <SettingsCardHead title="Planner security" />
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <ToggleRow
            on={injectionHardGate}
            onToggle={() => setInjectionHardGate(!injectionHardGate)}
            title="Hard-block the plan on prompt-injection markers"
          >
            The planner reviews untrusted repos and web pages, then authors the kickoffs the whole
            fleet runs. The plan is scanned for injected instructions (permission-widening, exfiltration,
            push/merge, CI/hook tampering, &ldquo;ignore previous instructions&rdquo;). <b>On:</b> a flagged
            plan <b>cannot publish</b> until the marker is removed. <b>Off (default):</b> findings are
            surfaced and you acknowledge them to proceed.
          </ToggleRow>
        </div>
      </div>
    </div>
  );
}
