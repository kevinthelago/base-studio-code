import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { McpDownloadModal, type McpDownloadItem } from "./McpDownloadModal";

const item = (over: Partial<McpDownloadItem> = {}): McpDownloadItem => ({
  name: "Research", repo: "research-mcp-server", link: "https://github.com/kevinthelago/research-mcp-server",
  desc: "Search scientific literature.", install: "pnpm build", status: "pending", ...over,
});

describe("McpDownloadModal", () => {
  it("lists each server with its description and a link to the source repo", () => {
    render(<McpDownloadModal items={[item(), item({ name: "Compliance", repo: "compliance-mcp-server", link: "https://github.com/kevinthelago/compliance-mcp-server", desc: "Scan for compliance findings." })]} onConfirm={() => {}} onCancel={() => {}} />);
    expect(screen.getByText("Research")).toBeTruthy();
    expect(screen.getByText("Search scientific literature.")).toBeTruthy();
    const link = screen.getByText("https://github.com/kevinthelago/research-mcp-server") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("https://github.com/kevinthelago/research-mcp-server");
    expect(screen.getByText("Compliance")).toBeTruthy();
  });

  it("Download all triggers onConfirm; Cancel triggers onCancel", () => {
    const onConfirm = vi.fn(), onCancel = vi.fn();
    render(<McpDownloadModal items={[item()]} onConfirm={onConfirm} onCancel={onCancel} />);
    fireEvent.click(screen.getByText("Download all"));
    expect(onConfirm).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByText("Cancel"));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("disables the actions while a download is in flight", () => {
    render(<McpDownloadModal items={[item({ status: "downloading" })]} onConfirm={() => {}} onCancel={() => {}} />);
    expect((screen.getByText("Downloading…") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByText("Cancel") as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows a single Done button once every server is installed", () => {
    const onCancel = vi.fn();
    render(<McpDownloadModal items={[item({ status: "ready" })]} onConfirm={() => {}} onCancel={onCancel} />);
    expect(screen.queryByText("Download all")).toBeNull();
    fireEvent.click(screen.getByText("Done"));
    expect(onCancel).toHaveBeenCalledOnce();
  });
});
