import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TaskAnswer } from "./TaskAnswer";
import { task } from "./testData";

const managersAnswerTask = vi.fn();
vi.mock("../../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../../lib/api")>("../../lib/api");
  return { ...actual, api: { managersAnswerTask: (...a: unknown[]) => managersAnswerTask(...a) } };
});

const ask = task({
  id: "t-260926-rn88",
  status: "awaiting-ed",
  ask: "Renovate #88 bumps a major version; merge?",
  options: ["merge", "skip"],
});
const result = (over = {}) => ({
  task: { ...ask, status: "open" },
  episode: { id: "ep-1", file: "log/2026-09.md", importance: 5, objective: null },
  ...over,
});

describe("TaskAnswer (Managers M11)", () => {
  beforeEach(() => managersAnswerTask.mockReset());

  it("with options: one button per option, and a click is the answer", async () => {
    managersAnswerTask.mockResolvedValue(result());
    const onAnswered = vi.fn();
    render(<TaskAnswer slug="widget-lib" task={ask} wake={{ available: false, reason: "the wake trigger is disabled" }} onAnswered={onAnswered} />);
    expect(screen.getByText(ask.ask!)).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "merge" }));
    expect(managersAnswerTask).toHaveBeenCalledWith("widget-lib", "t-260926-rn88", { choice: "merge" });
    await waitFor(() => expect(onAnswered).toHaveBeenCalledWith(expect.objectContaining({ episode: expect.anything() }), "merge"));
  });

  it("without options: a textarea, and Send is disabled until there is text", async () => {
    managersAnswerTask.mockResolvedValue(result());
    const onAnswered = vi.fn();
    render(
      <TaskAnswer
        slug=""
        task={{ ...ask, options: [], ask: "What should the post say?" }}
        wake={{ available: true, reason: null }}
        onAnswered={onAnswered}
      />,
    );
    const send = screen.getByRole("button", { name: "Send answer" });
    expect(send).toBeDisabled();
    await userEvent.type(screen.getByRole("textbox", { name: "Your answer" }), "  Keep it short  ");
    await userEvent.click(send);
    expect(managersAnswerTask).toHaveBeenCalledWith("", "t-260926-rn88", { text: "Keep it short" });
    await waitFor(() => expect(onAnswered).toHaveBeenCalledWith(expect.anything(), "Keep it short"));
  });

  it("disables the wake switch, with the reason, when no enabled wake exists", () => {
    render(<TaskAnswer slug="acme" task={ask} wake={{ available: false, reason: "the wake trigger is disabled" }} onAnswered={vi.fn()} />);
    const sw = screen.getByRole("checkbox", { name: "Wake the manager now" });
    expect(sw).toBeDisabled();
    expect(sw).not.toBeChecked();
    expect(screen.getByTestId("wake-reason")).toHaveTextContent("the wake trigger is disabled");
  });

  it("keeps the switch disabled while availability is unknown", () => {
    render(<TaskAnswer slug="acme" task={ask} wake={null} onAnswered={vi.fn()} />);
    expect(screen.getByRole("checkbox", { name: "Wake the manager now" })).toBeDisabled();
  });

  it("sends wake: true only when the switch is on and a wake is available", async () => {
    managersAnswerTask.mockResolvedValue(result({ wake: { fired: true, sessionId: "s1" } }));
    render(<TaskAnswer slug="acme" task={ask} wake={{ available: true, reason: null }} onAnswered={vi.fn()} />);
    const sw = screen.getByRole("checkbox", { name: "Wake the manager now" });
    expect(sw).toBeEnabled();
    await userEvent.click(sw);
    await userEvent.click(screen.getByRole("button", { name: "skip" }));
    expect(managersAnswerTask).toHaveBeenCalledWith("acme", "t-260926-rn88", { choice: "skip", wake: true });
  });

  // M15: in the real-Claude shakedown a click on the words did nothing.
  it("toggles the wake switch when its text is clicked", async () => {
    render(<TaskAnswer slug="acme" task={ask} wake={{ available: true, reason: null }} onAnswered={vi.fn()} />);
    const sw = screen.getByRole("checkbox", { name: "Wake the manager now" });
    await userEvent.click(screen.getByText("Wake the manager now"));
    expect(sw).toBeChecked();
  });

  it("shows the server's message on a 4xx and keeps the form usable", async () => {
    const { ApiError } = await import("../../lib/api");
    managersAnswerTask.mockRejectedValue(new ApiError("Task t-260926-rn88 is not awaiting-ed", 409, "conflict"));
    const onAnswered = vi.fn();
    render(<TaskAnswer slug="acme" task={ask} wake={{ available: false, reason: "x" }} onAnswered={onAnswered} />);
    await userEvent.click(screen.getByRole("button", { name: "merge" }));
    expect(await screen.findByTestId("task-answer-error")).toHaveTextContent("is not awaiting-ed");
    expect(onAnswered).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "merge" })).toBeEnabled();
  });
});
