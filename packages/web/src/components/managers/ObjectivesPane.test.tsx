import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { ObjectivesPane } from "./ObjectivesPane";
import { objectiveIdFrom } from "./NewObjectiveModal";
import { objective, objectiveDetail } from "./testData";

const managersObjectives = vi.fn();
const managersCreateObjective = vi.fn();
vi.mock("../../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../../lib/api")>("../../lib/api");
  return {
    ...actual,
    api: {
      managersObjectives: (...a: unknown[]) => managersObjectives(...a),
      managersCreateObjective: (...a: unknown[]) => managersCreateObjective(...a),
    },
  };
});

function LocationProbe() {
  return <span data-testid="location">{useLocation().pathname}</span>;
}

function renderPane() {
  return render(
    <MemoryRouter initialEntries={["/projects/acme/objectives"]}>
      <Routes>
        <Route
          path="/projects/:slug/objectives/*"
          element={
            <>
              <ObjectivesPane slug="acme" base="/projects/acme" />
              <LocationProbe />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe("ObjectivesPane (Managers M11)", () => {
  beforeEach(() => {
    managersObjectives.mockReset();
    managersCreateObjective.mockReset();
  });

  it("renders a card per objective: status, excerpt, updated, open tasks, linking to its page", async () => {
    managersObjectives.mockResolvedValue({
      objectives: [objective(), objective({ id: "links", title: "No broken links", status: "done", excerpt: "", openTasks: 0 })],
    });
    renderPane();
    const card = await screen.findByTestId("objective-card-blog-cadence");
    expect(within(card).getByText("Publish weekly")).toBeInTheDocument();
    expect(within(card).getByText("Active")).toBeInTheDocument();
    expect(within(card).getByText("Seven of eight weeks met.")).toBeInTheDocument();
    expect(within(card).getByText("2 open tasks")).toBeInTheDocument();
    expect(within(card).getByText(/^Updated /)).toBeInTheDocument();
    expect(card).toHaveAttribute("href", "/projects/acme/objectives/blog-cadence");
    const done = screen.getByTestId("objective-card-links");
    expect(within(done).getByText("Done")).toBeInTheDocument();
    expect(within(done).getByText("No open tasks")).toBeInTheDocument();
    expect(within(done).getByText("No progress summary yet.")).toBeInTheDocument();
  });

  it("shows the empty state with a New objective button that creates one and opens it", async () => {
    managersObjectives.mockResolvedValue({ objectives: [] });
    managersCreateObjective.mockResolvedValue(objectiveDetail({ id: "grow-awareness", title: "Grow awareness" }));
    renderPane();
    expect(await screen.findByText("No objectives yet")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "New objective" }));
    const dialog = screen.getByRole("dialog", { name: "New objective" });
    const create = within(dialog).getByRole("button", { name: "Create objective" });
    expect(create).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText("Title"), "Grow awareness");
    // The id follows the title until edited.
    expect(within(dialog).getByLabelText("Id")).toHaveValue("grow-awareness");
    expect(create).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText("Success looks like"), "Three communities know it.");
    await userEvent.click(create);
    expect(managersCreateObjective).toHaveBeenCalledWith("acme", {
      id: "grow-awareness",
      title: "Grow awareness",
      success: "Three communities know it.",
    });
    expect(screen.getByTestId("location")).toHaveTextContent("/projects/acme/objectives/grow-awareness");
  });

  it("keeps the dialog open with the server's error when the create fails", async () => {
    const { ApiError } = await import("../../lib/api");
    managersObjectives.mockResolvedValue({ objectives: [] });
    managersCreateObjective.mockRejectedValue(new ApiError("Objective grow already exists", 409, "conflict"));
    renderPane();
    await userEvent.click(await screen.findByRole("button", { name: "New objective" }));
    const dialog = screen.getByRole("dialog", { name: "New objective" });
    await userEvent.type(within(dialog).getByLabelText("Title"), "Grow");
    await userEvent.type(within(dialog).getByLabelText("Success looks like"), "x");
    await userEvent.click(within(dialog).getByRole("button", { name: "Create objective" }));
    expect(await within(dialog).findByTestId("new-objective-error")).toHaveTextContent("already exists");
  });

  it("a failed load shows an error with Retry", async () => {
    const { ApiError } = await import("../../lib/api");
    managersObjectives.mockRejectedValueOnce(new ApiError("Bad Gateway", 502)).mockResolvedValue({ objectives: [objective()] });
    renderPane();
    expect(await screen.findByText(/Couldn’t load objectives: Bad Gateway/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByTestId("objective-card-blog-cadence")).toBeInTheDocument();
  });

  it("shows skeletons while loading", () => {
    managersObjectives.mockReturnValue(new Promise(() => {}));
    renderPane();
    expect(screen.getByTestId("objectives-loading")).toBeInTheDocument();
  });

  it("derives a valid id from any title", () => {
    expect(objectiveIdFrom("Grow awareness of Widget!")).toBe("grow-awareness-of-widget");
    expect(objectiveIdFrom("  Café — déjà vu  ")).toBe("cafe-deja-vu");
    expect(objectiveIdFrom("!!!")).toBe("");
    expect(objectiveIdFrom("a".repeat(100)).length).toBe(80);
  });
});
