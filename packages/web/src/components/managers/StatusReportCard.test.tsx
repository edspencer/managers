import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { ApiError } from "../../lib/api";
import type { ManagersAlert, ReportDoc, RunRecord } from "../../lib/types";
import { StatusReportCard } from "./StatusReportCard";
import { task } from "./testData";

const managersReport = vi.fn();
const managersTasks = vi.fn();
const managersAlerts = vi.fn();
const managersRefreshReport = vi.fn();
const managersRun = vi.fn();
vi.mock("../../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../../lib/api")>("../../lib/api");
  return {
    ...actual,
    api: {
      managersReport: (...a: unknown[]) => managersReport(...a),
      managersTasks: (...a: unknown[]) => managersTasks(...a),
      managersAlerts: (...a: unknown[]) => managersAlerts(...a),
      managersRefreshReport: (...a: unknown[]) => managersRefreshReport(...a),
      managersRun: (...a: unknown[]) => managersRun(...a),
    },
  };
});

const NOW = new Date().toISOString();

function doc(over: Partial<ReportDoc> = {}): ReportDoc {
  return {
    type: "status",
    date: null,
    file: "reports/status/current.md",
    frontmatter: {},
    title: "Status: Acme, 2026-09-26",
    // The STORED Needs you names a task that has since been answered.
    body: "# Status: Acme, 2026-09-26\n\n## Needs you\n- Old stored ask that was answered\n\n## Alerts\n- No alerts.\n\n## In flight\n- Pricing rewrite is nearly done.",
    updated: NOW,
    generated: NOW,
    parseError: null,
    ...over,
  };
}

const ALERT: ManagersAlert = {
  id: "stale:publish-check",
  kind: "stale",
  trigger: "publish-check",
  severity: "warning",
  message: "No run of publish-check has met its expectation for 3 days.",
  runId: "r-260923-0600-pc",
  at: null,
};

function run(over: Partial<RunRecord> = {}): RunRecord {
  return {
    id: "r-260927-0142-7g",
    trigger: "report-status",
    kind: "report",
    objective: null,
    status: "running",
    started: NOW,
    finished: null,
    sessionId: "s",
    model: null,
    usage: null,
    episodes: [],
    tasksTouched: [],
    reports: [],
    artifacts: [],
    mcpCalls: {},
    expect: null,
    expectResult: null,
    briefing: null,
    error: null,
    file: "runs/2026-09/r.yaml",
    ...over,
  };
}

const onOpenRun = vi.fn();
const onRunFinished = vi.fn();

function renderCard() {
  return render(
    <MemoryRouter>
      <StatusReportCard slug="acme" base="/projects/acme" onOpenRun={onOpenRun} onRunFinished={onRunFinished} pollMs={5} />
    </MemoryRouter>,
  );
}

describe("StatusReportCard (Managers M12)", () => {
  beforeEach(() => {
    for (const f of [managersReport, managersTasks, managersAlerts, managersRefreshReport, managersRun, onOpenRun, onRunFinished]) {
      f.mockReset();
    }
    managersReport.mockResolvedValue({ type: "status", current: doc(), dates: ["2026-09-26"] });
    managersTasks.mockResolvedValue({
      tasks: [task({ id: "t-260926-t1tl", status: "awaiting-ed", title: "Pick the final title", ask: "Which title?" })],
      doneMonths: [],
    });
    managersAlerts.mockResolvedValue([ALERT]);
  });

  it("re-renders Needs you and Alerts live, replacing the stored sections", async () => {
    renderCard();
    const needs = await screen.findByTestId("needs-you");
    expect(await within(needs).findByRole("link", { name: "Pick the final title" })).toHaveAttribute(
      "href",
      "/projects/acme/tasks#t-260926-t1tl",
    );
    expect(within(needs).getByText("Which title?")).toBeInTheDocument();
    expect(managersTasks).toHaveBeenCalledWith("acme", { status: ["awaiting-ed"] });
    // The stored (stale) Needs you line is not shown anywhere.
    await screen.findByText("Pricing rewrite is nearly done.");
    expect(screen.queryByText(/Old stored ask/)).not.toBeInTheDocument();
    expect(screen.queryByText("No alerts.")).not.toBeInTheDocument();
    // Live alerts, with a way into the run.
    const alerts = screen.getByTestId("status-alerts");
    expect(within(alerts).getByText(ALERT.message)).toBeInTheDocument();
    await userEvent.click(within(alerts).getByRole("button", { name: "View run" }));
    expect(onOpenRun).toHaveBeenCalledWith("r-260923-0600-pc");
    expect(screen.getByTestId("status-report-generated")).toHaveTextContent("Generated just now");
  });

  it("M14.5: re-reads Needs you while open, so an ask raised after mount replaces 'Nothing needs you'", async () => {
    managersTasks.mockResolvedValue({ tasks: [], doneMonths: [] });
    render(
      <MemoryRouter>
        <StatusReportCard slug="acme" base="/projects/acme" onOpenRun={onOpenRun} pollMs={5} livePollMs={20} />
      </MemoryRouter>,
    );
    expect(await screen.findByText("Nothing needs you right now.")).toBeInTheDocument();
    // An agent raises an ask while the page is open.
    managersTasks.mockResolvedValue({
      tasks: [task({ id: "t-260927-live", status: "awaiting-ed", title: "LIVE-PROBE", ask: "Now?" })],
      doneMonths: [],
    });
    expect(await screen.findByRole("link", { name: "LIVE-PROBE" }, { timeout: 2000 })).toBeInTheDocument();
    expect(screen.queryByText("Nothing needs you right now.")).not.toBeInTheDocument();
    // A failing re-read says so (and clears only when a later read succeeds).
    managersTasks.mockRejectedValue(new ApiError("boom", 500));
    await waitFor(() => expect(screen.getByText(/Couldn’t load what needs you/)).toBeInTheDocument(), { timeout: 2000 });
  });

  it("M14.5: lists at most 5 asks, then 'Show all N in Tasks'", async () => {
    managersTasks.mockResolvedValue({
      tasks: Array.from({ length: 9 }, (_, i) => task({ id: `t-260927-000${i}`, status: "awaiting-ed", title: `Ask ${i}` })),
      doneMonths: [],
    });
    renderCard();
    const needs = await screen.findByTestId("needs-you");
    await within(needs).findByRole("link", { name: "Ask 0" });
    expect(within(needs).queryByRole("link", { name: "Ask 5" })).toBeNull();
    expect(within(needs).getByRole("link", { name: "Show all 9 in Tasks" })).toHaveAttribute("href", "/projects/acme/tasks");
  });

  it("says nothing needs you when no task is awaiting, and flags an old report", async () => {
    managersTasks.mockResolvedValue({ tasks: [], doneMonths: [] });
    managersReport.mockResolvedValue({ type: "status", current: doc({ generated: "2026-01-01T00:00:00Z" }), dates: [] });
    renderCard();
    expect(await screen.findByText("Nothing needs you right now.")).toBeInTheDocument();
    expect(await screen.findByText("Out of date")).toBeInTheDocument();
  });

  it("shows the empty state with Refresh now enabled when there is no report yet", async () => {
    managersReport.mockResolvedValue({ type: "status", current: null, dates: [] });
    renderCard();
    expect(await screen.findByText("No status report yet")).toBeInTheDocument();
    expect(screen.getByText("Never generated")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh now" })).toBeEnabled();
    // Live sections still render.
    expect(await screen.findByRole("link", { name: "Pick the final title" })).toBeInTheDocument();
  });

  it("a report load error is a Callout with Retry; Needs you and Alerts still render", async () => {
    managersReport.mockRejectedValueOnce(new ApiError("Internal Server Error", 500));
    renderCard();
    expect(await screen.findByText(/Couldn.t load the status report: Internal Server Error/)).toBeInTheDocument();
    expect(await screen.findByRole("link", { name: "Pick the final title" })).toBeInTheDocument();
    expect(screen.getByText(ALERT.message)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Pricing rewrite is nearly done.")).toBeInTheDocument();
  });

  it("Refresh now: spinner while the run is going, then the new report and 'Generated just now'", async () => {
    managersReport.mockResolvedValueOnce({
      type: "status",
      current: doc({ generated: "2026-09-20T07:00:00Z", body: "## In flight\n- old" }),
      dates: [],
    });
    managersRefreshReport.mockResolvedValue({ ok: true, type: "status", trigger: "report-status", runId: "r-1", sessionId: "s" });
    let polls = 0;
    managersRun.mockImplementation(async () => {
      polls += 1;
      return polls < 3 ? run() : run({ status: "succeeded", reports: ["status"], finished: NOW });
    });
    renderCard();
    expect(await screen.findByText("old")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Refresh now" }));
    const busy = await screen.findByRole("button", { name: /Refreshing/ });
    expect(busy).toBeDisabled();
    expect(screen.getByText("Writing a fresh report…")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Refresh now" })).toBeEnabled());
    expect(managersRefreshReport).toHaveBeenCalledWith("acme", "status");
    expect(managersRun).toHaveBeenCalledWith("acme", "r-1");
    expect(polls).toBe(3);
    expect(await screen.findByText("Pricing rewrite is nearly done.")).toBeInTheDocument();
    expect(screen.getByTestId("status-report-generated")).toHaveTextContent("Generated just now");
    expect(onRunFinished).toHaveBeenCalledTimes(1);
  });

  it("Refresh now: a failed run says so with a way into the run", async () => {
    managersRefreshReport.mockResolvedValue({ ok: true, type: "status", trigger: "report-status", runId: "r-2", sessionId: "s" });
    managersRun.mockResolvedValue(run({ id: "r-2", status: "failed", error: "Turn ended early." }));
    renderCard();
    await screen.findByText("Pricing rewrite is nearly done.");
    await userEvent.click(screen.getByRole("button", { name: "Refresh now" }));
    expect(await screen.findByText("The refresh run failed: Turn ended early.")).toBeInTheDocument();
    await userEvent.click(within(screen.getByRole("alert")).getByRole("button", { name: "View run" }));
    expect(onOpenRun).toHaveBeenCalledWith("r-2");
  });

  it("Refresh now: a run that wrote no report, and a refusal, each say so", async () => {
    managersRefreshReport.mockResolvedValueOnce({ ok: true, type: "status", trigger: "report-status", runId: "r-3", sessionId: "s" });
    managersRun.mockResolvedValue(run({ id: "r-3", status: "succeeded", reports: [] }));
    renderCard();
    await screen.findByText("Pricing rewrite is nearly done.");
    await userEvent.click(screen.getByRole("button", { name: "Refresh now" }));
    expect(await screen.findByText(/finished without writing a report/)).toBeInTheDocument();

    managersRefreshReport.mockRejectedValueOnce(new ApiError("behaviour status-reports is off", 409, "behaviour_off"));
    await userEvent.click(screen.getByRole("button", { name: "Refresh now" }));
    expect(await screen.findByText("Refresh is switched off: behaviour status-reports is off")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh now" })).toBeEnabled();
  });
});
