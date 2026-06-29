import { describe, it, expect } from "vitest";
import { useState } from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { usePromptDialog, useConfirmDialog, type PromptOpts, type ConfirmOpts } from "./promptDialog";

function PromptHarness({ opts }: { opts?: Partial<PromptOpts> }) {
  const { prompt, dialog } = usePromptDialog();
  const [result, setResult] = useState<string | null | "pending">("pending");
  return (
    <div>
      <button onClick={() => { setResult("pending"); void prompt({ title: "Prompt", ...opts }).then(setResult); }}>open</button>
      <div data-testid="result">{result === null ? "NULL" : result}</div>
      {dialog}
    </div>
  );
}

function ConfirmHarness({ opts }: { opts?: Partial<ConfirmOpts> }) {
  const { confirm, dialog } = useConfirmDialog();
  const [result, setResult] = useState<string>("pending");
  return (
    <div>
      <button onClick={() => { setResult("pending"); void confirm({ title: "Confirm", message: "Sure?", ...opts }).then((v) => setResult(String(v))); }}>open</button>
      <div data-testid="result">{result}</div>
      {dialog}
    </div>
  );
}

describe("usePromptDialog", () => {
  it("resolves with the typed value when confirmed", async () => {
    render(<PromptHarness opts={{ placeholder: "ph" }} />);
    fireEvent.click(screen.getByText("open"));
    fireEvent.change(screen.getByPlaceholderText("ph"), { target: { value: "cargo" } });
    fireEvent.click(screen.getByText("OK"));
    await waitFor(() => expect(screen.getByTestId("result")).toHaveTextContent("cargo"));
    // dialog closes after settling
    expect(screen.queryByPlaceholderText("ph")).toBeNull();
  });

  it("resolves null on Cancel", async () => {
    render(<PromptHarness />);
    fireEvent.click(screen.getByText("open"));
    fireEvent.click(screen.getByText("Cancel"));
    await waitFor(() => expect(screen.getByTestId("result")).toHaveTextContent("NULL"));
  });

  it("resolves null on Escape", async () => {
    render(<PromptHarness />);
    fireEvent.click(screen.getByText("open"));
    fireEvent.keyDown(document.body, { key: "Escape" });
    await waitFor(() => expect(screen.getByTestId("result")).toHaveTextContent("NULL"));
  });

  it("disables confirm and ignores Enter while the value is empty (default)", async () => {
    render(<PromptHarness />);
    fireEvent.click(screen.getByText("open"));
    const ok = screen.getByText("OK") as HTMLButtonElement;
    expect(ok).toBeDisabled();
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" }); // no-op while empty
    expect(screen.getByTestId("result")).toHaveTextContent("pending");
    // dialog still open
    expect(screen.getByRole("textbox")).toBeTruthy();
  });

  it("allows an empty submit when allowEmpty is set", async () => {
    render(<PromptHarness opts={{ allowEmpty: true }} />);
    fireEvent.click(screen.getByText("open"));
    fireEvent.click(screen.getByText("OK"));
    await waitFor(() => expect(screen.getByTestId("result")).toHaveTextContent(/^$/));
  });

  it("submits on Enter once non-empty and honors a custom confirm label", async () => {
    render(<PromptHarness opts={{ confirmLabel: "Allow" }} />);
    fireEvent.click(screen.getByText("open"));
    expect(screen.getByText("Allow")).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "x" } });
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    await waitFor(() => expect(screen.getByTestId("result")).toHaveTextContent("x"));
  });
});

describe("useConfirmDialog", () => {
  it("resolves true when confirmed", async () => {
    render(<ConfirmHarness opts={{ confirmLabel: "Delete", danger: true }} />);
    fireEvent.click(screen.getByText("open"));
    fireEvent.click(screen.getByText("Delete"));
    await waitFor(() => expect(screen.getByTestId("result")).toHaveTextContent("true"));
  });

  it("resolves false on Cancel and on Escape", async () => {
    render(<ConfirmHarness />);
    fireEvent.click(screen.getByText("open"));
    fireEvent.click(screen.getByText("Cancel"));
    await waitFor(() => expect(screen.getByTestId("result")).toHaveTextContent("false"));

    fireEvent.click(screen.getByText("open"));
    fireEvent.keyDown(document.body, { key: "Escape" });
    await waitFor(() => expect(screen.getByTestId("result")).toHaveTextContent("false"));
  });
});
