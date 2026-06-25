// <data_model> tag parser (#se-persist), split out of Planning.tsx (#1332).
// The planner emits <data_model>{"name":"...","entities":[...]}</data_model> to hand
// off an inferred canonical schema. Pure functions — unit-tested in isolation.
import type { DataModel } from "@/features/planner/data/dataModel";

/** Extract and JSON-parse the first <data_model> tag content. Returns null on missing or malformed JSON. */
export function parseDataModelTag(buf: string): DataModel | null {
  const m = /<data_model>([\s\S]*?)<\/data_model>/.exec(buf);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[1].trim()) as unknown;
    if (
      parsed !== null && typeof parsed === "object" &&
      "name" in (parsed as object) && "entities" in (parsed as object)
    ) {
      return parsed as DataModel;
    }
    return null;
  } catch {
    return null;
  }
}

/** Strip all <data_model>…</data_model> tags from a buffer. */
export function stripDataModelTags(buf: string): string {
  return buf.replace(/<data_model>[\s\S]*?<\/data_model>/g, "");
}
