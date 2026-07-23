import { useEffect, useState } from "react";
import { logsTail } from "@/shared/lib/core/logsBridge";
import { Box } from "@/shared/ui/layout/Box";
import { useAppStore } from "@/store";
import { parseSkillLog, aggregateSkillTelemetry, skillStatusKpis, type SkillStats } from "./lib/skillTelemetry";

/**
 * Live Skills KPIs for the app status bar (Skills page) — replaces the old hardcoded
 * `SKILL_KPIS` mock. Reads the real skill-usage telemetry (`bsc logs tail skill`, the same source
 * the Skills screen uses) plus the live library size.
 */
export function SkillsStatus() {
  const skillCount = useAppStore((s) => s.skills.length);
  const [stats, setStats] = useState<Record<string, SkillStats>>({});

  useEffect(() => {
    let cancelled = false;
    logsTail("skill", 4000)
      .then((lines) => {
        if (!cancelled) setStats(aggregateSkillTelemetry(parseSkillLog((lines ?? []).join("\n")), new Date()));
      });
    return () => { cancelled = true; };
  }, []);

  const { loaded, invToday, worst } = skillStatusKpis(skillCount, stats);
  return (
    <>
      <Box as="span" className="s"><i /> {loaded} {loaded === 1 ? "skill" : "skills"} loaded</Box>
      <Box as="span" className="s"><i /> {invToday} {invToday === 1 ? "invocation" : "invocations"} today</Box>
      {worst && <Box as="span" className="s"><i className="warn" /> {worst.skill} {worst.rate}%</Box>}
    </>
  );
}
