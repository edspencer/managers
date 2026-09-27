import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SecurityBanner } from "./SecurityBanner";

const security = vi.fn();
vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return { ...actual, api: { security: (...a: unknown[]) => security(...a) } };
});

beforeEach(() => security.mockReset());

describe("SecurityBanner (M14.5)", () => {
  it("shows every opted-in danger, persistently, with the why on demand", async () => {
    security.mockResolvedValue({
      authMode: "none",
      driveMode: "batch",
      batchDriveAllowed: true,
      warnings: [
        { code: "no-auth", title: "No authentication: agents on this host can act as you", detail: "Every process on this host…" },
        { code: "batch-drive", title: "Batch drive mode allowed: turn tools are reachable locally", detail: "The bridge…" },
      ],
    });
    render(<SecurityBanner />);
    const banner = await screen.findByTestId("security-banner");
    expect(banner).toHaveAccessibleName("Security warning");
    expect(screen.getByTestId("security-banner-no-auth")).toHaveTextContent("No authentication: agents on this host can act as you");
    expect(screen.getByTestId("security-banner-batch-drive")).toBeInTheDocument();
    // No dismiss control: it lasts as long as the setting does.
    expect(screen.queryByRole("button", { name: /dismiss|close/i })).toBeNull();
    const detail = screen.getByText("Every process on this host…");
    expect(detail).not.toBeVisible();
    await userEvent.click(screen.getByText("No authentication: agents on this host can act as you"));
    expect(detail).toBeVisible();
  });

  it("renders nothing with no warnings, on a failed read, or against a server without the route", async () => {
    security.mockResolvedValue({ authMode: "jwt", driveMode: "session", batchDriveAllowed: false, warnings: [] });
    const { unmount } = render(<SecurityBanner />);
    await Promise.resolve();
    expect(screen.queryByTestId("security-banner")).toBeNull();
    unmount();
    security.mockRejectedValue(new Error("404"));
    render(<SecurityBanner />);
    await Promise.resolve();
    expect(screen.queryByTestId("security-banner")).toBeNull();
  });
});
