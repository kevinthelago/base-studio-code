import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { CatalogView } from "../screens/projects/BlueprintCatalogView";
import { NewBlueprintModal, PublishModal, ImportModal, PreviewModal, type PreviewBlueprint } from "../screens/projects/BlueprintModals";
import { CATALOG } from "../screens/projects/blueprintCatalog";
import { mkStageSection } from "../screens/projects/blueprintEdit";
import type { Blueprint } from "../screens/projects/blueprints";

const noop = () => {};

describe("CatalogView (#609 slice 5)", () => {
  it("lists catalog entries and filters by search", () => {
    render(<CatalogView forkedIds={[]} onFork={noop} onPreview={noop} onBack={noop} onManualImport={noop} />);
    expect(screen.getByText("Rust CLI tool")).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText(/search blueprints/i), { target: { value: "saas" } });
    expect(screen.getByText("B2B SaaS starter")).toBeInTheDocument();
    expect(screen.queryByText("Rust CLI tool")).not.toBeInTheDocument();
  });

  it("forks an entry and shows ✓ for already-forked ones", () => {
    const onFork = vi.fn();
    render(<CatalogView forkedIds={["cat_rust"]} onFork={onFork} onPreview={noop} onBack={noop} onManualImport={noop} />);
    // the rust row is already forked → its button is disabled and labelled ✓
    expect(screen.getByRole("button", { name: /✓ Forked/i })).toBeDisabled();
    // fork a different one
    const saasRow = screen.getByText("B2B SaaS starter").closest(".cat-row") as HTMLElement;
    fireEvent.click(within(saasRow).getByRole("button", { name: /Fork/i }));
    expect(onFork).toHaveBeenCalledWith(expect.objectContaining({ id: "cat_saas" }));
  });

  it("sort by name reorders", () => {
    render(<CatalogView forkedIds={[]} onFork={noop} onPreview={noop} onBack={noop} onManualImport={noop} />);
    fireEvent.click(screen.getByRole("button", { name: /^name$/i }));
    const names = screen.getAllByText(/.*/, { selector: ".cat-row .cname" }).map((n) => n.textContent);
    expect(names[0]!.startsWith("B2B")).toBe(true); // alphabetical
  });
});

describe("NewBlueprintModal (#609)", () => {
  it("creates with the chosen mode", () => {
    const onCreate = vi.fn(); const onClaude = vi.fn();
    render(<NewBlueprintModal onClose={noop} onCreate={onCreate} onDesignWithClaude={onClaude} />);
    fireEvent.change(screen.getByPlaceholderText(/Internal tool/i), { target: { value: "My BP" } });
    fireEvent.click(screen.getByText("Default stages"));
    fireEvent.click(screen.getByRole("button", { name: /Create blueprint/i }));
    expect(onCreate).toHaveBeenCalledWith("My BP", "default");
  });

  it("routes to Claude when that mode is picked", () => {
    const onCreate = vi.fn(); const onClaude = vi.fn();
    render(<NewBlueprintModal onClose={noop} onCreate={onCreate} onDesignWithClaude={onClaude} />);
    fireEvent.change(screen.getByPlaceholderText(/Internal tool/i), { target: { value: "AI BP" } });
    fireEvent.click(screen.getByText("Design with Claude"));
    fireEvent.click(screen.getByRole("button", { name: /Design with Claude →/i }));
    expect(onClaude).toHaveBeenCalledWith("AI BP");
  });
});

describe("PublishModal (#609)", () => {
  const bp: Blueprint = { id: "b", name: "Web", desc: "d", icon: "W", h: 230, sections: [mkStageSection("context")] };
  it("runs the async publish then surfaces the link", async () => {
    const onPublish = vi.fn(async () => ({ url: "gist.github.com/you/abc", id: "abc", rev: "r1" }));
    const onPublished = vi.fn();
    render(<PublishModal bp={bp} onClose={noop} onPublish={onPublish} onPublished={onPublished} />);
    fireEvent.click(screen.getByRole("button", { name: /Publish gist/i }));
    await waitFor(() => expect(screen.getByText("gist.github.com/you/abc")).toBeInTheDocument());
    expect(onPublish).toHaveBeenCalledWith(true); // default public
    fireEvent.click(screen.getByRole("button", { name: /Done/i }));
    expect(onPublished).toHaveBeenCalledWith(expect.objectContaining({ id: "abc", public: true }));
  });
});

describe("ImportModal (#609)", () => {
  it("resolves a gist ref to a preview then imports", async () => {
    const preview: PreviewBlueprint = { name: "Imported", icon: "I", h: 70, author: "x", rev: "r2", sections: [mkStageSection("context"), mkStageSection("stack")] };
    const onResolve = vi.fn(async () => preview);
    const onImport = vi.fn();
    render(<ImportModal onClose={noop} onResolve={onResolve} onImport={onImport} />);
    fireEvent.change(screen.getByPlaceholderText(/gist.github.com/i), { target: { value: "abc123" } });
    fireEvent.click(screen.getByRole("button", { name: /Resolve gist/i }));
    await waitFor(() => expect(screen.getByText("Imported")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /Import to library/i }));
    expect(onImport).toHaveBeenCalledWith(preview);
  });
});

describe("PreviewModal (#609)", () => {
  it("synthesizes a stage flow and forks", () => {
    const onFork = vi.fn();
    render(<PreviewModal cat={CATALOG[0]} forked={false} onClose={noop} onFork={onFork} />);
    expect(screen.getByText("Stage flow")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Fork to my library/i }));
    expect(onFork).toHaveBeenCalledWith(CATALOG[0]);
  });
});
