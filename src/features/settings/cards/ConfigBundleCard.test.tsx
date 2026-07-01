import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { ConfigBundleCard } from "./ConfigBundleCard";

beforeEach(() => {
  vi.mocked(invoke).mockReset();
});

describe("ConfigBundleCard", () => {
  it("renders the export + import actions", () => {
    render(<ConfigBundleCard />);
    expect(screen.getByRole("button", { name: /Export/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Import/ })).toBeInTheDocument();
  });

  it("exports to the picked path and reports the file count", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "pick_save_file") return "/tmp/bundle.json";
      if (cmd === "export_config_bundle") return 42;
      return undefined;
    });
    render(<ConfigBundleCard />);
    fireEvent.click(screen.getByRole("button", { name: /Export/ }));
    expect(await screen.findByText(/Exported 42 config files to \/tmp\/bundle\.json/)).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith("export_config_bundle", { path: "/tmp/bundle.json" });
  });

  it("does not export when the save dialog is cancelled", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => (cmd === "pick_save_file" ? null : undefined));
    render(<ConfigBundleCard />);
    fireEvent.click(screen.getByRole("button", { name: /Export/ }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("pick_save_file", { defaultName: "bsc-config-bundle.json" }),
    );
    expect(invoke).not.toHaveBeenCalledWith("export_config_bundle", expect.anything());
  });

  it("imports with the replace flag when toggled on", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "pick_open_file") return "/tmp/bundle.json";
      if (cmd === "import_config_bundle") return 5;
      return undefined;
    });
    render(<ConfigBundleCard />);
    fireEvent.click(screen.getByRole("checkbox", { name: /Replace existing config on import/ }));
    fireEvent.click(screen.getByRole("button", { name: /Import/ }));
    expect(await screen.findByText(/Imported 5 config files/)).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith("import_config_bundle", { path: "/tmp/bundle.json", replace: true });
  });
});
