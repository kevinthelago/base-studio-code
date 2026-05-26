import { describe, it, expect } from "vitest";
import {
  findCurrentIteration,
  computeBurndown,
  parseProjectIteration,
  type BurndownIteration,
  type BurndownItem,
} from "../screens/projects/burndown";

const NOW = new Date("2026-01-08T12:00:00").getTime(); // day 7 of an iteration starting 2026-01-01

const iters: BurndownIteration[] = [
  { id: "i1", title: "Sprint 1", startDate: "2025-12-18", duration: 14 }, // ends 2026-01-01
  { id: "i2", title: "Sprint 2", startDate: "2026-01-01", duration: 14 }, // contains NOW
  { id: "i3", title: "Sprint 3", startDate: "2026-01-15", duration: 14 },
];

describe("findCurrentIteration", () => {
  it("returns the iteration whose window contains now", () => {
    expect(findCurrentIteration(iters, NOW)?.id).toBe("i2");
  });

  it("returns null when today is in a break / outside all iterations", () => {
    const gap = [
      { id: "a", title: "A", startDate: "2026-01-01", duration: 5 },  // ends 2026-01-06
      { id: "b", title: "B", startDate: "2026-01-12", duration: 5 },  // starts after NOW
    ];
    expect(findCurrentIteration(gap, NOW)).toBeNull();
  });
});

describe("computeBurndown", () => {
  const iter = iters[1]; // Sprint 2, start 2026-01-01, 14 days
  const items: BurndownItem[] = [
    { closedAt: "2026-01-02T10:00:00", done: true },
    { closedAt: "2026-01-03T10:00:00", done: true },
    { closedAt: "2026-01-05T10:00:00", done: true },
    ...Array.from({ length: 7 }, () => ({ closedAt: null, done: false }) as BurndownItem),
  ]; // total 10, 3 done

  const s = computeBurndown(iter, items, NOW);

  it("reports totals, remaining, and elapsed/total days", () => {
    expect(s.total).toBe(10);
    expect(s.remaining).toBe(7);
    expect(s.daysTotal).toBe(14);
    expect(s.daysElapsed).toBe(7);
  });

  it("draws an ideal line from total to 0", () => {
    expect(s.ideal[0]).toBe(10);
    expect(s.ideal[7]).toBe(5);
    expect(s.ideal[14]).toBe(0);
  });

  it("reconstructs the actual line from close timestamps, null after today", () => {
    expect(s.actual[0]).toBe(10);     // nothing closed by end of day 0
    expect(s.actual[1]).toBe(9);      // 01-02 close counted
    expect(s.actual[2]).toBe(8);      // 01-02 + 01-03
    expect(s.actual[7]).toBe(7);      // today anchored to live remaining
    expect(s.actual[14]).toBeNull();  // beyond today
  });

  it("flags off-track when remaining is above the ideal at today", () => {
    expect(s.onTrack).toBe(false); // remaining 7 > ideal 5
    const ahead = computeBurndown(iter, items.slice(0, 6).concat(items.slice(6).map(() => ({ closedAt: "2026-01-04T10:00:00", done: true }))), NOW);
    expect(ahead.onTrack).toBe(true);
  });
});

describe("parseProjectIteration", () => {
  const node = {
    title: "My Project",
    fields: {
      nodes: [
        { __typename: "ProjectV2IterationField", name: "Sprint", configuration: { iterations: [iters[1]] } },
        { __typename: "ProjectV2SingleSelectField", name: "Status", options: [{ id: "o1", name: "Todo" }, { id: "o2", name: "Done" }] },
      ],
    },
    items: {
      nodes: [
        // in Sprint 2, marked Done via Status (still open)
        { content: { closed: false, closedAt: null }, fieldValues: { nodes: [
          { __typename: "ProjectV2ItemFieldIterationValue", iterationId: "i2", field: { name: "Sprint" } },
          { __typename: "ProjectV2ItemFieldSingleSelectValue", name: "Done", field: { name: "Status" } },
        ] } },
        // in Sprint 2, Todo
        { content: { closed: false, closedAt: null }, fieldValues: { nodes: [
          { __typename: "ProjectV2ItemFieldIterationValue", iterationId: "i2", field: { name: "Sprint" } },
          { __typename: "ProjectV2ItemFieldSingleSelectValue", name: "Todo", field: { name: "Status" } },
        ] } },
        // in Sprint 2, closed issue
        { content: { closed: true, closedAt: "2026-01-03T10:00:00" }, fieldValues: { nodes: [
          { __typename: "ProjectV2ItemFieldIterationValue", iterationId: "i2", field: { name: "Sprint" } },
        ] } },
        // a DIFFERENT iteration — excluded from scope
        { content: { closed: false, closedAt: null }, fieldValues: { nodes: [
          { __typename: "ProjectV2ItemFieldIterationValue", iterationId: "iX", field: { name: "Sprint" } },
        ] } },
        // unassigned — excluded
        { content: { closed: false, closedAt: null }, fieldValues: { nodes: [] } },
      ],
    },
  };

  it("scopes items to the current iteration and computes the series", () => {
    const r = parseProjectIteration(node, NOW);
    expect(r.status).toBe("ready");
    if (r.status === "ready") {
      expect(r.projectTitle).toBe("My Project");
      expect(r.iterationTitle).toBe("Sprint 2");
      expect(r.series.total).toBe(3);     // 3 items in Sprint 2
      expect(r.series.remaining).toBe(1); // Done(status) + closed = 2 done, 1 left
    }
  });

  it("returns no-field when the project has no Iteration field", () => {
    expect(parseProjectIteration({ title: "X", fields: { nodes: [] } }, NOW)).toEqual({ status: "no-field" });
    expect(parseProjectIteration(null, NOW)).toEqual({ status: "no-field" });
  });

  it("returns no-active-iteration when today isn't inside any iteration", () => {
    const past = { title: "Old", fields: { nodes: [
      { __typename: "ProjectV2IterationField", name: "Sprint", configuration: { iterations: [iters[0]] } },
    ] } };
    expect(parseProjectIteration(past, NOW)).toEqual({ status: "no-active-iteration", projectTitle: "Old" });
  });
});
