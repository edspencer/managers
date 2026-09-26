import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NewProjectModal, parseGithubRepo } from "./NewProjectModal";
import { makeProject } from "../test/factories";

// Mock the api client so we can assert the payload the modal builds.
const createProject = vi.fn();
vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return { ...actual, api: { createProject: (...a: unknown[]) => createProject(...a) } };
});

describe("NewProjectModal", () => {
  beforeEach(() => {
    createProject.mockReset();
    createProject.mockResolvedValue(makeProject({ slug: "new-one", name: "New One" }));
  });

  it("does not render when closed", () => {
    const { container } = render(
      <NewProjectModal open={false} onClose={() => {}} onCreated={() => {}} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("disables Create until a name is entered (validation)", async () => {
    render(<NewProjectModal open onClose={() => {}} onCreated={() => {}} />);
    const submit = screen.getByRole("button", { name: /create project/i });
    expect(submit).toBeDisabled();
    await userEvent.type(screen.getByPlaceholderText(/Garage Water Heater/i), "My Project");
    expect(submit).toBeEnabled();
  });

  it("does not call the API when name is blank on submit", () => {
    render(<NewProjectModal open onClose={() => {}} onCreated={() => {}} />);
    // Submitting the form directly (bypassing the disabled button) is a no-op.
    fireEvent.submit(screen.getByRole("button", { name: /create project/i }).closest("form")!);
    expect(createProject).not.toHaveBeenCalled();
  });

  it("builds the create payload: name trimmed, area, summary, and split/trimmed/filtered tags", async () => {
    const onCreated = vi.fn();
    render(<NewProjectModal open onClose={() => {}} onCreated={onCreated} />);

    await userEvent.type(screen.getByPlaceholderText(/Garage Water Heater/i), "  Water Heater  ");
    await userEvent.type(screen.getByPlaceholderText(/One line on what/i), "  fix the heater  ");
    await userEvent.type(screen.getByPlaceholderText(/home, plumbing/i), "home, , plumbing ,");
    // Pick an area.
    fireEvent.change(screen.getByDisplayValue("Unsorted"), { target: { value: "homelab" } });
    // Status defaults to "active".

    fireEvent.click(screen.getByRole("button", { name: /create project/i }));

    await waitFor(() => expect(createProject).toHaveBeenCalledTimes(1));
    expect(createProject).toHaveBeenCalledWith({
      name: "Water Heater",
      status: "active",
      group: "homelab",
      summary: "fix the heater",
      domain: ["home", "plumbing"],
    });
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
  });

  it("omits group when Unsorted and summary when blank", async () => {
    render(<NewProjectModal open onClose={() => {}} onCreated={() => {}} />);
    await userEvent.type(screen.getByPlaceholderText(/Garage Water Heater/i), "Bare");
    fireEvent.click(screen.getByRole("button", { name: /create project/i }));
    await waitFor(() => expect(createProject).toHaveBeenCalled());
    const payload = createProject.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.group).toBeUndefined();
    expect(payload.summary).toBeUndefined();
    expect(payload.domain).toEqual([]);
  });

  // Managers M3: projects are notebooks. The clone-URL and directory options
  // are gone from the modal; a GitHub repo is recorded as a link, never cloned.
  it("offers no repo/clone or directory option (Managers M3)", () => {
    render(<NewProjectModal open onClose={() => {}} onCreated={() => {}} />);
    expect(screen.queryByText(/Git repository URL/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Directory on this machine/i)).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText("/home/ed/Code/foo")).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.getByText(/Nothing is cloned/i)).toBeInTheDocument();
  });

  it("creates a plain notebook: never sends repo, path or managed", async () => {
    render(<NewProjectModal open onClose={() => {}} onCreated={() => {}} />);
    await userEvent.type(screen.getByPlaceholderText(/Garage Water Heater/i), "Notebook");
    fireEvent.click(screen.getByRole("button", { name: /create project/i }));
    await waitFor(() => expect(createProject).toHaveBeenCalled());
    const payload = createProject.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.repo).toBeUndefined();
    expect(payload.path).toBeUndefined();
    expect(payload.managed).toBeUndefined();
    expect(payload.links).toBeUndefined();
  });

  it("stores a GitHub owner/name as a link, not a clone", async () => {
    render(<NewProjectModal open onClose={() => {}} onCreated={() => {}} />);
    await userEvent.type(screen.getByPlaceholderText(/Garage Water Heater/i), "Widget");
    await userEvent.type(screen.getByPlaceholderText("owner/name"), "  acme/widget-lib  ");
    fireEvent.click(screen.getByRole("button", { name: /create project/i }));
    await waitFor(() => expect(createProject).toHaveBeenCalled());
    const payload = createProject.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.links).toEqual([{ label: "GitHub", url: "https://github.com/acme/widget-lib" }]);
    expect(payload.repo).toBeUndefined();
  });

  it("accepts a pasted github.com URL and normalises it to owner/name", async () => {
    render(<NewProjectModal open onClose={() => {}} onCreated={() => {}} />);
    await userEvent.type(screen.getByPlaceholderText(/Garage Water Heater/i), "Widget");
    await userEvent.type(
      screen.getByPlaceholderText("owner/name"),
      "https://github.com/acme/widget-lib.git",
    );
    fireEvent.click(screen.getByRole("button", { name: /create project/i }));
    await waitFor(() => expect(createProject).toHaveBeenCalled());
    const payload = createProject.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.links).toEqual([{ label: "GitHub", url: "https://github.com/acme/widget-lib" }]);
  });

  it("rejects a malformed GitHub repo without calling the API, and stays open", async () => {
    const onCreated = vi.fn();
    render(<NewProjectModal open onClose={() => {}} onCreated={onCreated} />);
    await userEvent.type(screen.getByPlaceholderText(/Garage Water Heater/i), "Widget");
    await userEvent.type(screen.getByPlaceholderText("owner/name"), "not a repo");
    fireEvent.click(screen.getByRole("button", { name: /create project/i }));
    expect(await screen.findByText(/must look like owner\/name/i)).toBeInTheDocument();
    expect(createProject).not.toHaveBeenCalled();
    expect(onCreated).not.toHaveBeenCalled();
  });

  it("surfaces an API error and stays open", async () => {
    const { ApiError } = await vi.importActual<typeof import("../lib/api")>("../lib/api");
    createProject.mockRejectedValueOnce(new ApiError("Project already exists: bare", 409));
    const onCreated = vi.fn();
    render(<NewProjectModal open onClose={() => {}} onCreated={onCreated} />);
    await userEvent.type(screen.getByPlaceholderText(/Garage Water Heater/i), "Bare");
    fireEvent.click(screen.getByRole("button", { name: /create project/i }));
    await waitFor(() =>
      expect(screen.getByText(/Project already exists/i)).toBeInTheDocument(),
    );
    expect(onCreated).not.toHaveBeenCalled();

    // The error must PERSIST after the busy→idle toggle settles (regression: the
    // reset effect used to re-fire on `busy` and wipe both the error and the
    // form). Give the finally() re-render a chance to land, then re-assert.
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByText(/Project already exists/i)).toBeInTheDocument();
    // The typed name is retained so the user can fix + resubmit (not blanked).
    expect(screen.getByPlaceholderText(/Garage Water Heater/i)).toHaveValue("Bare");
  });
});

describe("parseGithubRepo (Managers M3)", () => {
  it.each([
    ["acme/widget", "acme/widget"],
    ["  acme/widget  ", "acme/widget"],
    ["https://github.com/acme/widget", "acme/widget"],
    ["https://www.github.com/acme/widget.git", "acme/widget"],
    ["github.com/acme/widget/", "acme/widget"],
    ["acme/widget.js", "acme/widget.js"],
  ])("%s → %s", (input, out) => {
    expect(parseGithubRepo(input)).toBe(out);
  });

  it.each(["", "acme", "acme/", "/widget", "acme/widget/extra", "a b/c", "https://gitlab.com/a/b", "acme/..", "-acme/x"])(
    "rejects %j",
    (input) => {
      expect(parseGithubRepo(input)).toBeNull();
    },
  );
});
