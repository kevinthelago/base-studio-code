import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ScanViews } from "./ScanViews";
import type { SourceConfig } from "../shared/sourceConfig";

// A two-source scanned config: Salesforce (Account, Contact→Account) + Quickbase (Project→Account),
// with business processes, an automation, and a formula — exercises all three views.
const cfg: SourceConfig = {
  dataModelName: "Acme Core", proposed: [],
  sources: [
    {
      uid: "a", connectorId: "salesforce", status: "scanned", fields: {},
      objects: [
        { name: "Account", count: 12431, fields: ["domain", "name"] },
        { name: "Contact", count: 28902, fields: ["email", "account"] },
      ],
      platform: {
        automations: [{ source: "salesforce", kind: "validation", name: "Acct type", object: "Account", active: true, trigger: "onSave", condition: "ISBLANK(Type)", actions: ["reject"] }],
        businessProcesses: [{ source: "salesforce", name: "Discount Approval", object: "Opportunity", active: true, steps: ["Submitted", "Approved"] }],
        derivedLogic: [],
      },
    },
    {
      uid: "b", connectorId: "quickbase", status: "scanned", fields: {},
      objects: [{ name: "Project", count: 1884, fields: ["id", "account"] }],
      platform: { automations: [], businessProcesses: [], derivedLogic: [{ source: "quickbase", kind: "formula", name: "spend_pct", object: "Project", expression: "[Spent]/[Budget]" }] },
    },
  ],
};

describe("ScanViews — graph / list / process", () => {
  it("renders the recap header and defaults to the graph with entity nodes", () => {
    render(<ScanViews cfg={cfg} dataModelName="Acme Core" />);
    expect(screen.getByTestId("scan-views")).toBeTruthy();
    expect(screen.getByTestId("scan-views").textContent).toMatch(/seeds .* into features/i);
    // Graph is the default for a small model — entity nodes are present.
    expect(screen.getByTestId("scan-node-account")).toBeTruthy();
    expect(screen.getByTestId("scan-node-contact")).toBeTruthy();
    expect(screen.getByTestId("scan-node-project")).toBeTruthy();
  });

  it("toggles to the list view", () => {
    render(<ScanViews cfg={cfg} dataModelName="Acme Core" />);
    fireEvent.click(screen.getByTestId("scan-view-list"));
    expect(screen.getByTestId("scan-list-account")).toBeTruthy();
  });

  it("toggles to the process view and shows processes, automations, and derived logic", () => {
    render(<ScanViews cfg={cfg} dataModelName="Acme Core" />);
    fireEvent.click(screen.getByTestId("scan-view-process"));
    expect(screen.getByText("Discount Approval")).toBeTruthy(); // business process
    expect(screen.getByText("Acct type")).toBeTruthy();         // automation
    expect(screen.getByText("spend_pct")).toBeTruthy();         // derived logic
    expect(screen.queryByText(/legacy/i)).toBeNull();           // no Process Builder ⇒ no legacy flag
  });
});
