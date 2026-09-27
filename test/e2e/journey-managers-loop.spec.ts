import { execFileSync } from "node:child_process";
import { test, expect } from "@playwright/test";
import { paths, uniq } from "./helpers";

/**
 * Journey (Managers M13): the whole v1 loop, end to end, with the fake `claude`.
 *
 *   1. a project, created through the API (so its keeper and triggers are real);
 *   2. its `wake` trigger fires ("Run now"), and the turn's prompt drives the
 *      REAL `managers` MCP state tools — `update_objective` (creates it),
 *      `record_episode`, and `upsert_task` with `status: awaiting-ed`;
 *   3. the ROOT's Home shows the new ask in "Needs you";
 *   4. Ed answers it there;
 *   5. it disappears, the objective's journal holds both the wake's episode and
 *      the `#answer`, and git has a commit by `managers-bot` (the run) AND one by
 *      Ed (the answer).
 *
 * Runs on the GIT-enabled server (playwright.config.ts routes it there), whose
 * autocommit debounce is short and whose UI author is "Ed".
 */
test("a wake raises an ask, Home shows it, Ed answers it, and git records both", async ({ page }) => {
  test.setTimeout(120_000);
  const name = uniq("M13 Loop");
  const created = await page.request.post("/api/projects", { data: { name, status: "active", domain: [] } });
  expect(created.ok()).toBe(true);
  const slug = (await created.json()).project.slug as string;

  const mcp = (tool: string, args: Record<string, unknown>) => `[[MCP managers.${tool} ${JSON.stringify(args)}]]`;
  const prompt = [
    "Wake.",
    mcp("update_objective", {
      id: "launch",
      title: "Launch the site",
      success: "The site is live.",
      where_we_are: "Copy is drafted; the launch day is undecided.",
    }),
    mcp("record_episode", { text: "Drafted the launch copy; need a launch day.", importance: 5, tags: "wake, launch", objective: "launch" }),
    mcp("upsert_task", {
      title: "Pick the launch day",
      status: "awaiting-ed",
      ask: "Launch on Monday or Tuesday?",
      options: "monday, tuesday",
      objective: "launch",
    }),
  ].join(" ");
  const put = await page.request.put(`/api/projects/${slug}/triggers/wake`, {
    data: { trigger: { type: "schedule", cron: "0 3 1 1 *" }, run: { prompt, session: "new" }, enabled: false },
  });
  expect(put.ok(), await put.text()).toBe(true);

  // Run now: the one trigger fire path, which writes the run record.
  const fired = await page.request.post(`/api/projects/${slug}/triggers/wake/run`);
  expect(fired.status(), await fired.text()).toBe(202);
  await expect
    .poll(
      async () => {
        const res = await page.request.get(`/api/projects/${slug}/managers/runs`);
        const runs = (await res.json()).runs as { trigger: string; status: string }[];
        return runs.find((r) => r.trigger === "wake")?.status ?? "none";
      },
      { timeout: 60_000, intervals: [500, 1000] },
    )
    .toBe("succeeded");

  // The root's Home: the ask is in Needs you, under this project.
  await page.goto("/");
  const group = page.getByTestId(`needs-you-group-${slug}`);
  await expect(group).toBeVisible();
  await expect(page.getByTestId(`needs-you-project-${slug}`)).toHaveText(name);
  await expect(group).toContainText("Pick the launch day");
  await expect(group).toContainText("Launch on Monday or Tuesday?");

  await group.getByRole("button", { name: "tuesday", exact: true }).click();
  await expect(page.getByText(/Answered “tuesday”\./)).toBeVisible();
  await expect(group).toHaveCount(0);
  // Still gone after a reload: it was answered, not hidden.
  await page.reload();
  await expect(page.getByTestId("needs-you")).toBeVisible();
  await expect(page.getByTestId(`needs-you-group-${slug}`)).toHaveCount(0);

  // The objective the wake created, with both episodes on its journal.
  await page.goto(`/projects/${slug}/objectives/launch`);
  await expect(page.getByRole("heading", { name: "Launch the site" })).toBeVisible();
  const entries = page.getByTestId("journal-entry");
  await expect(entries.filter({ hasText: "Drafted the launch copy" })).toHaveCount(1);
  await expect(entries.filter({ hasText: "#answer" })).toHaveCount(1);

  // Git: the run's writes committed as the bot, the answer as Ed.
  const { projectsDir } = paths({ git: true });
  const authors = () =>
    execFileSync("git", ["log", "--format=%an", "--", slug], { cwd: projectsDir, encoding: "utf8" })
      .split("\n")
      .filter(Boolean);
  await expect.poll(authors, { timeout: 30_000, intervals: [500, 1000] }).toEqual(
    expect.arrayContaining(["managers-bot", "Ed"]),
  );
});
