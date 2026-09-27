import { test, expect } from "@playwright/test";
import { seedProject, uniq } from "./helpers";

/**
 * Journey (Managers M11): Ed answers a task the manager is waiting on, in place,
 * and it leaves "Awaiting you".
 *
 * The task and objective are plain files on disk — exactly what an agent's
 * `upsert_task` / `update_objective` would have written — so the journey covers
 * the real read routes, the real answer route and a reload.
 */
test("answer an awaiting task from the Tasks tab and see it leave Awaiting you", async ({ page }) => {
  const slug = seedProject({
    name: uniq("M11 Tasks"),
    files: {
      "objectives/launch/objective.md":
        "---\ntitle: Launch the site\nstatus: active\nsuccess: The site is live.\n---\n## Where we are\nCopy is done.\n## Strategy\nShip small.\n## Lessons\n",
      "tasks/open/t-260926-ask1.md":
        '---\nid: t-260926-ask1\ntitle: Pick the launch day\nstatus: awaiting-ed\nobjective: launch\nsource: manager\nask: "Launch on Monday or Tuesday?"\noptions: [monday, tuesday]\ncreated: 2026-09-26T08:00:00Z\nupdated: 2026-09-26T08:00:00Z\n---\n\n## Log\n- 2026-09-26T08:00Z manager: created, awaiting-ed\n',
      "tasks/open/t-260926-opn1.md":
        "---\nid: t-260926-opn1\ntitle: Write the launch post\nstatus: open\nobjective: launch\nsource: manager\ncreated: 2026-09-26T08:00:00Z\nupdated: 2026-09-26T08:00:00Z\n---\n\n## Log\n- 2026-09-26T08:00Z manager: created, open\n",
    },
  });

  await page.goto(`/projects/${slug}/tasks`);
  const tabs = page.getByTestId("workspace-tabs");
  await expect(tabs.getByRole("button", { name: "Tasks", exact: true })).toBeVisible();

  const awaiting = page.getByTestId("task-group-awaiting-ed");
  await expect(awaiting).toHaveText(/Awaiting you \(1\)/);
  const row = page.getByTestId("task-row-t-260926-ask1");
  await expect(row.getByText("Launch on Monday or Tuesday?")).toBeVisible();
  // No enabled wake trigger on a disk-seeded project: the switch says why.
  await expect(row.getByRole("checkbox", { name: "Wake the manager now" })).toBeDisabled();

  await row.getByRole("button", { name: "tuesday", exact: true }).click();
  await expect(page.getByText(/Answered “tuesday”\./)).toBeVisible();
  await expect(awaiting).toHaveCount(0);
  await expect(page.getByTestId("task-group-open")).toHaveText(/Open \(2\)/);
  await expect(page.getByTestId("task-row-t-260926-ask1")).toContainText("you answered “tuesday”");

  // It persisted: a reload reads it back from the file.
  await page.reload();
  await expect(page.getByTestId("task-group-open")).toHaveText(/Open \(2\)/);
  await expect(page.getByTestId("task-group-awaiting-ed")).toHaveCount(0);

  // The answer is on the objective's journal.
  await page.goto(`/projects/${slug}/objectives/launch`);
  await expect(page.getByRole("heading", { name: "Launch the site" })).toBeVisible();
  await expect(page.getByTestId("journal-entry").first()).toContainText("t-260926-ask1");
  await expect(page.getByTestId("journal-entry").first()).toContainText("#answer");
});
