import { describe, it, expect } from "vitest";
import type { AnalyticsEvent, PropSpec } from "./model";
import {
  eventNameForProp,
  resolveAnalyticsEmit,
  usageRecordArgs,
  makeAnalyticsEmit,
  componentAnalyticsLookup,
  collectingSink,
} from "./analyticsEmit";

/** A minimal PropSpec — only `name` matters to the runtime; the rest satisfy the type. */
const prop = (name: string): PropSpec => ({ name, type: "string", req: false, desc: "" });

describe("eventNameForProp — action prop → declared event name", () => {
  it("strips `on` and camel→snake-cases", () => {
    expect(eventNameForProp("onClick")).toBe("click");
    expect(eventNameForProp("onItemSelected")).toBe("item_selected");
    expect(eventNameForProp("onFilterChanged")).toBe("filter_changed");
    expect(eventNameForProp("onChange")).toBe("change");
  });

  it("returns undefined for a non-action prop", () => {
    expect(eventNameForProp("label")).toBeUndefined();
    expect(eventNameForProp("children")).toBeUndefined();
    expect(eventNameForProp("onclick")).toBeUndefined(); // not `on` + capital
    expect(eventNameForProp("on")).toBeUndefined();
  });
});

describe("resolveAnalyticsEmit — manifest is the authority", () => {
  const clickManifest: AnalyticsEvent[] = [{ event: "click", props: [prop("label")] }];

  it("returns undefined when the component has no manifest", () => {
    expect(resolveAnalyticsEmit(undefined, "onClick", [])).toBeUndefined();
    expect(resolveAnalyticsEmit([], "onClick", [])).toBeUndefined();
  });

  it("returns undefined for a non-action prop", () => {
    expect(resolveAnalyticsEmit(clickManifest, "label", ["x"])).toBeUndefined();
  });

  it("never invents an event the component did not declare", () => {
    // prop resolves to `change`, which this manifest does not declare → no emit.
    expect(resolveAnalyticsEmit(clickManifest, "onChange", [])).toBeUndefined();
  });

  it("resolves a declared event with an empty payload for a scalar arg", () => {
    expect(resolveAnalyticsEmit(clickManifest, "onClick", ["hello"])).toEqual({ event: "click", props: {} });
  });

  it("fills ONLY declared prop names from a plain object payload", () => {
    const manifest: AnalyticsEvent[] = [{ event: "item_selected", props: [prop("id")] }];
    const rec = resolveAnalyticsEmit(manifest, "onItemSelected", [{ id: "abc", extra: "ignored" }]);
    expect(rec).toEqual({ event: "item_selected", props: { id: "abc" } });
  });

  it("yields an empty payload when the declared prop is absent from the arg object", () => {
    const manifest: AnalyticsEvent[] = [{ event: "item_selected", props: [prop("id")] }];
    expect(resolveAnalyticsEmit(manifest, "onItemSelected", [{ other: 1 }])).toEqual({
      event: "item_selected",
      props: {},
    });
  });
});

describe("usageRecordArgs — the `bsc usage record` argv", () => {
  it("omits --props when the payload is empty", () => {
    expect(usageRecordArgs({ event: "click", props: {} })).toEqual(["usage", "record", "--event", "click"]);
  });

  it("serializes a non-empty payload as JSON", () => {
    expect(usageRecordArgs({ event: "item_selected", props: { id: "abc" } })).toEqual([
      "usage",
      "record",
      "--event",
      "item_selected",
      "--props",
      JSON.stringify({ id: "abc" }),
    ]);
  });
});

describe("makeAnalyticsEmit + lookup — the composed hook", () => {
  it("records only fires that resolve to a declared event", () => {
    const lookup = componentAnalyticsLookup([
      { name: "Button", analytics: [{ event: "click", props: [prop("label")] }] },
      { name: "Divider" }, // no manifest
    ]);
    const sink = collectingSink();
    const emit = makeAnalyticsEmit(lookup, sink);

    emit({ type: "Button", prop: "onClick", args: [{ label: "Go" }] }); // declared → recorded
    emit({ type: "Button", prop: "onHover", args: [] }); // not declared → skipped
    emit({ type: "Divider", prop: "onClick", args: [] }); // no manifest → skipped
    emit({ type: "Unknown", prop: "onClick", args: [] }); // unknown type → skipped

    expect(sink.records).toEqual([{ event: "click", props: { label: "Go" } }]);
  });
});
