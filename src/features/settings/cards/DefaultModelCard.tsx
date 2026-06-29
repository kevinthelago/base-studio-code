import { useAppStore } from "@/store";
import { MODELS, type ModelId } from "@/app/console/lib/models";
import { SettingsCardHead, SettingsSelectField } from "../pages/SettingsControls";

export function DefaultModelCard() {
  const { defaultModel, setDefaultModel } = useAppStore();

  return (
    <div className="card">
      <SettingsCardHead title="Default model" />
      <SettingsSelectField
        label="Model new consoles open with"
        value={defaultModel}
        onChange={(v) => setDefaultModel(v as ModelId)}
        hint="Per-pane override is available from the pane hamburger menu."
      >
        {MODELS.map((m) => (
          <option key={m.id} value={m.id}>{m.id} · {m.tone}</option>
        ))}
      </SettingsSelectField>
    </div>
  );
}
