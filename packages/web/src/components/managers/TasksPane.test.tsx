import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { TasksPane } from "./TasksPane";
import { objective, task, taskDetail } from "./testData";
import type { TaskList, TaskQuery } from "../../lib/types";

const managersTasks = vi.fn();
const managersObjectives = vi.fn();
const managersWake = vi.fn();
const managersCreateTask = vi.fn();
const managersAnswerTask = vi.fn();
const managersUpdateTask = vi.fn();
vi.mock("../../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../../lib/api")>("../../lib/api");
  return {
    ...actual,
    api: {
      managersTasks: (...a: unknown[]) => managersTasks(...a),
      managersObjectives: (...a: unknown[]) => managersObjectives(...a),
      managersWake: (...a: unknown[]) => managersWake(...a),
      managersCreateTask: (...a: unknown[]) => managersCreateTask(...a),
      managersAnswerTask: (...a: unknown[]) => managersAnswerTask(...a),
      managersUpdateTask: (...a: unknown[]) => managersUpdateTask(...a),
    },
  };
});

Element.prototype.scrollIntoView = vi.fn();

const AWAIT_1 = task({ id: "t-260922-t1tl", title: "Pick the title", status: "awaiting-ed", objective: "blog-cadence", ask: "Which title?", options: ["A", "B"] });
const AWAIT_2 = task({ id: "t-260829-entp", title: "Decide the price", status: "awaiting-ed", objective: "pricing", ask: "Price?", options: ["contact-us", "show-price"] });
const DOING = task({ id: "t-260904-rvw2", title: "Two-day review window", status: "doing", objective: "blog-cadence" });
const OPEN = task({ id: "t-260914-tpcs", title: "Outline topics", status: "open", objective: "blog-cadence" });
const BLOCKED = task({ id: "t-260916-imgs", title: "Replace photos", status: "blocked" });
const DONE = task({ id: "t-260825-hdln", title: "Ship headline", status: "done", location: "done", month: "2026-09" });

const OBJECTIVES = [objective(), objective({ id: "pricing", title: "Rewrite pricing" }), objective({ id: "links", title: "No broken links", status: "done" })];

function list(tasks = [AWAIT_1, AWAIT_2, DOING, OPEN, BLOCKED], doneMonths = ["2026-09"]): TaskList {
  return { tasks, doneMonths };
}

function LocationProbe() {
  const l = useLocation();
  return <span data-testid="location">{l.pathname + l.search}</span>;
}

function renderPane(url = "/projects/acme/tasks") {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route
          path="/projects/:slug/tasks/:taskId?"
          element={
            <>
              <TasksPane slug="acme" base="/projects/acme" />
              <LocationProbe />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

const groupTitles = () => screen.getAllByTestId(/^task-group-/).map((el) => el.textContent);

describe("TasksPane (Managers M11)", () => {
  beforeEach(() => {
    for (const f of [managersTasks, managersObjectives, managersWake, managersCreateTask, managersAnswerTask, managersUpdateTask]) f.mockReset();
    managersTasks.mockImplementation(async (_slug: string, q: TaskQuery = {}) =>
      q.month ? { tasks: [DONE], doneMonths: ["2026-09"] } : list(),
    );
    managersObjectives.mockResolvedValue({ objectives: OBJECTIVES });
    managersWake.mockResolvedValue({ available: false, reason: "the wake trigger is disabled" });
  });

  it("groups open tasks by status, Awaiting you first, each awaiting row with its answer form", async () => {
    renderPane();
    await screen.findByTestId("task-group-awaiting-ed");
    expect(groupTitles()).toEqual([
      expect.stringContaining("Awaiting you (2)"),
      "Doing (1)",
      "Open (1)",
      "Blocked (1)",
    ]);
    const row = screen.getByTestId(`task-row-${AWAIT_1.id}`);
    expect(within(row).getByRole("button", { name: "A" })).toBeInTheDocument();
    // Objective chips carry the objective's title, not its id.
    expect(within(row).getByText("Publish weekly")).toBeInTheDocument();
    // Done is lazy: nothing closed is fetched until asked.
    expect(managersTasks).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Show done" })).toBeInTheDocument();
  });

  it("answering reloads the list and says so in a toast", async () => {
    managersAnswerTask.mockResolvedValue({ task: { ...AWAIT_1, status: "open" }, episode: { id: "ep-1", file: "x", importance: 5, objective: null } });
    renderPane();
    const row = await screen.findByTestId(`task-row-${AWAIT_1.id}`);
    managersTasks.mockImplementation(async () => list([AWAIT_2, DOING, { ...AWAIT_1, status: "open" }, OPEN, BLOCKED]));
    await userEvent.click(within(row).getByRole("button", { name: "B" }));
    expect(managersAnswerTask).toHaveBeenCalledWith("acme", AWAIT_1.id, { choice: "B" });
    expect(await screen.findByText(/Answered “B”\. The manager will see it on its next run\./)).toBeInTheDocument();
    await waitFor(() => expect(groupTitles()[0]).toContain("Awaiting you (1)"));
    expect(groupTitles()).toContain("Open (2)");
  });

  it("filters by objective through the URL, and a filter with no tasks shows No tasks match with a way out", async () => {
    renderPane();
    await screen.findByTestId("task-group-awaiting-ed");
    await userEvent.click(screen.getByRole("button", { name: "Objective" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Publish weekly" }));
    expect(screen.getByTestId("location")).toHaveTextContent("/projects/acme/tasks?objective=blog-cadence");
    expect(groupTitles()).toEqual([expect.stringContaining("Awaiting you (1)"), "Doing (1)", "Open (1)"]);

    await userEvent.click(screen.getByRole("button", { name: /Objective: Publish weekly/ }));
    await userEvent.click(screen.getByRole("menuitem", { name: "No broken links" }));
    expect(await screen.findByText("No tasks match")).toBeInTheDocument();
    expect(screen.queryByTestId(/^task-group-/)).toBeNull();
    await userEvent.click(screen.getAllByRole("button", { name: "Clear filters" })[0]!);
    expect(screen.getByTestId("location")).toHaveTextContent(/^\/projects\/acme\/tasks$/);
    expect(groupTitles()).toHaveLength(4);
  });

  it("a filter that matches only unloaded closed tasks offers Show done beside Clear filters", async () => {
    renderPane("/projects/acme/tasks?objective=links");
    expect(await screen.findByText("No tasks match")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Show done" }));
    expect(managersTasks).toHaveBeenCalledWith("acme", { month: "2026-09" });
    // DONE has no objective, so it still does not match: the state stays, and the month is loaded.
    expect(await screen.findByText("No tasks match")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show done" })).toBeNull();
  });

  it("a #<task-id> link (a report's Needs you) scrolls to and marks that row", async () => {
    renderPane(`/projects/acme/tasks#${AWAIT_2.id}`);
    const row = await screen.findByTestId(`task-row-${AWAIT_2.id}`);
    expect(row.className).toContain("ring-accent");
    expect(screen.getByTestId(`task-row-${AWAIT_1.id}`).className).not.toContain("ring-accent");
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
  });

  it("filters by status (multi-select) from a deep link", async () => {
    renderPane("/projects/acme/tasks?status=doing,blocked");
    await screen.findByTestId("task-group-doing");
    expect(groupTitles()).toEqual(["Doing (1)", "Blocked (1)"]);
  });

  it("a status filter for done loads the newest closed month on its own", async () => {
    renderPane("/projects/acme/tasks?status=done");
    expect(await screen.findByText("Ship headline")).toBeInTheDocument();
    expect(managersTasks).toHaveBeenCalledWith("acme", { month: "2026-09" });
    expect(screen.queryByText("No tasks match")).toBeNull();
  });

  it("Show done loads closed tasks a month at a time", async () => {
    managersTasks.mockImplementation(async (_s: string, q: TaskQuery = {}) =>
      q.month === "2026-09"
        ? { tasks: [DONE], doneMonths: [] }
        : q.month === "2026-08"
          ? { tasks: [task({ id: "t-260801-ftr1", title: "Redesign footer", status: "dropped" })], doneMonths: [] }
          : list(undefined, ["2026-09", "2026-08"]),
    );
    renderPane();
    await userEvent.click(await screen.findByRole("button", { name: "Show done" }));
    expect(await screen.findByText("Ship headline")).toBeInTheDocument();
    expect(screen.queryByText("Redesign footer")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /Load older · August 2026/ }));
    expect(await screen.findByText("Redesign footer")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Load older/ })).toBeNull();
  });

  it("creates a task from the New task dialog and reloads", async () => {
    managersCreateTask.mockResolvedValue(taskDetail({ id: "t-260926-qaqa", title: "QA task", objective: "blog-cadence" }));
    renderPane();
    await screen.findByTestId("task-group-awaiting-ed");
    await userEvent.click(screen.getByRole("button", { name: "New task" }));
    const dialog = screen.getByRole("dialog", { name: "New task" });
    const add = within(dialog).getByRole("button", { name: "Add task" });
    expect(add).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText("Title"), "QA task");
    await userEvent.selectOptions(within(dialog).getByLabelText("Objective"), "blog-cadence");
    await userEvent.click(add);
    expect(managersCreateTask).toHaveBeenCalledWith("acme", {
      title: "QA task",
      status: "open",
      source: "ed",
      objective: "blog-cadence",
    });
    expect(await screen.findByText("Added “QA task”.")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(managersTasks.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("changes a task's status from its row menu", async () => {
    managersUpdateTask.mockResolvedValue(taskDetail({ ...OPEN, status: "done" }));
    renderPane();
    const row = await screen.findByTestId(`task-row-${OPEN.id}`);
    await userEvent.click(within(row).getByRole("button", { name: `Change status of ${OPEN.title}` }));
    expect(within(row).queryByRole("menuitem", { name: "Mark open" })).toBeNull();
    await userEvent.click(within(row).getByRole("menuitem", { name: "Mark done" }));
    expect(managersUpdateTask).toHaveBeenCalledWith("acme", OPEN.id, { status: "done" });
    expect(await screen.findByText("“Outline topics” is now done.")).toBeInTheDocument();
  });

  it("an empty workspace gets an invitation, not a list", async () => {
    managersTasks.mockResolvedValue({ tasks: [], doneMonths: [] });
    renderPane();
    expect(await screen.findByText("No tasks yet")).toBeInTheDocument();
    expect(screen.queryByTestId("task-filters")).toBeNull();
    expect(screen.getAllByRole("button", { name: "New task" }).length).toBeGreaterThan(0);
  });

  it("the toast never doubles the answer's own punctuation", async () => {
    const { answeredMessage } = await import("./shared");
    const r = { task: AWAIT_1, episode: { id: "e", file: "f", importance: 5, objective: null } };
    expect(answeredMessage(r, "Yes, go ahead.", false)).toBe("Answered “Yes, go ahead”. The manager will see it on its next run.");
    expect(answeredMessage({ ...r, wake: { fired: true } }, "merge", true)).toBe("Answered “merge”. The manager has been woken.");
    expect(answeredMessage({ ...r, wake: { fired: false, reason: "the wake trigger is disabled" } }, "", true)).toBe(
      "Answered. The manager was not woken: the wake trigger is disabled.",
    );
  });

  it("a failed load shows an error with Retry, which recovers", async () => {
    const { ApiError } = await import("../../lib/api");
    managersTasks.mockRejectedValueOnce(new ApiError("Internal Server Error", 500));
    renderPane();
    expect(await screen.findByText(/Couldn’t load tasks: Internal Server Error/)).toBeInTheDocument();
    expect(screen.queryByTestId("tasks-loading")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByTestId("task-group-awaiting-ed")).toBeInTheDocument();
  });

  it("lists skipped files instead of failing", async () => {
    managersTasks.mockResolvedValue({ ...list(), parseErrors: [{ file: "tasks/open/t-1.md", error: "status: bad" }] });
    renderPane();
    expect(await screen.findByText("tasks/open/t-1.md")).toBeInTheDocument();
    expect(screen.getByTestId("task-group-awaiting-ed")).toBeInTheDocument();
  });
});
