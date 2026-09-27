import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { ApiError } from "../../lib/api";
import type { ManagersAlert, NeedsYouResponse, TaskAnswerResult } from "../../lib/types";
import { GROUP_CAP, NeedsYouPanel, PAGE_SIZE, nextLimit, reportAge, totalsLine } from "./NeedsYouPanel";
import { task, taskDetail } from "./testData";

const managersNeedsYou = vi.fn();
const managersWake = vi.fn();
const managersAnswerTask = vi.fn();
vi.mock("../../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../../lib/api")>("../../lib/api");
  return {
    ...actual,
    api: {
      managersNeedsYou: (...a: unknown[]) => managersNeedsYou(...a),
      managersWake: (...a: unknown[]) => managersWake(...a),
      managersAnswerTask: (...a: unknown[]) => managersAnswerTask(...a),
    },
  };
});

const DAY = 86_400_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

const ALERT: ManagersAlert = {
  id: "stale:publish-check",
  kind: "stale",
  trigger: "publish-check",
  severity: "warning",
  message: "No run of publish-check has met its expectation for 3 days.",
  runId: "r-260923-0600-pc",
  at: null,
};

const ENTP = task({
  id: "t-260830-entp",
  title: "Decide the enterprise tier price",
  status: "awaiting-ed",
  ask: "Contact us, or a price?",
  options: ["contact-us", "show-price"],
});
const RN88 = task({ id: "t-260926-rn88", title: "Merge renovate #88?", status: "awaiting-ed", ask: "Merge?", options: ["merge", "skip"] });
const HOME = task({ id: "t-260925-home", title: "Pick the review slot", status: "awaiting-ed", ask: "Which project first?", options: [] });

function response(over: Partial<NeedsYouResponse> = {}): NeedsYouResponse {
  return {
    generatedAt: new Date().toISOString(),
    projects: [
      {
        slug: "acme-site",
        name: "Acme Site",
        needsYou: [ENTP],
        alerts: [ALERT],
        status: { generated: ago(3 * DAY + 3_600_000), stale: true },
        parseErrors: [],
      },
      {
        slug: "widget-lib",
        name: "Widget Lib",
        needsYou: [RN88],
        alerts: [],
        status: { generated: ago(DAY), stale: false },
        parseErrors: [{ file: "tasks/open/t-260925-bad0.md", error: "status: bad" }],
      },
      { slug: "", name: "Home", needsYou: [HOME], alerts: [], status: { generated: null, stale: false }, parseErrors: [] },
      { slug: "broken-conn", name: "Broken Conn", error: "ELOOP: cannot read tasks/open" },
    ],
    totals: { checked: 6, needsYou: 3, alerts: 1, errors: 1, withItems: 3 },
    ...over,
  };
}

const answered = (): TaskAnswerResult => ({
  task: taskDetail({ id: RN88.id, status: "open" }),
  episode: { id: "ep-x", file: "log/2026-09.md", importance: 5, objective: null },
});

function renderPanel() {
  return render(
    <MemoryRouter>
      <NeedsYouPanel />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  managersNeedsYou.mockReset();
  managersWake.mockReset();
  managersAnswerTask.mockReset();
  managersWake.mockResolvedValue({ available: false, reason: "this project has no wake trigger" });
});

describe("NeedsYouPanel", () => {
  it("groups by workspace in the server's order, linking each to its Home", async () => {
    managersNeedsYou.mockResolvedValue(response());
    renderPanel();
    const groups = await screen.findByTestId("needs-you-groups");
    expect(
      Array.from(groups.children).map((c) => c.getAttribute("data-testid")),
    ).toEqual(["needs-you-group-acme-site", "needs-you-group-widget-lib", "needs-you-group-home", "needs-you-error-broken-conn"]);
    expect(screen.getByTestId("needs-you-totals")).toHaveTextContent("3 asks · 1 alert · 1 project unreadable — 6 projects checked");
    expect(screen.getByTestId("needs-you-project-acme-site")).toHaveAttribute("href", "/projects/acme-site/home");
    expect(screen.getByTestId("needs-you-project-home")).toHaveAttribute("href", "/");

    const acme = screen.getByTestId("needs-you-group-acme-site");
    expect(within(acme).getByText("1 ask")).toBeInTheDocument();
    expect(within(acme).getByText("Status report 3d old")).toBeInTheDocument();
    expect(within(acme).getByRole("link", { name: "Decide the enterprise tier price" })).toHaveAttribute(
      "href",
      "/projects/acme-site/tasks#t-260830-entp",
    );
    // The answer form is TaskAnswer's: the ask and one button per option.
    expect(within(acme).getByText("Contact us, or a price?")).toBeInTheDocument();
    expect(within(acme).getByRole("button", { name: "contact-us" })).toBeInTheDocument();
    // An alert row with its severity, opening the project's Home.
    const alert = within(acme).getByTestId("needs-you-alert-stale:publish-check");
    expect(alert).toHaveAttribute("href", "/projects/acme-site/home");
    expect(alert).toHaveTextContent("Warning");
    expect(alert).toHaveTextContent(ALERT.message);

    // Not stale: no hint. Unreadable task files are called out.
    const widget = screen.getByTestId("needs-you-group-widget-lib");
    expect(within(widget).queryByText(/Status report/)).toBeNull();
    expect(within(widget).getByTestId("needs-you-parse-errors")).toHaveTextContent("1 task file won’t parse");

    // Home's open-ended ask gets the free-text form.
    const home = screen.getByTestId("needs-you-group-home");
    expect(within(home).getByPlaceholderText("Your answer…")).toBeInTheDocument();

    // The unreadable project is its own row; the others still rendered above.
    expect(screen.getByTestId("needs-you-error-broken-conn")).toHaveTextContent("ELOOP: cannot read tasks/open");

    // Wake availability is asked per workspace with asks, never for the error row.
    await waitFor(() => expect(managersWake).toHaveBeenCalledTimes(3));
    expect(managersWake.mock.calls.map((c) => c[0]).sort()).toEqual(["", "acme-site", "widget-lib"]);
    expect(within(acme).getAllByTestId("wake-reason")[0]).toHaveTextContent("this project has no wake trigger");
  });

  it("answering removes the row, toasts, and re-reads the collation", async () => {
    managersNeedsYou.mockResolvedValueOnce(response());
    const after = response();
    after.projects = after.projects.filter((p) => p.slug !== "widget-lib");
    after.totals = { ...after.totals, needsYou: 2 };
    managersNeedsYou.mockResolvedValueOnce(after);
    managersAnswerTask.mockResolvedValue(answered());
    renderPanel();
    const widget = await screen.findByTestId("needs-you-group-widget-lib");
    await userEvent.click(within(widget).getByRole("button", { name: "merge" }));
    expect(managersAnswerTask).toHaveBeenCalledWith("widget-lib", "t-260926-rn88", { choice: "merge" });
    expect(await screen.findByText(/Answered “merge”\. The manager will see it on its next run\./)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTestId("needs-you-task-t-260926-rn88")).toBeNull());
    await waitFor(() => expect(screen.queryByTestId("needs-you-group-widget-lib")).toBeNull());
    expect(managersNeedsYou).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("needs-you-totals")).toHaveTextContent("2 asks");
  });

  it("says when the answer woke the manager", async () => {
    managersNeedsYou.mockResolvedValue(response());
    managersWake.mockResolvedValue({ available: true, reason: null });
    managersAnswerTask.mockResolvedValue({ ...answered(), wake: { fired: true, sessionId: "s" } });
    renderPanel();
    const widget = await screen.findByTestId("needs-you-group-widget-lib");
    const toggle = await within(widget).findByRole("checkbox", { name: "Wake the manager now" });
    await waitFor(() => expect(toggle).toBeEnabled());
    await userEvent.click(toggle);
    await userEvent.click(within(widget).getByRole("button", { name: "skip" }));
    expect(managersAnswerTask).toHaveBeenCalledWith("widget-lib", "t-260926-rn88", { choice: "skip", wake: true });
    expect(await screen.findByText(/Answered “skip”\. The manager has been woken\./)).toBeInTheDocument();
  });

  it("a failed answer stays in the row and keeps it", async () => {
    managersNeedsYou.mockResolvedValue(response());
    managersAnswerTask.mockRejectedValue(new ApiError("Task is not awaiting-ed", 409));
    renderPanel();
    const acme = await screen.findByTestId("needs-you-group-acme-site");
    await userEvent.click(within(acme).getByRole("button", { name: "show-price" }));
    expect(await within(acme).findByTestId("task-answer-error")).toHaveTextContent("Task is not awaiting-ed");
    expect(screen.getByTestId("needs-you-task-t-260830-entp")).toBeInTheDocument();
    expect(managersNeedsYou).toHaveBeenCalledTimes(1);
  });

  it("empty: nothing needs you, with how many projects were checked", async () => {
    managersNeedsYou.mockResolvedValue(
      response({ projects: [], totals: { checked: 6, needsYou: 0, alerts: 0, errors: 0, withItems: 0 } }),
    );
    renderPanel();
    expect(await screen.findByText("Nothing needs you — 6 projects checked")).toBeInTheDocument();
    // Said once, not twice: the header's totals line steps aside.
    expect(screen.queryByTestId("needs-you-totals")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Check again" }));
    expect(managersNeedsYou).toHaveBeenCalledTimes(2);
  });

  it("error: a Callout with Retry that recovers", async () => {
    managersNeedsYou.mockRejectedValueOnce(new ApiError("Internal Server Error", 500));
    managersNeedsYou.mockResolvedValueOnce(response());
    renderPanel();
    expect(await screen.findByText(/Couldn’t load what needs you: Internal Server Error/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByTestId("needs-you-group-acme-site")).toBeInTheDocument();
  });

  it("shows a skeleton while loading", () => {
    managersNeedsYou.mockReturnValue(new Promise(() => {}));
    renderPanel();
    expect(screen.getByTestId("needs-you-loading")).toBeInTheDocument();
  });
});

describe("NeedsYouPanel helpers", () => {
  it("reportAge", () => {
    const now = Date.parse("2026-09-27T12:00:00Z");
    expect(reportAge("2026-09-26T12:00:00Z", now)).toBe("24h old");
    expect(reportAge("2026-09-24T11:00:00Z", now)).toBe("3d old");
    expect(reportAge("nope", now)).toBe("out of date");
  });
  it("totalsLine", () => {
    expect(totalsLine({ checked: 1, needsYou: 1, alerts: 0, errors: 0, withItems: 1 })).toBe("1 ask — 1 project checked");
    expect(totalsLine({ checked: 5, needsYou: 0, alerts: 0, errors: 0, withItems: 0 })).toBe("5 projects checked");
  });
});

describe("NeedsYouPanel (M14.5)", () => {
  const many = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      task({ id: `t-260927-${String(i).padStart(4, "0")}`, title: `Ask number ${i}`, status: "awaiting-ed", ask: "?", options: [] }),
    );

  it("a project with an unreadable project.yaml keeps its asks, read-only, under an error row", async () => {
    managersNeedsYou.mockResolvedValue(
      response({
        projects: [
          {
            slug: "widget-lib",
            name: "widget-lib",
            needsYou: [RN88],
            alerts: [
              {
                id: "config-unreadable:",
                kind: "config-unreadable",
                trigger: "",
                severity: "error",
                message: "project.yaml is not valid YAML (x). This project is missing from the project list.",
                runId: null,
                at: null,
              },
            ],
            status: { generated: null, stale: false },
            parseErrors: [],
            configError: "project.yaml is not valid YAML (x)",
          },
        ],
        totals: { checked: 2, needsYou: 1, alerts: 1, errors: 1, withItems: 1 },
      }),
    );
    renderPanel();
    const group = await screen.findByTestId("needs-you-group-widget-lib");
    expect(within(group).getByTestId("needs-you-config-error")).toHaveTextContent(
      "This project’s project.yaml can’t be read: project.yaml is not valid YAML (x). It is missing from the project list until you fix the file by hand, so its asks below can’t be answered from here yet.",
    );
    // The ask is listed, without an answer form, and the header is not a link to a page that cannot open.
    expect(within(group).getByText("Merge renovate #88?")).toBeInTheDocument();
    expect(within(group).queryByRole("button", { name: /merge/i })).toBeNull();
    expect(within(group).getByTestId("needs-you-project-widget-lib").tagName).toBe("SPAN");
    expect(within(group).getByTestId("needs-you-alert-config-unreadable:")).toHaveTextContent("missing from the project list");
    expect(managersWake).not.toHaveBeenCalled();
  });

  it("caps a long list at GROUP_CAP with Show all N, and Show fewer", async () => {
    const asks = many(12);
    managersNeedsYou.mockResolvedValue(
      response({
        projects: [{ slug: "acme-site", name: "Acme Site", needsYou: asks, alerts: [], status: { generated: null, stale: false }, parseErrors: [] }],
        totals: { checked: 1, needsYou: 12, alerts: 0, errors: 0, withItems: 1 },
      }),
    );
    renderPanel();
    const group = await screen.findByTestId("needs-you-group-acme-site");
    expect(within(group).getAllByTestId(/^needs-you-task-/)).toHaveLength(GROUP_CAP);
    await userEvent.click(within(group).getByRole("button", { name: "Show all 12 asks" }));
    expect(within(group).getAllByTestId(/^needs-you-task-/)).toHaveLength(12);
    await userEvent.click(within(group).getByRole("button", { name: "Show fewer" }));
    expect(within(group).getAllByTestId(/^needs-you-task-/)).toHaveLength(GROUP_CAP);
  });

  it("500 asks: 5 rows, then a page at a time, with Open Tasks", async () => {
    managersNeedsYou.mockResolvedValue(
      response({
        projects: [{ slug: "acme-site", name: "Acme Site", needsYou: many(500), alerts: [], status: { generated: null, stale: false }, parseErrors: [] }],
        totals: { checked: 1, needsYou: 500, alerts: 0, errors: 0, withItems: 1 },
      }),
    );
    renderPanel();
    const group = await screen.findByTestId("needs-you-group-acme-site");
    expect(within(group).getAllByTestId(/^needs-you-task-/)).toHaveLength(5);
    expect(within(group).getByRole("link", { name: "Open Tasks" })).toHaveAttribute("href", "/projects/acme-site/tasks");
    await userEvent.click(within(group).getByRole("button", { name: "Show 50 more (495 asks hidden)" }));
    expect(within(group).getAllByTestId(/^needs-you-task-/)).toHaveLength(55);
  });

  it("nextLimit", () => {
    expect(nextLimit(GROUP_CAP, 12)).toBe(12);
    expect(nextLimit(GROUP_CAP, GROUP_CAP + PAGE_SIZE)).toBe(GROUP_CAP + PAGE_SIZE);
    expect(nextLimit(GROUP_CAP, 500)).toBe(GROUP_CAP + PAGE_SIZE);
    expect(nextLimit(455, 500)).toBe(500);
  });
});
