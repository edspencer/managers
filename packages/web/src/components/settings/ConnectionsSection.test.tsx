import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConnectionsSection, CONNECTIONS_YAML_EXAMPLE } from "./ConnectionsSection";
import type { ManagersConnection } from "../../lib/types";

const managersConnections = vi.fn();
const managersProbeConnection = vi.fn();
vi.mock("../../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../../lib/api")>("../../lib/api");
  return {
    ...actual,
    api: {
      managersConnections: (...a: unknown[]) => managersConnections(...a),
      managersProbeConnection: (...a: unknown[]) => managersProbeConnection(...a),
    },
  };
});

function conn(over: Partial<ManagersConnection> = {}): ManagersConnection {
  return {
    name: "paddock",
    description: "This project's Paddock",
    transport: "http",
    url: "http://127.0.0.1:5098/mcp",
    command: null,
    headerKeys: ["Authorization"],
    envRefs: [{ name: "MANAGERS_MCP_PADDOCK_WIDGET_LIB", where: "headers.Authorization", set: true }],
    tools: ["list_projects", "list_chats"],
    allow: ["mcp__paddock__list_projects", "mcp__paddock__list_chats"],
    attached: true,
    errors: [],
    warnings: [],
    ...over,
  };
}

describe("ConnectionsSection (Managers M9)", () => {
  beforeEach(() => {
    managersConnections.mockReset();
    managersProbeConnection.mockReset();
  });

  it("shows the name, redacted url, env chip set, header names and tools", async () => {
    managersConnections.mockResolvedValue([conn()]);
    render(<ConnectionsSection slug="widget-lib" />);
    const row = await screen.findByTestId("connection-paddock");
    expect(within(row).getByText("http://127.0.0.1:5098/mcp")).toBeInTheDocument();
    const chip = within(row).getByText(/MANAGERS_MCP_PADDOCK_WIDGET_LIB/, { selector: "span.font-mono" }).parentElement!;
    expect(chip.textContent).toMatch(/set$/);
    expect(chip.className).toContain("text-success");
    expect(within(row).getByText("headers: Authorization")).toBeInTheDocument();
    expect(within(row).getByText("tools: list_projects, list_chats")).toBeInTheDocument();
    expect(within(row).queryByText("Not attached")).toBeNull();
  });

  it("Test connection shows the tool list on success", async () => {
    managersConnections.mockResolvedValue([conn()]);
    managersProbeConnection.mockResolvedValue({ name: "paddock", ok: true, tools: ["list_projects", "read_chat"], error: null, ms: 12 });
    render(<ConnectionsSection slug="widget-lib" />);
    await userEvent.click(await screen.findByRole("button", { name: "Test connection" }));
    expect(managersProbeConnection).toHaveBeenCalledWith("widget-lib", "paddock");
    expect((await screen.findByTestId("probe-ok-paddock")).textContent).toContain("list_projects, read_chat");
  });

  it("a missing env var is a danger chip, the row is Not attached, and a failed test shows its error", async () => {
    managersConnections.mockResolvedValue([
      conn({
        attached: false,
        allow: [],
        envRefs: [{ name: "MANAGERS_MCP_PADDOCK_BROKEN_CONN", where: "headers.Authorization", set: false }],
        errors: ["mcp.paddock.headers.Authorization: environment variable MANAGERS_MCP_PADDOCK_BROKEN_CONN is unset or empty. Not attached"],
      }),
    ]);
    managersProbeConnection.mockResolvedValue({ name: "paddock", ok: false, tools: [], error: "401 Unauthorized", ms: 3 });
    render(<ConnectionsSection slug="broken-conn" />);
    const row = await screen.findByTestId("connection-paddock");
    const chip = within(row).getByText(/MANAGERS_MCP_PADDOCK_BROKEN_CONN/, { selector: "span.font-mono" }).parentElement!;
    expect(chip.textContent).toMatch(/missing$/);
    expect(chip.className).toContain("text-danger");
    expect(within(row).getByText("Not attached")).toBeInTheDocument();
    await userEvent.click(within(row).getByRole("button", { name: "Test connection" }));
    expect((await screen.findByTestId("probe-error-paddock")).textContent).toBe("Test failed: 401 Unauthorized");
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("a failed probe REQUEST is shown as an error too", async () => {
    const { ApiError } = await import("../../lib/api");
    managersConnections.mockResolvedValue([conn()]);
    managersProbeConnection.mockRejectedValue(new ApiError("Internal Server Error", 500));
    render(<ConnectionsSection slug="widget-lib" />);
    await userEvent.click(await screen.findByRole("button", { name: "Test connection" }));
    expect((await screen.findByTestId("probe-error-paddock")).textContent).toContain("Test failed:");
  });

  it("empty state: explains the mcp: block with a copyable snippet", async () => {
    managersConnections.mockResolvedValue([]);
    render(<ConnectionsSection slug="empty-project" />);
    expect(await screen.findByText("No connections")).toBeInTheDocument();
    expect(screen.getByTestId("connections-yaml-snippet").textContent).toBe(CONNECTIONS_YAML_EXAMPLE);
    expect(CONNECTIONS_YAML_EXAMPLE).toContain("env:MANAGERS_MCP_");
    expect(screen.getByRole("button", { name: "Copy snippet" })).toBeInTheDocument();
  });

  it("a load failure is a danger callout", async () => {
    const { ApiError } = await import("../../lib/api");
    managersConnections.mockRejectedValue(new ApiError("Project not found", 404));
    render(<ConnectionsSection slug="gone" />);
    expect(await screen.findByText("Project not found")).toBeInTheDocument();
  });
});
