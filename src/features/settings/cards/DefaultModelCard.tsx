import { useAppStore } from "@/store";
import { MODELS, type ModelId } from "@/app/console/lib/models";
import { SettingsCardHead } from "../screens/SettingsControls";

export function DefaultModelCard() {
  const { defaultModel, setDefaultModel } = useAppStore();

  return (
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
  );
}
