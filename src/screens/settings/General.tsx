import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../../store";
import type { ModelId } from "../../components/pane/PaneMenu";

const MODELS: { id: ModelId; label: string }[] = [
  { id: "haiku-4.5",  label: "haiku-4.5 · fast"     },
  { id: "sonnet-4.5", label: "sonnet-4.5 · balanced" },
  { id: "opus-4.5",   label: "opus-4.5 · deep"      },
];

/** Pill toggle matching the one in Integrations. */
function Toggle({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <span
      onClick={onToggle}
      role="switch"
      aria-checked={on}
      style={{
        display: "inline-flex", alignItems: "center",
        width: 32, height: 18, borderRadius: 99, cursor: "pointer",
        background: on ? "var(--accent)" : "var(--bg-elev2)",
        border: "1px solid " + (on ? "transparent" : "var(--border)"),
        transition: "background 0.15s",
        flex: "0 0 auto",
      }}
    >
      <span style={{
        width: 12, height: 12, borderRadius: "50%",
        background: on ? "#1a120a" : "var(--fg-dim)",
        marginLeft: on ? "auto" : 2,
        marginRight: on ? 2 : "auto",
        transition: "margin 0.15s",
      }} />
    </span>
  );
}

function ToggleRow({ on, onToggle, title, children }: {
  on: boolean; onToggle: () => void; title: string; children: React.ReactNode;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
      <Toggle on={on} onToggle={onToggle} />
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
        <div style={{ display: "flex", alignItems: "baseline", marginBottom: 12, gap: 10 }}>
          <h3 style={{ margin: 0 }}>Workspace</h3>
        </div>
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
        <div style={{ display: "flex", alignItems: "baseline", marginBottom: 12, gap: 10 }}>
          <h3 style={{ margin: 0 }}>Default model</h3>
        </div>
        <div className="field">
          <label>Model new consoles open with</label>
          <select
            className="input"
            value={defaultModel}
            onChange={(e) => setDefaultModel(e.target.value as ModelId)}
          >
            {MODELS.map((m) => (
              <option key={m.id} value={m.id}>{m.label}</option>
            ))}
          </select>
          <div className="hint">Per-pane override is available from the pane hamburger menu.</div>
        </div>
      </div>

      <div style={{ height: 18 }} />

      <div className="card">
        <div style={{ display: "flex", alignItems: "baseline", marginBottom: 12, gap: 10 }}>
          <h3 style={{ margin: 0 }}>Sessions & console behavior</h3>
        </div>
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
    </div>
  );
}
