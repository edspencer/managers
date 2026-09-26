import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { RootHome } from "./RootHome";

/**
 * Managers M3: `/` is always the ordinary root workspace. Upstream Paddock put
 * Discovery inline on an EMPTY instance's Home (#865); Managers projects are
 * notebooks created with "+ New project", so that first-run takeover is gone and
 * the empty Home is the normal one. `/discover` itself still exists.
 */
const useInstanceEmpty = vi.fn(() => ({ empty: true, recheck: vi.fn() }));
vi.mock("../lib/useInstanceEmpty", () => ({ useInstanceEmpty: () => useInstanceEmpty() }));
vi.mock("./ProjectView", () => ({
  ProjectView: ({ root, instanceEmpty }: { root?: boolean; instanceEmpty?: boolean | null }) => (
    <div data-testid="project-view" data-empty={String(instanceEmpty)}>
      {root ? "root" : "project"}
    </div>
  ),
}));

function renderHome() {
  return render(
    <MemoryRouter>
      <RootHome />
    </MemoryRouter>,
  );
}

describe("RootHome (Managers M3)", () => {
  it("renders the root workspace", () => {
    renderHome();
    expect(screen.getByTestId("project-view")).toHaveTextContent("root");
  });

  it("never marks the instance as first-run, so Discovery is never inlined", () => {
    renderHome();
    expect(screen.getByTestId("project-view")).toHaveAttribute("data-empty", "false");
  });

  it("does not even ask whether the instance is empty", () => {
    renderHome();
    expect(useInstanceEmpty).not.toHaveBeenCalled();
  });
});
