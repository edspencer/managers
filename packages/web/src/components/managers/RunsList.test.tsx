import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { ApiError } from "../../lib/api";
import type { ManagersAlert, RunDetail, RunRecord } from "../../lib/types";
import { AlertsList } from "./AlertsList";
import { RunDrawer } from "./RunDrawer";
import { RunsList, latestRuns } from "./RunsList";
import { ObjectivesSummary } from "./ObjectivesSummary";
import { objective } from "./testData";

const managersRuns = vi.fn();
const managersRunDetail = vi.fn();
const managersObjectives = vi.fn();
vi.mock("../../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../../lib/api")>("../../lib/api");
  return {
    ...actual,
    api: {
      managersRuns: (...a: unknown[]) => managersRuns(...a),
      managersRunDetail: (...a: unknown[]) => managersRunDetail(...a),
      managersObjectives: (...a: unknown[]) => managersObjectives(...a),
    },
  };
});

function run(over: Partial<RunRecord> = {}): RunRecord {
  return {
    id: "r-260925-0700-wk",
    trigger: "morning-check",
    kind: "wake",
    objective: null,
    status: "succeeded",
    started: "2026-09-25T07:00:00Z",
    finished: "2026-09-25T07:04:00Z",
    sessionId: null,
    model: "claude-opus-5",
    usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheCreationTokens: 0 },
    episodes: [],
    tasksTouched: [],
    reports: [],
    artifacts: [],
    mcpCalls: {},
    expect: { kind: "episode", within: "48h", report: null, description: null },
    expectResult: "met",
    briefing: null,
    error: null,
    file: "runs/2026-09/r.yaml",
    ...over,
  };
}

const wrap = (ui: React.ReactNode) => render(<MemoryRouter>{ui}</MemoryRouter>);

beforeEach(() => {
  managersRuns.mockReset();
  managersRunDetail.mockReset();
  managersObjectives.mockReset();
});

describe("AlertsList (M12)", () => {
  const alert: ManagersAlert = { id: "run-failed:wake", kind: "run-failed", trigger: "wake", severity: "error", message: "The last wake failed.", runId: "r-1", at: null };

  it("shows the empty line", () => {
    wrap(<AlertsList alerts={[]} />);
    expect(screen.getByTestId("alerts-empty")).toHaveTextContent("No alerts");
  });

  it("lists severity, message and id, and opens the run", async () => {
    const onOpenRun = vi.fn();
    wrap(<AlertsList alerts={[alert, { ...alert, id: "stale:x", severity: "warning", runId: null, message: "Stale." }]} onOpenRun={onOpenRun} />);
    expect(screen.getByText("Error")).toBeInTheDocument();
    expect(screen.getByText("Warning")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "View run" })).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "View run" }));
    expect(onOpenRun).toHaveBeenCalledWith("r-1");
  });
});

describe("RunsList (M12)", () => {
  it("lists the last runs with status, expect mark and duration; a row opens the run", async () => {
    managersRuns.mockResolvedValue({
      runs: [run(), run({ id: "r-f", status: "failed", expectResult: "missing", finished: "2026-09-25T07:01:00Z" }), run({ id: "r-n", expect: null, expectResult: "n/a" })],
      months: ["2026-09"],
      nextBefore: null,
    });
    const onOpenRun = vi.fn();
    wrap(<RunsList slug="acme" base="/projects/acme" onOpenRun={onOpenRun} />);
    const row = await screen.findByTestId("run-row-r-260925-0700-wk");
    expect(within(row).getByText("morning-check")).toBeInTheDocument();
    expect(within(row).getByText("Expectation met")).toBeInTheDocument();
    expect(within(row).getByText("4m")).toBeInTheDocument();
    const failed = screen.getByTestId("run-row-r-f");
    expect(within(failed).getByText("failed")).toBeInTheDocument();
    expect(within(failed).getByText("Expectation missed")).toBeInTheDocument();
    expect(within(screen.getByTestId("run-row-r-n")).getByText("No expectation")).toBeInTheDocument();
    await userEvent.click(failed);
    expect(onOpenRun).toHaveBeenCalledWith("r-f");
  });

  it("pages back until it has ten, and stops", async () => {
    const many = (n: number, p: string) => Array.from({ length: n }, (_, i) => run({ id: `${p}-${i}` }));
    managersRuns
      .mockResolvedValueOnce({ runs: many(4, "a"), months: ["2026-09", "2026-08", "2026-07"], nextBefore: "2026-07" })
      .mockResolvedValueOnce({ runs: many(8, "b"), months: ["2026-06"], nextBefore: "2026-06" });
    const got = await latestRuns("acme");
    expect(got).toHaveLength(10);
    expect(managersRuns).toHaveBeenCalledTimes(2);
    expect(managersRuns).toHaveBeenLastCalledWith("acme", { before: "2026-07", months: 3 });
  });

  it("empty: invites enabling a trigger", async () => {
    managersRuns.mockResolvedValue({ runs: [], months: [], nextBefore: null });
    wrap(<RunsList slug="acme" base="/projects/acme" onOpenRun={vi.fn()} />);
    expect(await screen.findByText("No runs yet — enable a trigger")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open Triggers" })).toHaveAttribute("href", "/projects/acme/triggers");
  });

  it("error: a Callout with Retry that recovers", async () => {
    managersRuns.mockRejectedValueOnce(new ApiError("Internal Server Error", 500)).mockResolvedValue({ runs: [run()], months: [], nextBefore: null });
    wrap(<RunsList slug="acme" base="/projects/acme" onOpenRun={vi.fn()} />);
    expect(await screen.findByText(/Couldn.t load runs/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByTestId("runs-list")).toBeInTheDocument();
  });
});

describe("RunDrawer (M12)", () => {
  const detail = (over: Partial<RunDetail> = {}): RunDetail => ({
    run: run({ id: "r-260925-0700-fl", status: "failed", expectResult: "missing", error: "Turn ended early: the model returned an error.", sessionId: "sess-1" }),
    durationSeconds: 60,
    chat: { project: "acme", sessionId: "sess-1" },
    alerts: [],
    briefingText: "# Briefing\nWhat the manager saw on this wake.",
    ...over,
  });

  it("shows status, the error, the chat link and the briefing on demand", async () => {
    managersRunDetail.mockResolvedValue(detail());
    wrap(<RunDrawer slug="acme" base="/projects/acme" runId="r-260925-0700-fl" onClose={vi.fn()} />);
    const drawer = await screen.findByRole("dialog", { name: "Run r-260925-0700-fl" });
    expect(within(drawer).getByText("Failed")).toBeInTheDocument();
    expect(within(drawer).getByText("Expectation missed")).toBeInTheDocument();
    expect(within(drawer).getByText("Turn ended early: the model returned an error.")).toBeInTheDocument();
    expect(within(drawer).getByRole("link", { name: "Open the run’s chat" })).toHaveAttribute("href", "/projects/acme/chat/sess-1");
    expect(screen.queryByTestId("run-briefing")).not.toBeInTheDocument();
    await userEvent.click(within(drawer).getByRole("button", { name: "What the manager saw" }));
    expect(screen.getByTestId("run-briefing")).toHaveTextContent("What the manager saw on this wake.");
  });

  it("says when there is no briefing or chat", async () => {
    managersRunDetail.mockResolvedValue(detail({ briefingText: null, chat: null }));
    wrap(<RunDrawer slug="acme" base="/projects/acme" runId="r-x" onClose={vi.fn()} />);
    expect(await screen.findByText("No briefing was recorded for this run.")).toBeInTheDocument();
    expect(screen.getByText("This run has no chat.")).toBeInTheDocument();
  });

  it("an error is a Callout with Retry; Close closes", async () => {
    managersRunDetail.mockRejectedValueOnce(new ApiError("Not Found", 404)).mockResolvedValue(detail());
    const onClose = vi.fn();
    wrap(<RunDrawer slug="acme" base="/projects/acme" runId="r-x" onClose={onClose} />);
    expect(await screen.findByText(/Couldn.t load the run: Not Found/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Failed")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("renders nothing when closed", () => {
    wrap(<RunDrawer slug="acme" base="/projects/acme" runId={null} onClose={vi.fn()} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(managersRunDetail).not.toHaveBeenCalled();
  });
});

describe("ObjectivesSummary (M12)", () => {
  it("lists objectives in play and counts the rest", async () => {
    managersObjectives.mockResolvedValue({
      objectives: [objective(), objective({ id: "p", title: "Paused one", status: "paused", openTasks: 0 }), objective({ id: "d", title: "Done one", status: "done" })],
    });
    wrap(<ObjectivesSummary slug="acme" base="/projects/acme" />);
    const list = await screen.findByTestId("objectives-summary");
    expect(within(list).getByRole("link", { name: /Publish weekly/ })).toHaveAttribute("href", "/projects/acme/objectives/blog-cadence");
    expect(within(list).getByText("2 open")).toBeInTheDocument();
    expect(within(list).getByText("Paused")).toBeInTheDocument();
    expect(within(list).queryByText("Done one")).not.toBeInTheDocument();
    expect(within(list).getByRole("link", { name: "1 finished or retired" })).toBeInTheDocument();
  });

  it("empty and error states", async () => {
    managersObjectives.mockResolvedValueOnce({ objectives: [] });
    const { unmount } = wrap(<ObjectivesSummary slug="acme" base="/projects/acme" />);
    expect(await screen.findByText("No objectives yet")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Create one in Objectives" })).toHaveAttribute("href", "/projects/acme/objectives");
    unmount();
    managersObjectives.mockRejectedValueOnce(new ApiError("boom", 500));
    wrap(<ObjectivesSummary slug="acme" base="/projects/acme" />);
    expect(await screen.findByText(/Couldn.t load objectives: boom/)).toBeInTheDocument();
  });
});
