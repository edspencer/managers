import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BehavioursSection } from "./BehavioursSection";
import type { Behaviour, BehaviourList } from "../../lib/types";

const managersBehaviours = vi.fn();
const managersSetBehaviour = vi.fn();
const managersAcknowledgeBehaviours = vi.fn();
vi.mock("../../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../../lib/api")>("../../lib/api");
  return {
    ...actual,
    api: {
      managersBehaviours: (...a: unknown[]) => managersBehaviours(...a),
      managersSetBehaviour: (...a: unknown[]) => managersSetBehaviour(...a),
      managersAcknowledgeBehaviours: (...a: unknown[]) => managersAcknowledgeBehaviours(...a),
    },
  };
});

function beh(over: Partial<Behaviour> = {}): Behaviour {
  return {
    name: "triage-external-prs",
    enabled: false,
    description: "Triage PRs from outside contributors.",
    triggers: ["triage-prs"],
    tools: ["mcp__paddock__create_chat"],
    instructions: "",
    origin: "home",
    inherited: true,
    overridden: false,
    boundTriggers: [{ name: "triage-prs", exists: true, enabled: true, type: "schedule" }],
    ...over,
  };
}

const list = (behaviours: Behaviour[], changedOutsideUi = false): BehaviourList => ({
  behaviours,
  changedOutsideUi,
  changedSince: changedOutsideUi ? "2026-09-26T08:00:00.000Z" : null,
});

describe("BehavioursSection (Managers M8)", () => {
  beforeEach(() => {
    managersBehaviours.mockReset();
    managersSetBehaviour.mockReset();
    managersAcknowledgeBehaviours.mockReset();
  });

  it("shows an inherited behaviour OFF with its badge, triggers and tools", async () => {
    managersBehaviours.mockResolvedValue(list([beh()]));
    render(<BehavioursSection slug="widget-lib" />);
    const row = await screen.findByTestId("behaviour-triage-external-prs");
    expect(within(row).getByText("Inherited from Home")).toBeInTheDocument();
    expect(within(row).getByText("Off")).toBeInTheDocument();
    expect(within(row).getByText(/trigger triage-prs/)).toBeInTheDocument();
    expect(within(row).getByText("mcp__paddock__create_chat")).toBeInTheDocument();
    expect(within(row).getByRole("checkbox")).not.toBeChecked();
    // No project-defined behaviours: the empty state explains how to add one.
    expect(screen.getByText("No behaviours defined in this project")).toBeInTheDocument();
  });

  it("switches a behaviour on through the PATCH route and confirms with a toast", async () => {
    // The reload after a switch returns the server's new state.
    managersBehaviours.mockResolvedValueOnce(list([beh()])).mockResolvedValue(list([beh({ enabled: true })]));
    managersSetBehaviour.mockResolvedValue({ behaviour: beh({ enabled: true }), changed: true });
    render(<BehavioursSection slug="widget-lib" />);
    const row = await screen.findByTestId("behaviour-triage-external-prs");
    await userEvent.click(within(row).getByRole("checkbox"));
    expect(managersSetBehaviour).toHaveBeenCalledWith("widget-lib", "triage-external-prs", true);
    expect(await screen.findByText(/is on: the manager may act on it/)).toBeInTheDocument();
    await waitFor(() =>
      expect(within(screen.getByTestId("behaviour-triage-external-prs")).getByText("On")).toBeInTheDocument(),
    );
  });

  it("shows an error toast when the switch fails, leaving the row off", async () => {
    const { ApiError } = await import("../../lib/api");
    managersBehaviours.mockResolvedValue(list([beh()]));
    managersSetBehaviour.mockRejectedValue(new ApiError("No such behaviour: triage-external-prs", 404));
    render(<BehavioursSection slug="widget-lib" />);
    const row = await screen.findByTestId("behaviour-triage-external-prs");
    await userEvent.click(within(row).getByRole("checkbox"));
    expect(await screen.findByText("No such behaviour: triage-external-prs")).toBeInTheDocument();
    expect(within(row).getByText("Off")).toBeInTheDocument();
  });

  it("the true empty state: no behaviours at all", async () => {
    managersBehaviours.mockResolvedValue(list([]));
    render(<BehavioursSection slug="empty-project" />);
    expect(await screen.findByText("No behaviours defined in this project")).toBeInTheDocument();
    expect(screen.getByText(/behaviours:/, { selector: "code" })).toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("a project-defined behaviour carries no inherited badge; a built-in says so", async () => {
    managersBehaviours.mockResolvedValue(
      list([
        beh({ name: "draft-release-notes", origin: "project", inherited: false, boundTriggers: [], tools: [] }),
        beh({ name: "consolidate-memory", origin: "builtin", boundTriggers: [{ name: "consolidate", exists: false, enabled: false, type: null }], tools: [] }),
      ]),
    );
    render(<BehavioursSection slug="widget-lib" />);
    const own = await screen.findByTestId("behaviour-draft-release-notes");
    expect(within(own).queryByText("Inherited from Home")).toBeNull();
    const builtin = screen.getByTestId("behaviour-consolidate-memory");
    expect(within(builtin).getByText("Built in")).toBeInTheDocument();
    expect(within(builtin).getByText(/trigger consolidate · missing/)).toBeInTheDocument();
    expect(screen.queryByText("No behaviours defined in this project")).toBeNull();
  });

  it("an out-of-UI change shows a notice that Acknowledge clears", async () => {
    managersBehaviours.mockResolvedValueOnce(list([beh()], true)).mockResolvedValue(list([beh()]));
    managersAcknowledgeBehaviours.mockResolvedValue(undefined);
    render(<BehavioursSection slug="widget-lib" />);
    expect(await screen.findByText(/Behaviours changed outside Settings/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Acknowledge" }));
    await waitFor(() => expect(screen.queryByText(/Behaviours changed outside Settings/)).toBeNull());
    expect(managersAcknowledgeBehaviours).toHaveBeenCalledWith("widget-lib");
  });

  it("M14: consolidate-memory shows its schedule, early-fire threshold and model", async () => {
    managersBehaviours.mockResolvedValue(
      list([
        beh({
          name: "consolidate-memory",
          origin: "builtin",
          triggers: ["consolidate"],
          tools: [],
          boundTriggers: [{ name: "consolidate", exists: true, enabled: false, type: "schedule" }],
          config: { schedule: "30 3 * * *", threshold: 40, minGapHours: 6, model: "claude-sonnet-5" },
        }),
        beh(),
      ]),
    );
    render(<BehavioursSection slug="acme-site" />);
    const sched = await screen.findByTestId("behaviour-consolidate-memory-schedule");
    expect(sched).toHaveTextContent("schedule 30 3 * * *");
    expect(sched).toHaveTextContent("early at importance 40, 6h apart");
    expect(sched).toHaveTextContent("claude-sonnet-5");
    // A derived trigger is not "missing".
    expect(within(screen.getByTestId("behaviour-consolidate-memory")).getByText(/trigger consolidate/)).not.toHaveTextContent("missing");
    // A behaviour with no config shows no schedule row.
    expect(screen.queryByTestId("behaviour-triage-external-prs-schedule")).toBeNull();
  });

  it("a load failure is shown, not a blank card", async () => {
    const { ApiError } = await import("../../lib/api");
    managersBehaviours.mockRejectedValue(new ApiError("boom", 500));
    render(<BehavioursSection slug="widget-lib" />);
    expect(await screen.findByText("boom")).toBeInTheDocument();
  });
});
