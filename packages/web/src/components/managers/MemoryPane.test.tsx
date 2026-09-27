import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation, useParams } from "react-router-dom";
import { ApiError } from "../../lib/api";
import type { ConsolidationState, FactDetail, FactSummary, MemoryView } from "../../lib/types";
import { MemoryPane, episodeLabel, isSuperseded } from "./MemoryPane";

const managersMemory = vi.fn();
const managersFact = vi.fn();
const managersConsolidation = vi.fn();
const managersRunConsolidation = vi.fn();
const managersRun = vi.fn();
vi.mock("../../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../../lib/api")>("../../lib/api");
  return {
    ...actual,
    api: {
      managersMemory: (...a: unknown[]) => managersMemory(...a),
      managersFact: (...a: unknown[]) => managersFact(...a),
      managersConsolidation: (...a: unknown[]) => managersConsolidation(...a),
      managersRunConsolidation: (...a: unknown[]) => managersRunConsolidation(...a),
      managersRun: (...a: unknown[]) => managersRun(...a),
    },
  };
});

function fact(over: Partial<FactSummary> = {}): FactSummary {
  return {
    name: "reviews-stall-drafts",
    description: "Drafts stall when review has no deadline.",
    type: "pattern",
    since: "2026-09-04",
    until: null,
    confidence: "medium",
    evidence: ["ep-260902-1600-ah", "ep-000000-0000-zz"],
    scope: "project",
    file: "memory/facts/reviews-stall-drafts.md",
    evidenceLinks: [
      {
        episode: "ep-260902-1600-ah",
        found: true,
        workspace: "acme",
        objective: "blog-cadence",
        file: "objectives/blog-cadence/journal/2026-09.md",
        line: 3,
        href: "/projects/acme/objectives/blog-cadence#ep-260902-1600-ah",
      },
      { episode: "ep-000000-0000-zz", found: false, workspace: null, objective: null, file: null, line: null, href: null },
    ],
    ...over,
  };
}

const SHARED = fact({
  name: "house-style",
  description: "Ed prefers short, plain sentences.",
  type: "feedback",
  scope: "root",
  evidence: [],
  evidenceLinks: [],
  file: "memory/facts/house-style.md",
});

function view(facts: FactSummary[]): MemoryView {
  return { indexes: { root: null, project: null }, facts, playbooks: [] };
}

function consolidation(over: Partial<ConsolidationState> = {}): ConsolidationState {
  return {
    behaviour: "consolidate-memory",
    trigger: "consolidate",
    enabled: true,
    settings: { schedule: "30 3 * * *", threshold: 40, minGapHours: 6, model: null, promptFile: null },
    nextRunAt: null,
    lastRun: null,
    lastSucceeded: null,
    running: false,
    since: "2026-08-28T00:00:00Z",
    episodesSince: 3,
    importanceSince: 12,
    ...over,
  };
}

function Probe() {
  const l = useLocation();
  return <span data-testid="location">{l.pathname + l.search + l.hash}</span>;
}

function Route_({ root }: { root: boolean }) {
  const p = useParams();
  return (
    <>
      <MemoryPane slug={root ? "" : "acme"} base={root ? "" : "/projects/acme"} root={root} factName={p.fact} />
      <Probe />
    </>
  );
}

function renderAt(path: string, root = false) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/projects/:slug/memory" element={<Route_ root={root} />} />
        <Route path="/projects/:slug/memory/:fact" element={<Route_ root={root} />} />
        <Route path="/memory" element={<Route_ root />} />
        <Route path="/projects/:slug/objectives/:id" element={<Probe />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("MemoryPane (M12)", () => {
  beforeEach(() => {
    managersMemory.mockReset();
    managersFact.mockReset();
    managersConsolidation.mockReset();
    managersRunConsolidation.mockReset();
    managersRun.mockReset();
    managersMemory.mockResolvedValue(view([fact(), SHARED]));
    managersConsolidation.mockResolvedValue(consolidation({ enabled: false }));
  });

  it("shows project and shared sections, fact chips, and the consolidation state linking to Settings", async () => {
    renderAt("/projects/acme/memory");
    const project = await screen.findByTestId("memory-project");
    expect(within(project).getByText("Drafts stall when review has no deadline.")).toBeInTheDocument();
    expect(within(project).getByText("pattern")).toBeInTheDocument();
    expect(within(project).getByText("since 2026-09-04")).toBeInTheDocument();
    expect(within(project).getByText("medium confidence")).toBeInTheDocument();
    const shared = screen.getByTestId("memory-shared");
    expect(within(shared).getByText("Ed prefers short, plain sentences.")).toBeInTheDocument();
    expect(within(shared).getByRole("link", { name: /Ed prefers/ })).toHaveAttribute("href", "/projects/acme/memory/house-style?scope=root");
    const state = await screen.findByTestId("consolidation-state");
    expect(state).toHaveTextContent("Consolidation: off");
    expect(state).toHaveAttribute("href", "/projects/acme/settings#behaviours");
  });

  it("M14: consolidation off shows no run button", async () => {
    renderAt("/projects/acme/memory");
    expect(await screen.findByTestId("consolidation-state")).toHaveTextContent("Consolidation: off");
    await screen.findByTestId("memory-project");
    expect(screen.queryByRole("button", { name: /Run consolidation now/ })).toBeNull();
    expect(screen.queryByTestId("consolidation-bar")).toBeNull();
  });

  it("M14: on, it shows when memory was last consolidated and runs consolidation now (poll → re-read)", async () => {
    const finished = new Date(Date.now() - 3 * 3_600_000).toISOString();
    managersConsolidation.mockResolvedValue(
      consolidation({ lastSucceeded: { id: "r-1", status: "succeeded", started: finished, finished, error: null } }),
    );
    managersRunConsolidation.mockResolvedValue({ ok: true, trigger: "consolidate", runId: "r-2", sessionId: "s" });
    managersRun.mockResolvedValueOnce({ status: "running", error: null }).mockResolvedValue({ status: "succeeded", error: null });
    render(
      <MemoryRouter initialEntries={["/projects/acme/memory"]}>
        <MemoryPane slug="acme" base="/projects/acme" root={false} pollMs={5} />
      </MemoryRouter>,
    );
    expect(await screen.findByTestId("consolidation-state")).toHaveTextContent("Consolidation: on");
    expect(screen.getByTestId("consolidation-last")).toHaveTextContent("Last consolidated 3h ago");
    expect(screen.getByTestId("consolidation-last")).toHaveTextContent("3 entries since (importance 12 of 40 for an early run)");
    managersMemory.mockClear();
    await userEvent.click(screen.getByRole("button", { name: /Run consolidation now/ }));
    expect(await screen.findByRole("status")).toHaveTextContent("Consolidation finished");
    expect(managersRunConsolidation).toHaveBeenCalledWith("acme");
    expect(managersRun).toHaveBeenCalledWith("acme", "r-2");
    expect(managersRun).toHaveBeenCalledTimes(2);
    expect(managersMemory).toHaveBeenCalled(); // the facts were re-read
  });

  it("M14: never consolidated; a refusal and a failed run both say so", async () => {
    managersConsolidation.mockResolvedValue(consolidation({ episodesSince: 0 }));
    managersRunConsolidation.mockRejectedValueOnce(new ApiError("A consolidation run is already in flight here.", 409, "already_running"));
    render(
      <MemoryRouter initialEntries={["/projects/acme/memory"]}>
        <MemoryPane slug="acme" base="/projects/acme" root={false} pollMs={5} />
      </MemoryRouter>,
    );
    expect(await screen.findByTestId("consolidation-last")).toHaveTextContent("Never consolidated · nothing new since");
    await userEvent.click(screen.getByRole("button", { name: /Run consolidation now/ }));
    expect(await screen.findByText("A consolidation run is already in flight.")).toBeInTheDocument();
    managersRunConsolidation.mockResolvedValueOnce({ ok: true, trigger: "consolidate", runId: "r-3", sessionId: "s" });
    managersRun.mockResolvedValue({ status: "failed", error: "Turn ended early." });
    await userEvent.click(screen.getByRole("button", { name: /Run consolidation now/ }));
    expect(await screen.findByText("The consolidation run failed: Turn ended early.")).toBeInTheDocument();
  });

  it("an evidence chip deep-links to the journal entry; an unresolved one is struck through", async () => {
    renderAt("/projects/acme/memory");
    const chip = await screen.findByTestId("evidence-ep-260902-1600-ah");
    expect(chip).toHaveAttribute("href", "/projects/acme/objectives/blog-cadence#ep-260902-1600-ah");
    expect(screen.getByTitle(/ep-000000-0000-zz: that journal entry was not found/)).toHaveClass("line-through");
    await userEvent.click(chip);
    expect(screen.getByTestId("location")).toHaveTextContent("/projects/acme/objectives/blog-cadence#ep-260902-1600-ah");
  });

  it("filters active / superseded / all, with a way out of an empty filter", async () => {
    managersMemory.mockResolvedValue(view([fact(), fact({ name: "old", description: "An old belief.", until: "2026-01-01" }), SHARED]));
    renderAt("/projects/acme/memory");
    expect(await screen.findByText("Drafts stall when review has no deadline.")).toBeInTheDocument();
    expect(screen.queryByText("An old belief.")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Superseded" }));
    expect(screen.getByText("An old belief.")).toBeInTheDocument();
    expect(screen.queryByText("Drafts stall when review has no deadline.")).not.toBeInTheDocument();
    expect(screen.getByTestId("location")).toHaveTextContent("?show=superseded");
    const shared = screen.getByTestId("memory-shared");
    expect(within(shared).getByText("No superseded facts")).toBeInTheDocument();
    await userEvent.click(within(shared).getByRole("button", { name: "Show all" }));
    expect(screen.getByText("Drafts stall when review has no deadline.")).toBeInTheDocument();
    expect(screen.getByText("An old belief.")).toBeInTheDocument();
  });

  it("empty project memory still shows the shared facts; Home shows only shared", async () => {
    managersMemory.mockResolvedValue(view([SHARED]));
    const { unmount } = renderAt("/projects/acme/memory");
    expect(await screen.findByText("No project memory")).toBeInTheDocument();
    expect(screen.getByText("Ed prefers short, plain sentences.")).toBeInTheDocument();
    unmount();
    renderAt("/memory", true);
    expect(await screen.findByText("Shared memory")).toBeInTheDocument();
    expect(screen.queryByTestId("memory-project")).not.toBeInTheDocument();
  });

  it("error: Callout with Retry", async () => {
    managersMemory.mockRejectedValueOnce(new ApiError("Internal Server Error", 500));
    renderAt("/projects/acme/memory");
    expect(await screen.findByText(/Couldn.t load memory/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByTestId("memory-project")).toBeInTheDocument();
  });

  it("the fact page: body, history, evidence, scope; and not found", async () => {
    const detail: FactDetail = { ...fact(), body: "Seen twice in the blog cadence.", history: ["2026-09-04 created."] };
    managersFact.mockResolvedValueOnce(detail);
    const { unmount } = renderAt("/projects/acme/memory/reviews-stall-drafts");
    expect(await screen.findByText("Seen twice in the blog cadence.")).toBeInTheDocument();
    expect(screen.getByText("2026-09-04 created.")).toBeInTheDocument();
    expect(screen.getByTestId("evidence-ep-260902-1600-ah")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Edit in Files" })).toHaveAttribute(
      "href",
      "/projects/acme/files/memory/facts/reviews-stall-drafts.md",
    );
    expect(managersFact).toHaveBeenCalledWith("acme", "reviews-stall-drafts", undefined);
    unmount();
    managersFact.mockRejectedValueOnce(new ApiError("No such fact", 404));
    renderAt("/projects/acme/memory/nope?scope=root");
    expect(await screen.findByText("Fact not found")).toBeInTheDocument();
    expect(managersFact).toHaveBeenLastCalledWith("acme", "nope", "root");
  });

  it("helpers", () => {
    expect(episodeLabel("ep-260824-1600-ah")).toMatch(/24.*16:00/);
    expect(episodeLabel("weird")).toBe("weird");
    expect(isSuperseded({ until: null })).toBe(false);
    expect(isSuperseded({ until: "2026-01-01" }, "2026-09-27")).toBe(true);
    expect(isSuperseded({ until: "2027-01-01" }, "2026-09-27")).toBe(false);
  });
});
