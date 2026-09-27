/**
 * Managers M13: `GET /api/managers/needs-you`, Home's cross-project collation, on
 * the REAL app over a seeded data dir.
 *
 * Covers the shape, the order (asks longest-waiting first, then unreadable
 * workspaces, then alert-only ones worst-first, then quiet ones), `?all=1`, the
 * status-report age, unreadable task files, and a per-project error from a
 * corrupt task directory that must not take the other workspaces down with it.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { startTestApp, type TestApp } from "../helpers/app.js";

let t: TestApp;

async function put(rel: string, text: string): Promise<void> {
  const abs = path.join(t.projectsRoot, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, text, "utf8");
}

const get = async (url: string) => {
  const res = await t.app.inject({ method: "GET", url });
  return { status: res.statusCode, body: res.json() as Record<string, any> };
};

const ASK = (id: string, updated: string, extra = "") =>
  `---\nid: ${id}\ntitle: Ask ${id}\nstatus: awaiting-ed\nask: "Which?"\noptions: [a, b]\n${extra}created: 2026-09-01T00:00:00Z\nupdated: ${updated}\n---\n## Log\n- created\n`;
const OPEN = (id: string) =>
  `---\nid: ${id}\ntitle: Open ${id}\nstatus: open\ncreated: 2026-09-01T00:00:00Z\nupdated: 2026-09-01T00:00:00Z\n---\n`;
const yaml = (slug: string, name: string, extra = "") => `name: ${name}\nslug: ${slug}\nstatus: active\n${extra}`;

const HOURS = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString().replace(/\.\d{3}Z$/, "Z");

beforeAll(async () => {
  t = await startTestApp();
  // alpha: one ask, raised recently; a fresh status report.
  await put("alpha/project.yaml", yaml("alpha", "Alpha"));
  await put("alpha/tasks/open/t-260920-aaaa.md", ASK("t-260920-aaaa", "2026-09-25T10:00:00Z"));
  await put("alpha/tasks/open/t-260920-aopn.md", OPEN("t-260920-aopn"));
  await put("alpha/reports/status/current.md", `---\ntype: status\ngenerated: ${HOURS(1)}\n---\n# Status\nFine.\n`);
  // bravo: two asks, one of them the longest-waiting of all; a 3-day-old report.
  await put("bravo/project.yaml", yaml("bravo", "Bravo"));
  await put("bravo/tasks/open/t-260920-bbb1.md", ASK("t-260920-bbb1", "2026-09-26T10:00:00Z"));
  await put("bravo/tasks/open/t-260920-bbb2.md", ASK("t-260920-bbb2", "2026-09-10T10:00:00Z"));
  await put("bravo/reports/status/current.md", `---\ntype: status\ngenerated: ${HOURS(72)}\n---\n# Status\nOld.\n`);
  // charlie: alerts only — a failed run of an enabled trigger (run-failed is an error).
  await put(
    "charlie/project.yaml",
    yaml(
      "charlie",
      "Charlie",
      'triggers:\n  wake:\n    trigger: { type: schedule, cron: "0 3 1 1 *" }\n    run: { prompt: "Wake." }\n    enabled: true\n',
    ),
  );
  const month = new Date().toISOString().slice(0, 7);
  await put(
    `charlie/runs/${month}/r-260901-0100-aa.yaml`,
    `id: r-260901-0100-aa\ntrigger: wake\nkind: wake\nstatus: failed\nstarted: ${HOURS(2)}\nfinished: ${HOURS(2)}\nerror: boom\n`,
  );
  // delta: an unreadable task file only.
  await put("delta/project.yaml", yaml("delta", "Delta"));
  await put("delta/tasks/open/t-260920-dddd.md", "---\nid: t-260920-dddd\ntitle: broken\nstatus: someday\n---\n");
  // echo: quiet (an open task, nothing awaiting, no alerts).
  await put("echo/project.yaml", yaml("echo", "Echo"));
  await put("echo/tasks/open/t-260920-eeee.md", OPEN("t-260920-eeee"));
  // foxtrot: a corrupt task directory — `tasks/open` is a symlink to itself, so
  // reading it throws ELOOP. (A chmod 000 would not stop a test run as root, and
  // the stores read ENOENT/ENOTDIR as "no tasks yet".)
  await put("foxtrot/project.yaml", yaml("foxtrot", "Foxtrot"));
  await fs.mkdir(path.join(t.projectsRoot, "foxtrot/tasks"), { recursive: true });
  await fs.symlink("open", path.join(t.projectsRoot, "foxtrot/tasks/open"));
  // Home: its own ask, the newest of all.
  await put("tasks/open/t-260921-hhhh.md", ASK("t-260921-hhhh", "2026-09-27T10:00:00Z"));
});
afterAll(async () => t.teardown());

describe("integration: GET /api/managers/needs-you", () => {
  it("collates every workspace in order, with a per-project error that spares the others", async () => {
    const { status, body } = await get("/api/managers/needs-you");
    expect(status).toBe(200);
    expect(Date.parse(body.generatedAt)).not.toBeNaN();
    // asks (longest-waiting first: bravo's Sep 10 < alpha's Sep 25 < Home's Sep 27),
    // then the unreadable foxtrot, then charlie (an error alert) before delta (parse error only).
    expect(body.projects.map((p: { slug: string }) => p.slug)).toEqual(["bravo", "alpha", "", "foxtrot", "charlie", "delta"]);
    expect(body.totals).toEqual({ checked: 7, needsYou: 4, alerts: 1, errors: 1, withItems: 5 });

    const [bravo, alpha, home, foxtrot, charlie, delta] = body.projects;
    expect(bravo.name).toBe("Bravo");
    expect(bravo.needsYou.map((x: { id: string }) => x.id).sort()).toEqual(["t-260920-bbb1", "t-260920-bbb2"]);
    expect(bravo.status.stale).toBe(true);
    expect(alpha.needsYou).toHaveLength(1);
    expect(alpha.needsYou[0]).toMatchObject({ id: "t-260920-aaaa", status: "awaiting-ed", ask: "Which?", options: ["a", "b"] });
    expect(alpha.status).toMatchObject({ stale: false, generated: expect.any(String) });
    expect(alpha.alerts).toEqual([]);
    expect(home).toMatchObject({ slug: "", name: "Home" });
    expect(home.needsYou.map((x: { id: string }) => x.id)).toEqual(["t-260921-hhhh"]);
    expect(home.status).toEqual({ generated: null, stale: false });

    // The broken workspace: an error row, with no absolute path in it.
    expect(foxtrot).toEqual({ slug: "foxtrot", name: "Foxtrot", error: expect.stringMatching(/ELOOP.*tasks\/open/) });
    expect(foxtrot.error).not.toContain(t.projectsRoot);

    expect(charlie.needsYou).toEqual([]);
    expect(charlie.alerts).toEqual([expect.objectContaining({ kind: "run-failed", severity: "error", trigger: "wake" })]);
    expect(delta.parseErrors).toEqual([{ file: "tasks/open/t-260920-dddd.md", error: expect.stringMatching(/status/) }]);
  });

  it("agrees with the per-workspace routes", async () => {
    const { body } = await get("/api/managers/needs-you");
    const charlie = body.projects.find((p: { slug: string }) => p.slug === "charlie");
    const alerts = await get("/api/projects/charlie/managers/alerts");
    expect(charlie.alerts).toEqual(alerts.body);
    const alpha = body.projects.find((p: { slug: string }) => p.slug === "alpha");
    const tasks = await get("/api/projects/alpha/managers/tasks?status=awaiting-ed");
    expect(alpha.needsYou).toEqual(tasks.body.tasks);
  });

  it("?all=1 includes quiet workspaces, last, with empty arrays", async () => {
    const { status, body } = await get("/api/managers/needs-you?all=1");
    expect(status).toBe(200);
    const slugs = body.projects.map((p: { slug: string }) => p.slug);
    expect(slugs).toEqual(["bravo", "alpha", "", "foxtrot", "charlie", "delta", "echo"]);
    expect(body.projects[6]).toEqual({
      slug: "echo",
      name: "Echo",
      needsYou: [],
      alerts: [],
      status: { generated: null, stale: false },
      parseErrors: [],
    });
    expect(body.totals.checked).toBe(7);
  });

  it("answering the last ask drops the workspace from the default list", async () => {
    const res = await t.app.inject({
      method: "POST",
      url: "/api/projects/alpha/managers/tasks/t-260920-aaaa/answer",
      payload: { choice: "a" },
    });
    expect(res.statusCode).toBe(200);
    const { body } = await get("/api/managers/needs-you");
    expect(body.projects.map((p: { slug: string }) => p.slug)).not.toContain("alpha");
    expect(body.totals).toMatchObject({ checked: 7, needsYou: 3, withItems: 4 });
  });

  it("rejects a malformed all", async () => {
    const { status, body } = await get("/api/managers/needs-you?all=maybe");
    expect(status).toBe(400);
    expect(body.code).toBe("invalid");
  });
});
