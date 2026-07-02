// The modal set for the per-agent WorkerDetail page (#499): steer / answer a
// worker's question (typed straight into its running session), stop & remove it,
// and switch the least-privilege profile it runs under.
import { ColorSwatch } from "@/shared/ui/controls/ColorSwatch";
import { Stack } from "@/shared/ui/layout/Stack";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import { Button } from "@/shared/ui/controls/Button";
import type { StatusMeta } from "@/shared/data/fleet";
import type { LiveWorker } from "@/shared/lib/fleet/fleetLive";
import type { AgentProfile } from "@/features/agents/lib/agentProfiles";
import { Modal } from "./WorkerDetailModal";
import type { WorkerModal } from "./workerDetail.helpers";

export function WorkerModals({ modal, setModal, worker, st, draft, setDraft, send, stop, agentProfiles, profileId, setPaneProfile, flash }: {
  modal: WorkerModal | null;
  setModal: (m: WorkerModal | null) => void;
  worker: LiveWorker;
  st: StatusMeta;
  draft: string;
  setDraft: (v: string) => void;
  send: (kind: "steer" | "answer") => void;
  stop: () => void;
  agentProfiles: AgentProfile[];
  profileId: string | undefined;
  setPaneProfile: (paneId: string, profileId: string | null) => void;
  flash: (m: string) => void;
}) {
  return (
    <>
      {(modal === "steer" || modal === "answer") && (
        <Modal title={modal === "answer" ? `Answer ${worker.name}` : `Steer ${worker.name}`} onClose={() => setModal(null)}
          footer={<>
            <Button variant="ghost" onClick={() => setModal(null)}>cancel</Button>
            <Button variant="primary" onClick={() => send(modal)}>{modal === "answer" ? "send answer" : "send"}</Button>
          </>}>
          {modal === "answer" && worker.note && (
            <Box className="mono" pad={[10, 12]} bg={`color-mix(in oklch, ${st.color}, transparent 90%)`} radius={8} style={{ border: `1px solid color-mix(in oklch, ${st.color}, transparent 70%)`, marginBottom: 10, fontSize: 11.5, color: "var(--fg)" }}>
              {worker.note}
            </Box>
          )}
          <Box className="hint" style={{ marginBottom: 8 }}>Typed straight into this worker's running session.</Box>
          {/* eslint-disable-next-line no-restricted-syntax -- freeform multiline input; textareas stay raw */}
          <textarea value={draft} onChange={(e) => setDraft(e.target.value)} autoFocus
            placeholder={modal === "answer" ? "your decision…" : "e.g. skip the migration; focus on the API contract"}
            className="mono"
            style={{ width: "100%", minHeight: 84, resize: "vertical", background: "var(--bg-canvas)", border: "1px solid var(--border-soft)", borderRadius: 8, padding: 10, color: "var(--fg)", fontSize: 12, outline: "none" }} />
        </Modal>
      )}
      {modal === "stop" && (
        <Modal title="Stop & remove worker" onClose={() => setModal(null)}
          footer={<>
            <Button variant="ghost" onClick={() => setModal(null)}>cancel</Button>
            <Button danger onClick={stop}>stop &amp; remove</Button>
          </>}>
          <Text as="div" size={12} tone="muted" style={{ lineHeight: 1.6 }}>
            This stops <b style={{ color: "var(--fg)" }}>{worker.name}</b>'s session (disables its pane). Its worktree is
            preserved; re-enable the console to resume.
          </Text>
        </Modal>
      )}
      {modal === "profile" && (
        <Modal title="Change profile" onClose={() => setModal(null)}>
          <Box className="hint" style={{ marginBottom: 10 }}>Switch the least-privilege profile this worker runs under (applies on its next launch).</Box>
          <Stack gap={6} style={{ maxHeight: 360, overflow: "auto" }}>
            {agentProfiles.map((p) => (
              // eslint-disable-next-line no-restricted-syntax -- bespoke profile-select row button (custom card layout, not a .btn)
              <button key={p.id} onClick={() => { setPaneProfile(worker.id, p.id); setModal(null); flash(`Profile → ${p.name}`); }} style={{
                display: "flex", alignItems: "center", gap: 10, padding: "9px 12px", textAlign: "left", cursor: "pointer",
                background: p.id === profileId ? "var(--bg-elev2)" : "var(--bg-elev)", color: "var(--fg)",
                border: "1px solid " + (p.id === profileId ? p.color : "var(--border-soft)"), borderRadius: 8,
              }}>
                <ColorSwatch color={p.color} size={8} />
                <Text as="span" mono size={11.5} style={{ flex: 1 }}>{p.name}</Text>
                <Text as="span" mono size={9.5} tone="dim">base {p.mode}</Text>
                {p.id === profileId && <Text as="span" mono size={9.5} style={{ color: p.color }}>current</Text>}
              </button>
            ))}
          </Stack>
        </Modal>
      )}
    </>
  );
}
