import { useAppStore } from "@/store";
import { MODELS, type ModelId } from "@/app/console/lib/models";
import { SettingsSelectField } from "../pages/SettingsControls";
import { Card } from "@/shared/ui/Card";

export function DefaultModelCard() {
  const { defaultModel, setDefaultModel } = useAppStore();

  return (
    <Card title="Default model">
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
    </Card>
  );
}
