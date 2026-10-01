import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { TaskDetailView } from "./TaskDetail";
import { taskDetail } from "./testData";

const managersTask = vi.fn();
vi.mock("../../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../../lib/api")>("../../lib/api");
  return { ...actual, api: { managersTask: (...a: unknown[]) => managersTask(...a) } };
});

function renderDetail() {
  return render(
    <MemoryRouter>
      <TaskDetailView slug="acme" base="/projects/acme" taskId="t-260926-aaaa" wake={null} objectiveTitle={() => undefined} />
    </MemoryRouter>,
  );
}

describe("TaskDetailView: Dispatched", () => {
  beforeEach(() => managersTask.mockReset());

  it("links each dispatched chat (new tab) when the server gave an href, and shows the rest as text", async () => {
    managersTask.mockResolvedValue(
      taskDetail({
        dispatched: [
          {
            connection: "paddock",
            project: "herdctl",
            chat: "3f2a9c1e-0000-4000-8000-000000000001",
            at: "2026-09-30T07:15:00Z",
            href: "https://paddock.example.test/projects/herdctl/chat/3f2a9c1e-0000-4000-8000-000000000001",
          },
          { connection: "gone", project: "widget-lib", chat: "s2", at: null, href: null },
        ],
      }),
    );
    renderDetail();
    const section = (await screen.findByText("Dispatched")).closest("section")!;
    const items = within(section).getAllByRole("listitem");
    expect(items).toHaveLength(2);

    const link = within(items[0]!).getByRole("link", { name: /Chat in herdctl/ });
    expect(link).toHaveAttribute("href", "https://paddock.example.test/projects/herdctl/chat/3f2a9c1e-0000-4000-8000-000000000001");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(within(items[0]!).getByText("via paddock")).toBeInTheDocument();
    expect(within(items[0]!).getByTitle("3f2a9c1e-0000-4000-8000-000000000001")).toHaveTextContent("3f2a9c1e…");

    // No href → no link, but the entry still says where it went.
    expect(within(items[1]!).queryByRole("link")).toBeNull();
    expect(items[1]).toHaveTextContent("Chat in widget-lib s2");
    expect(within(items[1]!).getByText("via gone")).toBeInTheDocument();
  });

  it("has no Dispatched section when nothing was dispatched", async () => {
    managersTask.mockResolvedValue(taskDetail({ title: "Quiet task" }));
    renderDetail();
    await screen.findByText("Quiet task");
    expect(screen.queryByText("Dispatched")).toBeNull();
  });
});
