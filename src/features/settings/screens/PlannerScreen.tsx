import { useState } from "react";
import { LlmProviderCard } from "../cards/LlmProviderCard";
import { PlanningAutomationCard } from "../cards/PlanningAutomationCard";
import { DiagnosticsCard } from "../cards/DiagnosticsCard";
import { ShellSelectorCard } from "../cards/ShellSelectorCard";
import { TunnelSettings } from "@/features/tunnel";
import { MetricsCollectionCard } from "../cards/MetricsCollectionCard";
import { IdleReaperCard } from "../cards/IdleReaperCard";
import { PerfRetentionCard } from "../cards/PerfRetentionCard";
import { LogsInventoryCard } from "../cards/LogsInventoryCard";
import { LogsViewerCard } from "../cards/LogsViewerCard";
import { LogsRetentionCard } from "../cards/LogsRetentionCard";

export function PlannerScreen() {
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
      {/* Planner Header */}
      <h2 style={{ fontFamily: "var(--mono)", fontSize: 18, margin: "0 0 4px", fontWeight: 600 }}>Planner</h2>
      <p style={{ color: "var(--fg-muted)", margin: "0 0 4px", fontSize: 12 }}>
        Manage LLM planning providers, autopilot options, telemetry, performance, and background logs.
      </p>

      {/* Provider & Planning Automation */}
      <LlmProviderCard />
      <PlanningAutomationCard />

      {/* Environment Diagnostics & Shell */}
      <DiagnosticsCard />
      <ShellSelectorCard />

      {/* Mobile tunnel */}
      <TunnelSettings />

      {/* Metrics collection & reaping background idle memory */}
      <MetricsCollectionCard />
      <IdleReaperCard />
      <PerfRetentionCard />

      {/* Database & PTY stream logs */}
      <LogsInventoryCard
        selectedStream={selectedStream}
        onViewStream={setSelectedStream}
        flash={flash}
        refreshTrigger={refreshTrigger}
      />

      {notice && (
        <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--accent)", marginTop: -8, wordBreak: "break-all" }}>
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
