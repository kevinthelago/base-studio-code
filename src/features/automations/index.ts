// The automations feature's PUBLIC API — re-exports only, plus the stylesheet the page needs.
//
// The Automations screen itself (#142) is the `automationspage` RECORD, mounted by
// AutomationsGraphHost — which is what `lazyWorkspaces` resolves the `AutomationsWorkspace` symbol
// to, in both App.tsx and DetachedWindow. The copy that used to live in this file was a dead
// duplicate: nothing imported it.
//
// Note for anyone pruning `@/features/mcp`: that record's Hooks tab imports the REAL `HooksView`
// from the mcp barrel and resolves it through the graph platform, so the export is load-bearing at
// runtime even though no FILE imports it any more. A file-import search will call it dead. It isn't.
import "./automations.css";

// Re-exported feature surface — this index is the automations feature's public API barrel (#1309).
export { AutomationsGraphHost } from "./AutomationsGraphHost"; // the graph-hosted workspace (#3642)
export { AutomationsStatus } from "./AutomationsStatus";
export { useScheduler } from "@/features/automations/useScheduler";

// #1545: public API for cross-feature consumers (tunnel).
export { type Automation, type AutomationWhen } from "./lib/scheduler";
export { isValidCron } from "./lib/cron";
export { dispatchAutomation } from "@/features/automations/lib/dispatch";
