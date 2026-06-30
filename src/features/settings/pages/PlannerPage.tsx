import { useState } from "react";
import { LlmProviderCard } from "../cards/LlmProviderCard";
import { PlanningAutomationCard } from "../cards/PlanningAutomationCard";
import { ShellSelectorCard } from "../cards/ShellSelectorCard";
import { TunnelSettings } from "@/features/tunnel";
import { MetricsCollectionCard } from "../cards/MetricsCollectionCard";
import { IdleReaperCard } from "../cards/IdleReaperCard";
import { PerfRetentionCard } from "../cards/PerfRetentionCard";
import { StorageCard } from "../cards/StorageCard";
import { SandboxedConsolesCard } from "../cards/SandboxedConsolesCard";
import { LogsInventoryCard } from "../cards/LogsInventoryCard";
import { LogsViewerCard } from "../cards/LogsViewerCard";
import { LogsRetentionCard } from "../cards/LogsRetentionCard";

/** A settings page sub-section header — the group label within a page (scaled-down page h2). */
function Sub({ children }: { children: string }) {
  return (
    <h3 className="mono" style={{ fontSize: 12.5, margin: "10px 0 -6px", fontWeight: 600, color: "var(--fg-dim)", textTransform: "uppercase", letterSpacing: ".07em" }}>
      {children}
    </h3>
  );
}

export function PlannerPage() {
  const [selectedStream, setSelectedStream] = useState<string | null>(null);
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const [notice, setNotice] = useState("");

  const flash = (msg: string) => {
    setNotice(msg);
    setTimeout(() => setNotice(""), 6000);
  };

  const getStreamLabel = (stream: string) => {
    if (stream === "app") return "Application log";
    if (stream === "perf") return "Performance logs";
    return `Session: ${stream}`;
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18, maxWidth: 820 }}>
      <h2 className="mono" style={{ fontSize: 18, margin: "0 0 4px", fontWeight: 600 }}>Planner</h2>
      <p style={{ color: "var(--fg-muted)", margin: "0 0 4px", fontSize: 12 }}>
        LLM planning providers, autopilot, the session shell, mobile tunnel, performance, and storage.
      </p>

      <Sub>Providers &amp; automation</Sub>
      <LlmProviderCard />
      <PlanningAutomationCard />

      <Sub>Shell</Sub>
      <ShellSelectorCard />

      <Sub>Mobile tunnel</Sub>
      <TunnelSettings />

      <Sub>Performance &amp; memory</Sub>
      <MetricsCollectionCard />
      <IdleReaperCard />
      <PerfRetentionCard />

      <Sub>Storage &amp; logs</Sub>
      <SandboxedConsolesCard />
      <StorageCard />
      <LogsInventoryCard
        selectedStream={selectedStream}
        onViewStream={setSelectedStream}
        flash={flash}
        refreshTrigger={refreshTrigger}
      />

      {notice && (
        <div className="mono" style={{ fontSize: 11, color: "var(--accent)", marginTop: -8, wordBreak: "break-all" }}>
          {notice}
        </div>
      )}

      {selectedStream && (
        <LogsViewerCard
          stream={selectedStream}
          fileLabel={getStreamLabel(selectedStream)}
          onClose={() => setSelectedStream(null)}
        />
      )}

      <LogsRetentionCard
        onEnforced={() => setRefreshTrigger(prev => prev + 1)}
        flash={flash}
      />
    </div>
  );
}
