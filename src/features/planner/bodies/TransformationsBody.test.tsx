import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store";
import { verbMeta, type TransformationRow } from "../lib/transformations";
import { TransformationsBody } from "./TransformationsBody";

const PID = "p-transforms";

const row = (over: Partial<TransformationRow> = {}): TransformationRow => ({
  id: over.id ?? "t-x",
  verb: "extract",
  title: "Extract the shared button",
  target: { description: "4 bespoke buttons across the app", files: ["src/a.tsx", "src/b.tsx"] },
  delta: "bespoke buttons → one shared <Button>",
  invariants: ["existing tests pass", "click targets unchanged"],
  owns: ["src/shared/ui/**"],
  tier: 0,
  ...over,
});

beforeEach(() => {
  useAppStore.setState({ planTransformations: {} });
  vi.mocked(invoke).mockClear();
  vi.mocked(invoke).mockResolvedValue(null);
});

describe("TransformationsBody — empty state", () => {
  it("shows the planner-decomposes hint when no rows exist", () => {
    render(<TransformationsBody projectId={PID} />);
    expect(screen.getByText("No transformations yet")).toBeTruthy();
    expect(screen.getByText(/bsc plan transformation add/)).toBeTruthy();
  });
});

describe("TransformationsBody — the bottom-up confirm queue", () => {
  it("locks tier 1 (collapsed, 'confirm tier 0 first') while tier 0 has pending rows", () => {
    useAppStore.getState().setPlanTransformations(PID, [
      row({ id: "prim", tier: 0 }),
      row({ id: "comp", tier: 1, title: "Compose the toolbar" }),
    ]);
    render(<TransformationsBody projectId={PID} />);

    // Tier 0 is the current tier: its item is actionable.
    expect(screen.getByText("Tier 0 · primitives")).toBeTruthy();
    expect(screen.getByTestId("transformation-confirm-prim")).toBeTruthy();
    // Tier 1 is locked: collapsed (no item card, no confirm) with the unlock hint.
    expect(screen.getByText("Tier 1 · pages")).toBeTruthy();
    expect(screen.getByText("confirm tier 0 first")).toBeTruthy();
    expect(screen.queryByTestId("transformation-comp")).toBeNull();
    expect(screen.queryByTestId("transformation-confirm-comp")).toBeNull();
    // No completion card while anything is pending.
    expect(screen.queryByTestId("transformations-complete")).toBeNull();
  });

  it("confirming a tier unlocks the next (tier 0 confirmed → tier 1 actionable)", () => {
    useAppStore.getState().setPlanTransformations(PID, [
      row({ id: "prim", tier: 0, confirmed: true }),
      row({ id: "comp", tier: 1 }),
    ]);
    render(<TransformationsBody projectId={PID} />);
    expect(screen.getByTestId("transformation-comp")).toBeTruthy();
    expect(screen.getByTestId("transformation-confirm-comp")).toBeTruthy();
  });

  it("Confirm fires the exact bsc args and flips the row optimistically", () => {
    useAppStore.getState().setPlanTransformations(PID, [row({ id: "prim", tier: 0 })]);
    render(<TransformationsBody projectId={PID} />);

    fireEvent.click(screen.getByTestId("transformation-confirm-prim"));

    // The generic bsc bridge call, verbatim (#2509 contract).
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("bsc", {
      projectKey: PID,
      args: ["plan", "transformation", "confirm", "prim"],
    });
    // Optimistic local flip — the store row is confirmed before the poll reflects plan.db.
    expect(useAppStore.getState().planTransformations[PID][0].confirmed).toBe(true);
  });

  it("shows the Completed UI card only when every row is confirmed (no confirm machinery on it)", () => {
    useAppStore.getState().setPlanTransformations(PID, [
      row({ id: "prim", tier: 0, confirmed: true }),
      row({ id: "comp", tier: 1, confirmed: true }),
    ]);
    render(<TransformationsBody projectId={PID} />);
    expect(screen.getByTestId("transformations-complete")).toBeTruthy();
    expect(screen.getByText("Completed UI")).toBeTruthy();
    // No pending action anywhere — sign-off is the NORMAL stage confirm in the footer.
    expect(screen.queryByText("Confirm")).toBeNull();
  });

  it("renders NO reject/exclude affordance — only Confirm plus the describe-to-the-planner hint", () => {
    useAppStore.getState().setPlanTransformations(PID, [row({ id: "prim", tier: 0 })]);
    render(<TransformationsBody projectId={PID} />);
    expect(screen.queryByText(/reject/i)).toBeNull();
    expect(screen.queryByText(/exclude/i)).toBeNull();
    expect(screen.getByText(/Describe them to the planner/)).toBeTruthy();
  });
});

describe("TransformationsBody — item presentation", () => {
  it("shows verb, provenance (recipe + evidence count) and the kit-contribution badge", () => {
    useAppStore.getState().setPlanTransformations(PID, [
      row({
        id: "prim", tier: 0, kitContribution: true,
        provenance: { recipe: "migrate-to-kit", evidence: ["src/a.tsx", "src/b.tsx", "src/c.tsx"] },
      }),
    ]);
    render(<TransformationsBody projectId={PID} />);
    expect(screen.getByText("extract")).toBeTruthy();
    expect(screen.getByText(/recipe: migrate-to-kit · 3 evidence/)).toBeTruthy();
    expect(screen.getByText("kit contribution")).toBeTruthy();
    // Target / delta / invariants / owns all present.
    expect(screen.getByText("4 bespoke buttons across the app")).toBeTruthy();
    expect(screen.getByText(/bespoke buttons → one shared/)).toBeTruthy();
    expect(screen.getByText("existing tests pass")).toBeTruthy();
    expect(screen.getByText(/owns src\/shared\/ui/)).toBeTruthy();
  });

  it("verb chips carry the taxonomy blurb as a tooltip (#2509 slice b — verb metadata is @data)", () => {
    useAppStore.getState().setPlanTransformations(PID, [row({ id: "prim", tier: 0 })]);
    render(<TransformationsBody projectId={PID} />);
    const blurb = verbMeta("extract").blurb;
    expect(blurb.length).toBeGreaterThan(0);
    expect(screen.getByText("extract").getAttribute("title")).toBe(blurb);
  });

  it("omits the kit-contribution badge when the row is not a kit contribution", () => {
    useAppStore.getState().setPlanTransformations(PID, [row({ id: "prim", tier: 0 })]);
    render(<TransformationsBody projectId={PID} />);
    expect(screen.queryByText("kit contribution")).toBeNull();
  });
});

describe("TransformationsBody — live spec render (#1852 KitRenderer)", () => {
  it("renders a valid KitNode spec live through the renderer", () => {
    useAppStore.getState().setPlanTransformations(PID, [
      row({ id: "prim", tier: 0, spec: { kind: "tag", label: "live-preview-chip" } }),
    ]);
    render(<TransformationsBody projectId={PID} />);
    expect(screen.getByTestId("transformation-spec-prim")).toBeTruthy();
    expect(screen.getByText("live-preview-chip")).toBeTruthy();
    expect(screen.queryByTestId("transformation-spec-fallback-prim")).toBeNull();
  });

  it("falls back to the 'spec present (n nodes)' chip on an invalid spec — never a crash", () => {
    useAppStore.getState().setPlanTransformations(PID, [
      row({ id: "prim", tier: 0, spec: { kind: "not-a-kind", children: [{ kind: "tag", label: "x" }] } }),
    ]);
    render(<TransformationsBody projectId={PID} />);
    expect(screen.getByTestId("transformation-spec-fallback-prim")).toBeTruthy();
    expect(screen.getByText(/spec present \(2 nodes\)/)).toBeTruthy();
    expect(screen.queryByTestId("transformation-spec-prim")).toBeNull();
  });

  it("frames a kitContribution row's preview as a Proposed component (#2509 slice d)", () => {
    useAppStore.getState().setPlanTransformations(PID, [
      row({ id: "gap", tier: 0, kitContribution: true, spec: { kind: "tag", label: "sketch-chip" } }),
    ]);
    render(<TransformationsBody projectId={PID} />);
    // The proposed-component caption sits above the live preview.
    expect(screen.getByTestId("transformation-proposed-gap")).toBeTruthy();
    expect(screen.getByText("Proposed component")).toBeTruthy();
    expect(screen.getByTestId("transformation-spec-gap")).toBeTruthy();
  });

  it("a plain migration row (not a kit contribution) shows no Proposed-component framing", () => {
    useAppStore.getState().setPlanTransformations(PID, [
      row({ id: "mig", tier: 0, kitContribution: false, spec: { kind: "tag", label: "target-chip" } }),
    ]);
    render(<TransformationsBody projectId={PID} />);
    expect(screen.queryByTestId("transformation-proposed-mig")).toBeNull();
    expect(screen.queryByText("Proposed component")).toBeNull();
    // The preview still renders — just without the proposal caption.
    expect(screen.getByTestId("transformation-spec-mig")).toBeTruthy();
  });
});
