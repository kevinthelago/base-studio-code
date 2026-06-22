import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { LogsSettings } from "./Logs";
import { useAppStore } from "../../store";
import { DEFAULT_LOG_CONFIG } from "../../store/types";

const FILES = [
  { stream: "app", label: "Application log", path: "/p/app.log", sizeBytes: 2048, mtimeMs: Date.now(), exists: true, text: true },
  { stream: "mcp", label: "MCP calls", path: "/p/mcp.log", sizeBytes: 0, mtimeMs: 0, exists: false, text: true },
  { stream: "perf", label: "Performance database", path: "/p/perf.db", sizeBytes: 1048576, mtimeMs: Date.now(), exists: true, text: false },
];

beforeEach(() => {
  useAppStore.setState({ logConfig: { ...DEFAULT_LOG_CONFIG } });
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async (cmd: string) => {
    if (cmd === "list_log_files") return FILES;
    if (cmd === "read_log_tail") return ["12:00:00 INFO  app started", "12:00:01 ERROR  boom happened"];
    return null;
  });
});

describe("LogsSettings", () => {
  it("lists every managed stream with size + last-modified, and an empty-state note", async () => {
    render(<LogsSettings />);
    await waitFor(() => expect(screen.getByText("Application log")).toBeTruthy());
    expect(screen.getByText("MCP calls")).toBeTruthy();
    expect(screen.getByText("Performance database")).toBeTruthy();
    expect(screen.getByText(/2\.0 KB/)).toBeTruthy();          // app size
    expect(screen.getByText("not created yet")).toBeTruthy();   // mcp absent
  });

  it("perf.db has no Clear (defers to Performance) and no View (binary)", async () => {
    render(<LogsSettings />);
    await waitFor(() => expect(screen.getByText("Performance database")).toBeTruthy());
    expect(screen.getByText("retention in Performance →")).toBeTruthy();
    // app + mcp are text → two View buttons; perf is not.
    expect(screen.getAllByText("View")).toHaveLength(2);
  });

  it("View loads the raw tail; search and level filter narrow it", async () => {
    render(<LogsSettings />);
    await waitFor(() => expect(screen.getByText("Application log")).toBeTruthy());
    fireEvent.click(screen.getAllByText("View")[0]); // app log
    await waitFor(() => expect(screen.getByText(/app started/)).toBeTruthy());
    expect(screen.getByText(/boom happened/)).toBeTruthy();

    // Level filter (app log only) → ERROR drops the INFO line.
    fireEvent.change(screen.getByDisplayValue("all levels"), { target: { value: "ERROR" } });
    expect(screen.queryByText(/app started/)).toBeNull();
    expect(screen.getByText(/boom happened/)).toBeTruthy();
  });

  it("changing a retention cap updates the store and pushes log_set_config", async () => {
    render(<LogsSettings />);
    await waitFor(() => expect(screen.getByText("Max lines per log")).toBeTruthy());
    fireEvent.change(screen.getByDisplayValue("10,000 (default)"), { target: { value: "50000" } });
    expect(useAppStore.getState().logConfig.maxLines).toBe(50000);
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("log_set_config", { maxLines: 50000, maxSizeMb: 20 });
  });

  it("Enforce now invokes enforce_log_caps", async () => {
    render(<LogsSettings />);
    await waitFor(() => expect(screen.getByText("Enforce now")).toBeTruthy());
    fireEvent.click(screen.getByText("Enforce now"));
    await waitFor(() => expect(vi.mocked(invoke)).toHaveBeenCalledWith("enforce_log_caps"));
  });
});
