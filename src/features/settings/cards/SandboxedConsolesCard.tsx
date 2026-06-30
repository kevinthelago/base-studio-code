import { Card } from "@/shared/ui/data/Card";
import { useAppStore } from "@/store";
import { ToggleRow } from "../pages/SettingsControls";

/**
 * Toggle: run new console sessions inside the sealed WSL2 agent sandbox (#1988). Lives next to the
 * Storage card because both concern the same WSL2 sandbox — this turns it on; Storage shows and
 * reclaims its disk footprint.
 */
export function SandboxedConsolesCard() {
  const { sandboxConsoles, setSandboxConsoles } = useAppStore();
  return (
    <Card title="Sandboxed consoles">
      <ToggleRow
        on={sandboxConsoles}
        onToggle={() => setSandboxConsoles(!sandboxConsoles)}
        title="Run new console sessions inside the WSL2 sandbox"
      >
        New console panes launch a clean shell <b>inside the sealed <code>bsc-agent-sandbox</code>{" "}
        distro</b> (no <code>/mnt/c</code>, no Windows interop) instead of on the host — so whatever
        runs is confined to the cage, regardless of which LLM drives it. Requires the sandbox installed
        (Settings → General → Required dependencies). Your Windows repos aren't mounted in yet, so this
        is a scratch/verification shell for now. Takes effect on the next console you open.
      </ToggleRow>
    </Card>
  );
}
