import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { ObjectiveDetailView, renderFactLinks } from "./ObjectiveDetail";
import { episodeMonth, groupByDay } from "./JournalTimeline";
import { episode, objectiveDetail, task } from "./testData";
import type { PageQuery } from "../../lib/types";

const managersObjective = vi.fn();
const managersTasks = vi.fn();
const managersRunDetail = vi.fn();
vi.mock("../../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../../lib/api")>("../../lib/api");
  return {
    ...actual,
    api: {
      managersObjective: (...a: unknown[]) => managersObjective(...a),
      managersTasks: (...a: unknown[]) => managersTasks(...a),
      managersRunDetail: (...a: unknown[]) => managersRunDetail(...a),
    },
  };
});

// The browser does not lay anything out in jsdom.
Element.prototype.scrollIntoView = vi.fn();

const SEP = [
  episode({ id: "ep-260925-0700-ap", at: "2026-09-25T07:00:00Z", text: "Morning wake.", run: "r-260925-0700-wk", tags: ["wake"] }),
  episode({ id: "ep-260922-0900-ao", at: "2026-09-22T09:00:00Z", importance: 7, text: "Asked for a title.", refs: ["t-260922-t1tl"] }),
  episode({ id: "ep-260922-0800-an", at: "2026-09-22T08:00:00Z", text: "Drafted.", source: "ed" }),
];
const AUG = [episode({ id: "ep-260818-0900-aa", at: "2026-08-18T09:00:00Z", text: "Kicked off.", tags: ["kickoff"] })];

function LocationProbe() {
  const l = useLocation();
  return <span data-testid="location">{l.pathname}</span>;
}

function renderDetail(url = "/projects/acme/objectives/blog-cadence") {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route
          path="*"
          element={
            <>
              <ObjectiveDetailView slug="acme" base="/projects/acme" objectiveId="blog-cadence" />
              <LocationProbe />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe("ObjectiveDetailView (Managers M11)", () => {
  beforeEach(() => {
    managersObjective.mockReset();
    managersTasks.mockReset();
    managersRunDetail.mockReset();
    managersObjective.mockImplementation(async (_s: string, _id: string, page: PageQuery = {}) =>
      page.before === "2026-09"
        ? objectiveDetail({ journal: { entries: AUG, months: ["2026-08"], nextBefore: null } })
        : objectiveDetail({ journal: { entries: SEP, months: ["2026-09"], nextBefore: "2026-09" } }),
    );
    managersTasks.mockResolvedValue({ tasks: [task({ id: "t-260922-t1tl", title: "Pick the title", status: "awaiting-ed", objective: "blog-cadence" })], doneMonths: [] });
  });

  it("renders the sections, the linked tasks and an Edit in Files link", async () => {
    renderDetail();
    expect(await screen.findByRole("heading", { name: "Publish weekly" })).toBeInTheDocument();
    expect(managersObjective).toHaveBeenCalledWith("acme", "blog-cadence", { months: 1 });
    expect(managersTasks).toHaveBeenCalledWith("acme", { objective: "blog-cadence" });
    expect(screen.getByText("Eight posts in eight weeks.")).toBeInTheDocument();
    for (const h of ["Where we are", "Strategy", "Lessons", "Open tasks (1)", "Journal"]) {
      expect(screen.getByRole("heading", { name: h })).toBeInTheDocument();
    }
    expect(within(screen.getByTestId("objective-tasks")).getByRole("link", { name: "Pick the title" })).toHaveAttribute(
      "href",
      "/projects/acme/tasks/t-260922-t1tl",
    );
    expect(screen.getByRole("link", { name: /Edit in Files/ })).toHaveAttribute(
      "href",
      "/projects/acme/files/objectives/blog-cadence/objective.md",
    );
  });

  it("groups the journal by day, newest first, with an ep- anchor per entry", async () => {
    renderDetail();
    await screen.findByTestId("journal-timeline");
    const days = screen.getAllByTestId(/^journal-day-/).map((d) => d.getAttribute("data-testid"));
    expect(days).toEqual(["journal-day-2026-09-25", "journal-day-2026-09-22"]);
    const entries = screen.getAllByTestId("journal-entry");
    expect(entries.map((e) => e.id)).toEqual(SEP.map((e) => e.id));
    const second = entries[1]!;
    expect(within(second).getByText("imp 7")).toBeInTheDocument();
    expect(within(second).getByRole("link", { name: "t-260922-t1tl" })).toHaveAttribute("href", "/projects/acme/tasks/t-260922-t1tl");
    expect(within(entries[2]!).getByText("you")).toBeInTheDocument();
    expect(within(entries[0]!).getByText("#wake")).toBeInTheDocument();
  });

  it("Load older fetches the previous month and appends it", async () => {
    renderDetail();
    await screen.findByTestId("journal-timeline");
    expect(screen.queryByText("Kicked off.")).toBeNull();
    await userEvent.click(screen.getByTestId("journal-load-older"));
    expect(await screen.findByText("Kicked off.")).toBeInTheDocument();
    expect(managersObjective).toHaveBeenLastCalledWith("acme", "blog-cadence", { before: "2026-09", months: 1 });
    expect(screen.getAllByTestId("journal-entry")).toHaveLength(4);
    // The journal ran out.
    expect(screen.queryByTestId("journal-load-older")).toBeNull();
  });

  it("a #ep- link into an older month pages back until the entry is there, and highlights it", async () => {
    renderDetail("/projects/acme/objectives/blog-cadence#ep-260818-0900-aa");
    const entry = await screen.findByText("Kicked off.");
    expect(entry.closest("li")).toHaveAttribute("id", "ep-260818-0900-aa");
    expect(entry.closest("li")?.className).toContain("bg-accent-soft");
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
  });

  it("a run link opens the run's chat", async () => {
    managersRunDetail.mockResolvedValue({ run: {}, durationSeconds: 60, chat: { project: "acme", sessionId: "sess-1" }, alerts: [], briefingText: null });
    renderDetail();
    await userEvent.click(await screen.findByTestId("journal-run-link"));
    expect(managersRunDetail).toHaveBeenCalledWith("acme", "r-260925-0700-wk");
    expect(await screen.findByTestId("location")).toHaveTextContent("/projects/acme/chat/sess-1");
  });

  it("a run without a chat says so rather than navigating", async () => {
    managersRunDetail.mockResolvedValue({ run: {}, durationSeconds: null, chat: null, alerts: [], briefingText: null });
    renderDetail();
    await userEvent.click(await screen.findByTestId("journal-run-link"));
    expect(await screen.findByText("Run r-260925-0700-wk has no chat to open.")).toBeInTheDocument();
    expect(screen.getByTestId("location")).toHaveTextContent("/projects/acme/objectives/blog-cadence");
  });

  it("an empty journal and no tasks read as invitations", async () => {
    managersObjective.mockResolvedValue(objectiveDetail({ whereWeAre: "", strategy: "", lessons: "" }));
    managersTasks.mockResolvedValue({ tasks: [], doneMonths: [] });
    renderDetail();
    expect(await screen.findByText("No journal entries yet")).toBeInTheDocument();
    expect(screen.getByText("No open tasks for this objective")).toBeInTheDocument();
    // One invitation for the three empty sections, not three identical cards.
    expect(screen.getByText("The manager hasn't written anything here yet")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Strategy" })).toBeNull();
  });

  it("an unknown objective is a not-found page with a way back", async () => {
    const { ApiError } = await import("../../lib/api");
    managersObjective.mockRejectedValue(new ApiError("No such objective: blog-cadence", 404, "not_found"));
    renderDetail();
    expect(await screen.findByText("Objective not found")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Back to objectives" }));
    expect(screen.getByTestId("location")).toHaveTextContent(/^\/projects\/acme\/objectives$/);
  });

  it("a server error is a callout with Retry", async () => {
    const { ApiError } = await import("../../lib/api");
    managersObjective.mockRejectedValueOnce(new ApiError("Internal Server Error", 500));
    renderDetail();
    expect(await screen.findByText(/Couldn’t load the objective/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("heading", { name: "Publish weekly" })).toBeInTheDocument();
  });
});

describe("journal helpers", () => {
  it("groupByDay keeps order and splits on the UTC date", () => {
    expect(groupByDay(SEP).map((g) => [g.day, g.entries.length])).toEqual([
      ["2026-09-25", 1],
      ["2026-09-22", 2],
    ]);
    expect(groupByDay([])).toEqual([]);
  });

  it("episodeMonth reads the month from an episode id", () => {
    expect(episodeMonth("ep-260818-0900-aa")).toBe("2026-08");
    expect(episodeMonth("nope")).toBeNull();
  });

  it("renderFactLinks shows fact links as code until Memory exists", () => {
    expect(renderFactLinks("- [[reviews-stall-drafts]]")).toBe("- `reviews-stall-drafts`");
  });
});
