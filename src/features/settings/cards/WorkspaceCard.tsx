import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store";
import { SettingsCardHead } from "../screens/SettingsControls";

export function WorkspaceCard() {
  const { bscBaseDir, setBscBaseDir } = useAppStore();

  async function chooseBaseDir() {
    const dir = await invoke<string | null>("pick_directory");
    if (dir) setBscBaseDir(dir);
  }

  return (
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
  );
}
