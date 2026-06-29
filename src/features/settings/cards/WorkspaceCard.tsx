import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store";
import { SettingsTextField } from "../pages/SettingsControls";
import { Card } from "@/shared/ui/data/Card";

export function WorkspaceCard() {
  const { bscBaseDir, setBscBaseDir } = useAppStore();

  async function chooseBaseDir() {
    const dir = await invoke<string | null>("pick_directory");
    if (dir) setBscBaseDir(dir);
  }

  return (
    <Card title="Workspace">
      <SettingsTextField
        label="Base directory"
        value={bscBaseDir}
        onChange={setBscBaseDir}
        placeholder="~/.base-studio-code"
        trailing={<button className="btn" onClick={chooseBaseDir}>Choose…</button>}
        hint={<>
          Where projects, clones, and agent worktrees live
          (<code>&lt;base&gt;/projects/&lt;project&gt;/…</code>). Leave blank for the default
          (<code>~/.base-studio-code</code>).
        </>}
      />
    </Card>
  );
}
