// Minimal, dependency-free 5-field cron support for Automations (#171):
//   minute(0-59) hour(0-23) day-of-month(1-31) month(1-12) day-of-week(0-7, 0|7=Sun)
// Each field accepts `*`, single values, `a,b` lists, `a-b` ranges, and `*/n` /
// `a-b/n` / `a/n` steps. Day-of-month / day-of-week use the standard Vixie
// semantics: when both are restricted a date matches if EITHER matches.

interface CronFields {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  domRestricted: boolean;
  dowRestricted: boolean;
}

/** Parse one field into the set of allowed values, or null if malformed. */
function parseField(field: string, min: number, max: number): Set<number> | null {
  const out = new Set<number>();
  for (const part of field.split(",")) {
    if (part === "") return null;
    const slash = part.split("/");
    if (slash.length > 2) return null;
    let step = 1;
    if (slash.length === 2) {
      step = parseInt(slash[1], 10);
      if (!Number.isInteger(step) || step <= 0) return null;
    }
    const range = slash[0];

    let lo: number, hi: number;
    if (range === "*") {
      lo = min; hi = max;
    } else if (range.includes("-")) {
      const [a, b] = range.split("-");
      lo = parseInt(a, 10); hi = parseInt(b, 10);
      if (!Number.isInteger(lo) || !Number.isInteger(hi)) return null;
    } else {
      lo = parseInt(range, 10);
      if (!Number.isInteger(lo)) return null;
      // `a/n` means from a, stepping, up to max; a bare `a` is just {a}.
      hi = step !== 1 ? max : lo;
    }
    if (lo < min || hi > max || lo > hi) return null;
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out.size ? out : null;
}

/** Parse a 5-field cron expression, or null if invalid. */
export function parseCron(expr: string): CronFields | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const minute = parseField(parts[0], 0, 59);
  const hour = parseField(parts[1], 0, 23);
  const dom = parseField(parts[2], 1, 31);
  const month = parseField(parts[3], 1, 12);
  const dowRaw = parseField(parts[4], 0, 7);
  if (!minute || !hour || !dom || !month || !dowRaw) return null;
  const dow = new Set<number>();
  for (const d of dowRaw) dow.add(d === 7 ? 0 : d); // 7 and 0 both mean Sunday
  return {
    minute, hour, dom, month, dow,
    domRestricted: parts[2] !== "*",
    dowRestricted: parts[4] !== "*",
  };
}

/** Whether a local Date (at minute resolution) matches the parsed fields. */
export function cronMatches(f: CronFields, d: Date): boolean {
  if (!f.minute.has(d.getMinutes())) return false;
  if (!f.hour.has(d.getHours())) return false;
  if (!f.month.has(d.getMonth() + 1)) return false;
  const domOk = f.dom.has(d.getDate());
  const dowOk = f.dow.has(d.getDay());
  if (f.domRestricted && f.dowRestricted) return domOk || dowOk;
  if (f.domRestricted) return domOk;
  if (f.dowRestricted) return dowOk;
  return true;
}

// Search horizon — ~4 years so leap-day-only expressions still resolve. The
// loop breaks on the first match, so this bound only matters for never-matching
// (but syntactically valid) expressions, which then return null.
const CAP_MINUTES = 366 * 4 * 1440;

/** Epoch ms of the next minute strictly after `fromMs` that matches, or null. */
export function nextCronRun(expr: string, fromMs: number): number | null {
  const f = parseCron(expr);
  if (!f) return null;
  let t = Math.floor(fromMs / 60000) * 60000 + 60000;
  for (let i = 0; i < CAP_MINUTES; i++) {
    if (cronMatches(f, new Date(t))) return t;
    t += 60000;
  }
  return null;
}

/** Cheap validity check for UI feedback. */
export function isValidCron(expr: string): boolean {
  return parseCron(expr) !== null;
}
