import { test, expect } from "@playwright/test";
import { seedProject, uniq, writeProjectFile } from "./helpers";

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
  // No enabled wake trigger on a disk-seeded project: nothing to wake, so no
  // Answer & wake at all (t-261001-4cru) — and no switch.
  await expect(row.getByRole("button", { name: "tuesday", exact: true })).toBeVisible();
  await expect(row.getByRole("button", { name: /wake/ })).toHaveCount(0);
  await expect(row.getByRole("checkbox")).toHaveCount(0);

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

/**
 * Journey (t-261001-4cru): the two answer actions. A project whose `roadmap`
 * trigger raised two asks (and which has no `wake`): an options ask answered
 * with its option's "& wake" half fires roadmap; a free-text ask answered with
 * plain Answer fires nothing, though "Answer & wake (roadmap)" was on offer.
 */
test("Answer & wake fires the trigger that asked; Answer does not", async ({ page }) => {
  test.setTimeout(120_000);
  const created = await page.request.post("/api/projects", { data: { name: uniq("Answer Wake"), status: "active", domain: [] } });
  expect(created.ok()).toBe(true);
  const slug = (await created.json()).project.slug as string;
  const prompt = `Roadmap. [[MCP managers.record_episode ${JSON.stringify({ text: "Woken by an answer.", importance: 3, tags: "roadmap" })}]]`;
  const put = await page.request.put(`/api/projects/${slug}/triggers/roadmap`, {
    data: { trigger: { type: "schedule", cron: "0 3 1 1 *" }, run: { prompt, session: "new" }, enabled: true },
  });
  expect(put.ok(), await put.text()).toBe(true);

  const ask = (id: string, title: string, extra: string) =>
    `---\nid: ${id}\ntitle: ${title}\nstatus: awaiting-ed\nsource: manager\n${extra}raisedBy:\n  trigger: roadmap\n  run: r-261001-0900-ab12\ncreated: 2026-10-01T09:00:00Z\nupdated: 2026-10-01T09:00:00Z\n---\n\n## Log\n- 2026-10-01T09:00Z manager (run r-261001-0900-ab12): created, awaiting-ed\n`;
  writeProjectFile(slug, "tasks/open/t-261001-opt1.md", ask("t-261001-opt1", "Pick the launch day", 'ask: "Monday or Tuesday?"\noptions: [monday, tuesday]\n'));
  writeProjectFile(slug, "tasks/open/t-261001-txt1.md", ask("t-261001-txt1", "Name the release", 'ask: "What should we call it?"\n'));

  const roadmapRuns = async () => {
    const res = await page.request.get(`/api/projects/${slug}/managers/runs`);
    return ((await res.json()).runs as { trigger: string; status: string }[]).filter((r) => r.trigger === "roadmap");
  };

  await page.goto(`/projects/${slug}/tasks`);
  const opt = page.getByTestId("task-row-t-261001-opt1");
  const txt = page.getByTestId("task-row-t-261001-txt1");

  // The free-text ask: both actions, named for the trigger that asked. Plain
  // Answer saves it and wakes nothing.
  await expect(txt.getByRole("button", { name: "Answer & wake (roadmap)" })).toBeVisible();
  await txt.getByRole("textbox", { name: "Your answer" }).fill("Aurora");
  await txt.getByRole("button", { name: "Answer", exact: true }).click();
  await expect(page.getByText("Answered “Aurora”. The manager will see it on its next run.")).toBeVisible();
  await expect(page.getByTestId("task-row-t-261001-txt1")).toContainText("you answered “Aurora”");

  // The options ask: real buttons, each with an "& wake" half; pressed from the
  // keyboard, it answers AND fires roadmap.
  await expect(opt.getByTestId("wake-hint")).toHaveText("“& wake” also wakes the manager now (runs roadmap).");
  await opt.getByRole("button", { name: "tuesday & wake (roadmap)" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText("Answered “tuesday”. The manager has been woken (roadmap).")).toBeVisible();
  await expect(page.getByTestId("task-group-awaiting-ed")).toHaveCount(0);
  await expect.poll(async () => (await roadmapRuns()).map((r) => r.status), { timeout: 60_000, intervals: [500, 1000] }).toEqual(["succeeded"]);
  // Exactly one run: the plain Answer above fired nothing.
  expect(await roadmapRuns()).toHaveLength(1);
});
