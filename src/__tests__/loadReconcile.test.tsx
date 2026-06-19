// ls-reconcile-ui: RTL tests for LoadReconcile.tsx (#ls-reconcile-ui).
//
// Tests the lineage view, quality-gate failure path, and verify-load flow.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store";
import { LoadReconcile, runQualityGate, type ReconcileResponse } from "../screens/projects/LoadReconcile";
import type { DataModel } from "../screens/projects/dataModel";

const mockInvoke = vi.mocked(invoke);

// ── Fixtures ──────────────────────────────────────────────────────────────────

const MODEL: DataModel = {
  id: "dm-crm",
  name: "CRM",
  version: 1,
  entities: [
    {
      key: "account",
      label: "Account",
      identity: ["id"],
      fields: [
        { key: "id", type: "string", required: true },
        { key: "name", type: "string", required: true },
        { key: "email", type: "string", validate: "email" },
      ],
    },
  ],
};

function record(id: string, values: Record<string, string>, overrideLineage?: Record<string, { source: string; loaded_at: string; license: string }>): ReconcileResponse["records"][number] {
  const defaultLineage: Record<string, { source: string; loaded_at: string; license: string }> = {};
  for (const k of Object.keys(values)) {
    defaultLineage[k] = { source: "crm", loaded_at: "2026-06-18T00:00:00Z", license: "internal" };
  }
  return { identity: id, values, lineage: overrideLineage ?? defaultLineage };
}

const CLEAN_RESPONSE: ReconcileResponse = {
  entity: "account",
  records: [
    record("1", { id: "1", name: "Acme", email: "info@acme.com" }),
    record("2", { id: "2", name: "Globex", email: "contact@globex.com" }),
  ],
  conflicts: 0,
  source_precedence: ["crm", "directory"],
};

const BAD_EMAIL_RESPONSE: ReconcileResponse = {
  entity: "account",
  records: [
    record("1", { id: "1", name: "Acme", email: "not-an-email" }),
    record("2", { id: "2", name: "Globex", email: "good@example.com" }),
  ],
  conflicts: 0,
  source_precedence: ["crm"],
};

// ── Pure quality gate tests ───────────────────────────────────────────────────

describe("runQualityGate", () => {
  const entity = MODEL.entities[0];

  it("passes all records when no validate rules fail", () => {
    const gate = runQualityGate(CLEAN_RESPONSE.records, entity);
    expect(gate.clean).toHaveLength(2);
    expect(gate.quarantine).toHaveLength(0);
  });

  it("quarantines records where a validate rule fails", () => {
    const gate = runQualityGate(BAD_EMAIL_RESPONSE.records, entity);
    expect(gate.clean).toHaveLength(1);
    expect(gate.quarantine).toHaveLength(1);
    expect(gate.quarantine[0].record.identity).toBe("1");
    expect(gate.quarantine[0].failures[0]).toMatchObject({ field: "email", rule: "email" });
  });

  it("passes a record with an empty value for a validated field (empty is not a rule failure)", () => {
    // Only fields WITH a value that fails the rule are quarantined; an empty value
    // means the field was absent from the source — not a format violation.
    const rec = record("1", { id: "1", name: "Acme", email: "" });
    const gate = runQualityGate([rec], entity);
    expect(gate.quarantine).toHaveLength(0);
  });

  it("an entity with no validate rules never quarantines", () => {
    const noValidate: DataModel["entities"][0] = {
      key: "x", label: "X", identity: ["id"],
      fields: [{ key: "id", type: "string" }, { key: "val", type: "string" }],
    };
    const rec = record("1", { id: "1", val: "anything" });
    const gate = runQualityGate([rec], noValidate);
    expect(gate.clean).toHaveLength(1);
    expect(gate.quarantine).toHaveLength(0);
  });
});

// ── RTL component tests ───────────────────────────────────────────────────────

describe("LoadReconcile component (#ls-reconcile-ui)", () => {
  beforeEach(() => {
    useAppStore.setState({ loadVerified: {} });
    mockInvoke.mockReset();
  });

  it("renders the entity header and Load button in idle state", () => {
    render(<LoadReconcile projectKey="proj" model={MODEL} entityKey="account" />);
    expect(screen.getByText("Account")).toBeTruthy();
    expect(screen.getByText("Load & Reconcile")).toBeTruthy();
  });

  it("shows 'entity not found' when entityKey is unknown", () => {
    render(<LoadReconcile projectKey="proj" model={MODEL} entityKey="ghost" />);
    expect(screen.getByText(/ghost/)).toBeTruthy();
  });

  it("shows reconciled records with per-field lineage attribution after load", async () => {
    mockInvoke.mockResolvedValueOnce(CLEAN_RESPONSE);

    render(<LoadReconcile projectKey="proj" model={MODEL} entityKey="account" />);
    fireEvent.click(screen.getByText("Load & Reconcile"));

    await waitFor(() => expect(screen.getByRole("table", { name: "Reconciled records" })).toBeTruthy());

    // Records are visible
    expect(screen.getByText("Acme")).toBeTruthy();
    expect(screen.getByText("Globex")).toBeTruthy();

    // Lineage attribution is rendered via title attribute on the source badges
    const sourceBadges = document.querySelectorAll("[title*='source: crm']");
    expect(sourceBadges.length).toBeGreaterThan(0);
  });

  it("shows source precedence in the summary bar", async () => {
    mockInvoke.mockResolvedValueOnce(CLEAN_RESPONSE);

    render(<LoadReconcile projectKey="proj" model={MODEL} entityKey="account" />);
    fireEvent.click(screen.getByText("Load & Reconcile"));

    await waitFor(() => screen.getByText(/Precedence/));
    expect(screen.getByText(/crm.*directory/)).toBeTruthy();
  });

  it("quarantines records with bad email and hides Verify load", async () => {
    mockInvoke.mockResolvedValueOnce(BAD_EMAIL_RESPONSE);

    render(<LoadReconcile projectKey="proj" model={MODEL} entityKey="account" />);
    fireEvent.click(screen.getByText("Load & Reconcile"));

    await waitFor(() => screen.getByRole("region", { name: "Quarantine" }));

    expect(screen.queryByRole("button", { name: "Verify load" })).toBeNull();
    expect(screen.getByText(/1 record failed quality gate/i)).toBeTruthy();
  });

  it("shows Verify load when all records pass and clicking it sets loadVerified", async () => {
    mockInvoke.mockResolvedValueOnce(CLEAN_RESPONSE);

    render(<LoadReconcile projectKey="proj-key" model={MODEL} entityKey="account" />);
    fireEvent.click(screen.getByText("Load & Reconcile"));

    await waitFor(() => screen.getByRole("button", { name: "Verify load" }));

    fireEvent.click(screen.getByRole("button", { name: "Verify load" }));

    const verified = useAppStore.getState().loadVerified["proj-key"]?.["account"];
    expect(verified).toBe(true);
  });

  it("shows Verified badge and hides Verify load button after verification", async () => {
    useAppStore.setState({ loadVerified: { "proj": { account: true } } });
    render(<LoadReconcile projectKey="proj" model={MODEL} entityKey="account" />);

    expect(screen.getByLabelText("Load verified")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Verify load" })).toBeNull();
  });

  it("shows an error when the backend rejects", async () => {
    mockInvoke.mockRejectedValueOnce(new Error("command not found: data_load_reconciled"));

    render(<LoadReconcile projectKey="proj" model={MODEL} entityKey="account" />);
    fireEvent.click(screen.getByText("Load & Reconcile"));

    await waitFor(() => screen.getByRole("alert"));
    expect(screen.getByRole("alert").textContent).toContain("data_load_reconciled");
  });

  it("re-running load after an error resets to loading state", async () => {
    mockInvoke
      .mockRejectedValueOnce(new Error("network failure"))
      .mockResolvedValueOnce(CLEAN_RESPONSE);

    render(<LoadReconcile projectKey="proj" model={MODEL} entityKey="account" />);
    fireEvent.click(screen.getByText("Load & Reconcile"));
    await waitFor(() => screen.getByRole("alert"));

    // Run again — should succeed
    fireEvent.click(screen.getByText("Load & Reconcile"));
    await waitFor(() => screen.getByRole("button", { name: "Verify load" }));
  });
});
