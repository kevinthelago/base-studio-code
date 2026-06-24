import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store";
import { parseSkillLog, aggregateSkillTelemetry, skillStatusKpis, type SkillStats } from "./lib/skillTelemetry";

/**
 * Live Skills KPIs for the app status bar (Skills page) — replaces the old hardcoded
 * `SKILL_KPIS` mock. Reads the real skill-usage telemetry (`read_skill_log`, the same source
 * the Skills screen uses) plus the live library size.
 */
export function SkillsStatus() {
  const skillCount = useAppStore((s) => s.skills.length);
  const [stats, setStats] = useState<Record<string, SkillStats>>({});

  useEffect(() => {
    let cancelled = false;
    invoke<string[]>("read_skill_log", { limit: 4000 })
      .then((lines) => {
        if (!cancelled) setStats(aggregateSkillTelemetry(parseSkillLog((lines ?? []).join("\n")), new Date()));
      })
      .catch(() => { if (!cancelled) setStats({}); });
    return () => { cancelled = true; };
  }, []);

  const { loaded, invToday, worst } = skillStatusKpis(skillCount, stats);
  return (
    <>
      <span className="s"><i /> {loaded} {loaded === 1 ? "skill" : "skills"} loaded</span>
      <span className="s"><i /> {invToday} {invToday === 1 ? "invocation" : "invocations"} today</span>
      {worst && <span className="s"><i className="warn" /> {worst.skill} {worst.rate}%</span>}
    </>
  );
}
