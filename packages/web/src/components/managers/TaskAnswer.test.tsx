import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TaskAnswer } from "./TaskAnswer";
import { task } from "./testData";

const managersAnswerTask = vi.fn();
const managersWake = vi.fn();
vi.mock("../../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../../lib/api")>("../../lib/api");
  return {
    ...actual,
    api: {
      managersAnswerTask: (...a: unknown[]) => managersAnswerTask(...a),
      managersWake: (...a: unknown[]) => managersWake(...a),
    },
  };
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
  beforeEach(() => {
    managersAnswerTask.mockReset();
    managersWake.mockReset();
  });

  const noWake = { available: false, reason: "this project has no wake trigger", trigger: null };
  const roadmap = { available: true, reason: null, trigger: "roadmap" };
  const wakeItself = { available: true, reason: null, trigger: "wake" };

  it("with options: one primary button per option, and a click is the answer", async () => {
    managersAnswerTask.mockResolvedValue(result());
    const onAnswered = vi.fn();
    render(<TaskAnswer slug="widget-lib" task={ask} wake={{ available: false, reason: "the wake trigger is disabled" }} onAnswered={onAnswered} />);
    expect(screen.getByText(ask.ask!)).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).toBeNull();
    const merge = screen.getByRole("button", { name: "merge" });
    // t-261001-4cru: a real button, not a grey chip.
    expect(merge.className).toContain("bg-accent-solid");
    expect(merge.className).toContain("focus-visible:focus-ring");
    await userEvent.click(merge);
    expect(managersAnswerTask).toHaveBeenCalledWith("widget-lib", "t-260926-rn88", { choice: "merge" });
    await waitFor(() => expect(onAnswered).toHaveBeenCalledWith(expect.objectContaining({ episode: expect.anything() }), "merge"));
  });

  it("option buttons answer from the keyboard", async () => {
    managersAnswerTask.mockResolvedValue(result());
    render(<TaskAnswer slug="acme" task={ask} wake={noWake} onAnswered={vi.fn()} />);
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "merge" })).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "skip" })).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    expect(managersAnswerTask).toHaveBeenCalledWith("acme", ask.id, { choice: "skip" });
  });

  it("without options: a textarea, and Answer is disabled until there is text", async () => {
    managersAnswerTask.mockResolvedValue(result());
    const onAnswered = vi.fn();
    render(
      <TaskAnswer
        slug=""
        task={{ ...ask, options: [], ask: "What should the post say?" }}
        wake={{ available: false, reason: "this project has no wake trigger" }}
        onAnswered={onAnswered}
      />,
    );
    const answer = screen.getByRole("button", { name: "Answer" });
    expect(answer).toBeDisabled();
    await userEvent.type(screen.getByRole("textbox", { name: "Your answer" }), "  Keep it short  ");
    await userEvent.click(answer);
    expect(managersAnswerTask).toHaveBeenCalledWith("", "t-260926-rn88", { text: "Keep it short" });
    await waitFor(() => expect(onAnswered).toHaveBeenCalledWith(expect.anything(), "Keep it short"));
  });

  it("the old wake switch is gone", () => {
    render(<TaskAnswer slug="acme" task={ask} wake={{ available: true, reason: null }} onAnswered={vi.fn()} />);
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByText(/Wake the manager now/)).toBeNull();
  });

  it("nothing to wake: Answer & wake is hidden, with no disabled control or explanation", () => {
    render(<TaskAnswer slug="acme" task={ask} wake={{ available: false, reason: "the wake trigger is disabled" }} onAnswered={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /wake/ })).toBeNull();
    expect(screen.queryByText(/the wake trigger is disabled/)).toBeNull();
    expect(screen.queryByTestId("wake-hint")).toBeNull();
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["merge", "skip"]);
  });

  it("free text, nothing to wake: only Answer", () => {
    render(<TaskAnswer slug="" task={{ ...ask, options: [] }} wake={{ ...noWake, tasks: { [ask.id]: noWake } }} onAnswered={vi.fn()} />);
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Answer"]);
  });

  it("hides Answer & wake while availability is unknown", () => {
    render(<TaskAnswer slug="acme" task={{ ...ask, options: [] }} wake={null} onAnswered={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /wake/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Answer" })).toBeInTheDocument();
  });

  it("free text: Answer & wake sends wake: true, Answer does not", async () => {
    managersAnswerTask.mockResolvedValue(result({ wake: { fired: true, sessionId: "s1" } }));
    const free = { ...ask, options: [] };
    render(<TaskAnswer slug="acme" task={free} wake={{ ...wakeItself, tasks: { [ask.id]: wakeItself } }} onAnswered={vi.fn()} />);
    const both = screen.getByRole("button", { name: "Answer & wake" });
    expect(both).toBeDisabled();
    await userEvent.type(screen.getByRole("textbox", { name: "Your answer" }), "Ship it");
    await userEvent.click(both);
    expect(managersAnswerTask).toHaveBeenLastCalledWith("acme", ask.id, { text: "Ship it", wake: true });
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Your answer" })).toHaveValue(""));
    await userEvent.type(screen.getByRole("textbox", { name: "Your answer" }), "Again");
    await userEvent.click(screen.getByRole("button", { name: "Answer" }));
    expect(managersAnswerTask).toHaveBeenLastCalledWith("acme", ask.id, { text: "Again" });
  });

  it("options: each option has an “& wake” half that answers and wakes", async () => {
    managersAnswerTask.mockResolvedValue(result({ wake: { fired: true, sessionId: "s1" } }));
    render(<TaskAnswer slug="acme" task={ask} wake={{ available: true, reason: null }} onAnswered={vi.fn()} />);
    expect(screen.getByTestId("wake-hint")).toHaveTextContent("“& wake” also wakes the manager now.");
    await userEvent.click(screen.getByRole("button", { name: "skip & wake" }));
    expect(managersAnswerTask).toHaveBeenCalledWith("acme", "t-260926-rn88", { choice: "skip", wake: true });
    await userEvent.click(screen.getByRole("button", { name: "merge" }));
    expect(managersAnswerTask).toHaveBeenLastCalledWith("acme", "t-260926-rn88", { choice: "merge" });
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

  // t-261001-5ti7: the wake action targets the trigger that asked, per task.
  it("a task raised by roadmap in a project without wake: Answer & wake is offered and names roadmap", async () => {
    managersAnswerTask.mockResolvedValue(result({ wake: { fired: true, trigger: "roadmap", sessionId: "s1" } }));
    render(<TaskAnswer slug="managers" task={ask} wake={{ ...noWake, tasks: { [ask.id]: roadmap } }} onAnswered={vi.fn()} />);
    expect(screen.getByTestId("wake-hint")).toHaveTextContent("(runs roadmap)");
    await userEvent.click(screen.getByRole("button", { name: "merge & wake (roadmap)" }));
    expect(managersAnswerTask).toHaveBeenCalledWith("managers", ask.id, { choice: "merge", wake: true });
    expect(managersWake).not.toHaveBeenCalled();
  });

  it("free text raised by roadmap: the action reads “Answer & wake (roadmap)”", () => {
    render(<TaskAnswer slug="managers" task={{ ...ask, options: [] }} wake={{ ...noWake, tasks: { [ask.id]: roadmap } }} onAnswered={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Answer & wake (roadmap)" })).toBeInTheDocument();
  });

  it("names nothing extra when the target is wake itself", () => {
    render(<TaskAnswer slug="acme" task={{ ...ask, options: [] }} wake={{ ...wakeItself, tasks: { [ask.id]: wakeItself } }} onAnswered={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Answer & wake" })).toBeInTheDocument();
    expect(screen.queryByText(/\(wake\)/)).toBeNull();
  });

  it("a task the map predates asks for its own target (?task=)", async () => {
    managersWake.mockResolvedValue(roadmap);
    render(<TaskAnswer slug="managers" task={ask} wake={{ ...noWake, tasks: {} }} onAnswered={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /wake/ })).toBeNull();
    expect(await screen.findByRole("button", { name: "merge & wake (roadmap)" })).toBeEnabled();
    expect(managersWake).toHaveBeenCalledWith("managers", ask.id);
  });

  it("the task's own target wins over the workspace's: nothing to wake hides it", () => {
    const none = { available: false, reason: 'the roadmap trigger\'s behaviour "x" is off, and this project has no wake trigger', trigger: null };
    render(<TaskAnswer slug="managers" task={ask} wake={{ ...wakeItself, tasks: { [ask.id]: none } }} onAnswered={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /wake/ })).toBeNull();
    expect(screen.queryByText(/behaviour "x" is off/)).toBeNull();
  });
});
