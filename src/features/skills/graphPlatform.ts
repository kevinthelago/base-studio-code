// The skills feature's graph-platform surface (#3654, epic #3604) — the feature-internal modules a
// graph-loaded Skills page imports but does NOT redraw: the pure skills domain logic (defs/filter/telemetry/
// lessons) + the shared style helper. Registered HERE, inside the feature, because the shell must not reach
// a feature's internals (#1545). The skills host calls this synchronously before the graph page loads.
// Mirrors the fleet/automations/security/github graph-platforms.
import { registerAppModule } from "@/shared/lib/runtime/moduleRegistry";
import * as Skills from "@/features/skills/lib/skills";
import * as SkillsFilter from "@/features/skills/lib/skillsFilter";
import * as SkillTelemetry from "@/features/skills/lib/skillTelemetry";
import * as Lessons from "@/features/skills/lib/lessons";
import * as SkillStyles from "@/features/skills/skillStyles";
import * as GraphPlatform from "@/features/skills/graphPlatform";

let done = false;

/** Register the skills page's injected graph-platform modules by the specifiers it imports. Idempotent. */
export function registerSkillsPlatform(): void {
  if (done) return;
  done = true;
  registerAppModule("@/features/skills/lib/skills", Skills);
  registerAppModule("@/features/skills/lib/skillsFilter", SkillsFilter);
  registerAppModule("@/features/skills/lib/skillTelemetry", SkillTelemetry);
  registerAppModule("@/features/skills/lib/lessons", Lessons);
  registerAppModule("@/features/skills/skillStyles", SkillStyles);
  registerAppModule("@/features/skills/graphPlatform", GraphPlatform);
}
