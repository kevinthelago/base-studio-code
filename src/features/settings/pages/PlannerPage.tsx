import { useState } from "react";
import { LlmProviderCard } from "../cards/LlmProviderCard";
import { PlanningAutomationCard } from "../cards/PlanningAutomationCard";
import { ShellSelectorCard } from "../cards/ShellSelectorCard";
import { KitChangeApprovalCard } from "../cards/KitChangeApprovalCard";
import { TunnelSettings } from "@/features/tunnel";
import { MetricsCollectionCard } from "../cards/MetricsCollectionCard";
import { IdleReaperCard } from "../cards/IdleReaperCard";
import { PerfRetentionCard } from "../cards/PerfRetentionCard";
import { StorageCard } from "../cards/StorageCard";
import { SandboxedConsolesCard } from "../cards/SandboxedConsolesCard";
import { DebugSessionCard } from "../cards/DebugSessionCard";
import { LogsInventoryCard } from "../cards/LogsInventoryCard";
import { LogsViewerCard } from "../cards/LogsViewerCard";
import { LogsRetentionCard } from "../cards/LogsRetentionCard";
import { SessionLogCard } from "../cards/SessionLogCard";
import { Stack } from "@/shared/ui/layout/Stack";
import { Text } from "@/shared/ui/typography/Text";
import { SettingsPageHeader, SettingsSubHeader as Sub } from "./SettingsPageHeader";

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
    return `${stream}.log`;
  };

  return (
    <Stack gap={18} style={{ maxWidth: 820 }}>
      <SettingsPageHeader
        title="Planner"
        description="LLM planning providers, autopilot, the session shell, mobile tunnel, performance, and storage."
      />

      <Sub>Providers &amp; automation</Sub>
      <LlmProviderCard />
      <PlanningAutomationCard />

      <Sub>Design</Sub>
      <KitChangeApprovalCard />

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
      <DebugSessionCard />
      <StorageCard />
      <LogsInventoryCard
        selectedStream={selectedStream}
        onViewStream={setSelectedStream}
        flash={flash}
        refreshTrigger={refreshTrigger}
      />

      {notice && (
        <Text as="div" mono size={11} tone="accent" style={{ marginTop: -8, wordBreak: "break-all" }}>
          {notice}
        </Text>
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

      <Sub>Session drill-down</Sub>
      <SessionLogCard />
    </Stack>
  );
}
