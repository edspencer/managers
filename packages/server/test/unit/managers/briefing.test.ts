/**
 * Managers M7: the deterministic wake briefing (`managers/briefing.ts`).
 *
 * A fixture workspace in a temp dir, a fixed `now`, and a snapshot: identical
 * inputs must give byte-identical output. Then each section's budget, the
 * empty-project markers, Home's memory, and the preload-wrapper escaping.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { ManagersState } from "../../../src/managers/state.js";
import {
  BRIEFING_SECTIONS,
  SECTION_BUDGETS,
  OPEN_TASKS_CAP,
  buildBriefing,
  clip,
  demoteHeadings,
  triggerWantsBriefing,
  type BriefingParams,
  type BriefingSources,
} from "../../../src/managers/briefing.js";
import { MANAGER_PROTOCOL } from "../../../src/managers/protocol.js";
import { stripPreloadWrapper, wrapPreload } from "../../../src/preload.js";
import type { PaddockTrigger } from "../../../src/trigger-config.js";
import { makeTmpDir, rmTmpDir } from "../../helpers/tmp.js";

const NOW = new Date("2026-09-26T07:00:00.000Z");

let root: string;
let proj: string;
let overview: string;

async function put(rel: string, text: string, base = proj): Promise<void> {
  const abs = path.join(base, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, text, "utf8");
}

const TRIGGERS: Record<string, PaddockTrigger> = {
  wake: {
    trigger: { type: "schedule", cron: "0 7 * * *" },
    run: { promptFile: "wake.md", session: "new", tools: [], expect: { kind: "episode", within: "48h" } },
    enabled: true,
  },
  "publish-check": {
    trigger: { type: "schedule", cron: "0 6 * * 1" },
    run: { prompt: "Check.", session: "new", tools: [] },
    enabled: false,
  },
} as unknown as Record<string, PaddockTrigger>;

function sources(slug = "acme", triggers: Record<string, PaddockTrigger> | null = TRIGGERS): BriefingSources {
  return {
    state: new ManagersState(root),
    project: { slug, dir: slug === "" ? root : proj, triggers: triggers ?? undefined },
    readOverview: async () => overview,
    schedules: async () => [],
  };
}

const WAKE: BriefingParams = {
  kind: "wake",
  trigger: "wake",
  runId: "r-260926-0700-cc",
  objective: "grow-awareness",
  now: NOW,
};

const task = (id: string, status: string, title: string, extra = "") =>
  `---\nid: ${id}\ntitle: ${title}\nstatus: ${status}\n${extra}created: 2026-09-20T00:00:00Z\nupdated: 2026-09-2${id.endsWith("a") ? 1 : 2}T00:00:00Z\n---\nNotes.\n`;

const run = (id: string, trigger: string, started: string, status: string, expectResult: string | null, extra = "") =>
  `id: ${id}\ntrigger: ${trigger}\nkind: wake\nobjective: null\nstatus: ${status}\nstarted: ${started}\nfinished: ${started}\n` +
  `sessionId: null\nmodel: null\nusage: {inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0}\n` +
  `episodes: []\ntasksTouched: []\nreports: []\nartifacts: []\nmcpCalls: {}\n` +
  `expect: {kind: episode, within: 48h}\nexpectResult: ${expectResult ?? "null"}\nbriefing: null\n${extra || "error: null\n"}`;

async function seedFixture(): Promise<void> {
  await put(
    "memory/MEMORY.md",
    "# Shared memory\nEd prefers short updates.\n\n<!-- managers:index -->\n- [[quota-overrun-prone]] — Quotas run over on Fridays\n",
    root,
  );
  await put("memory/MEMORY.md", "# Acme memory\nThe blog deploys from main.\n");
  await put(
    "objectives/grow-awareness/objective.md",
    "---\ntitle: Grow awareness of Widget\nstatus: active\nsuccess: Known in 3 communities\ntriggers: [wake]\n" +
      "created: 2026-09-01T10:00:00Z\nupdated: 2026-09-25T07:05:00Z\n---\n" +
      "## Where we are\nTwo posts are out; the third is drafted.\n\nOlder detail.\n## Strategy\nOne post a week.\n## Lessons\n- [[quota-overrun-prone]]\n",
  );
  await put(
    "objectives/grow-awareness/journal/2026-09.md",
    "## 2026-09-24 07:04Z · ep-260924-0704-aa · imp 5 · run r-260924-0700-bb · #posts\nDrafted the third post.\n\n" +
      "## 2026-09-25 07:04Z · ep-260925-0704-bb · imp 6 · #posts\nPublished post two.\nrefs: widget-lib#12\n",
  );
  await put(
    "objectives/burn-down-issues/objective.md",
    "---\ntitle: Burn down issues\nstatus: active\nsuccess: Under 10 open\ncreated: 2026-09-01T10:00:00Z\n---\n" +
      "## Where we are\n14 open issues, down from 30.\n",
  );
  await put(
    "objectives/old-thing/objective.md",
    "---\ntitle: An old thing\nstatus: done\nsuccess: Done\ncreated: 2026-08-01T10:00:00Z\n---\n## Where we are\nFinished.\n",
  );
  await put("tasks/open/t-260920-opna.md", task("t-260920-opna", "open", "Write the fourth post", "objective: grow-awareness\n"));
  await put("tasks/open/t-260920-doib.md", task("t-260920-doib", "doing", "Triage widget-lib#40"));
  await put("tasks/open/t-260920-blkb.md", task("t-260920-blkb", "blocked", "Wait for CI fix"));
  await put(
    "tasks/open/t-260920-awea.md",
    task("t-260920-awea", "awaiting-ed", '"Merge renovate #88?"', 'ask: "Renovate #88 bumps a major; merge?"\noptions: [merge, skip]\n'),
  );
  await put(
    "tasks/open/t-260921-ansb.md",
    task(
      "t-260921-ansb",
      "open",
      "Pick the post topic",
      'answer: {by: ed, at: "2026-09-25T20:00:00Z", choice: tooling, text: "Go with tooling"}\n',
    ),
  );
  await put(
    "tasks/done/2026-09/t-260919-dnea.md",
    task("t-260919-dnea", "done", "Approve the logo", 'answer: {by: ed, at: "2026-09-25T21:00:00Z", choice: approve}\n'),
  );
  // Answered BEFORE the last wake: must not be listed.
  await put(
    "tasks/done/2026-09/t-260918-olda.md",
    task("t-260918-olda", "done", "Old answer", 'answer: {by: ed, at: "2026-09-20T09:00:00Z", choice: yes}\n'),
  );
  await put(
    "log/2026-09.md",
    "# Log\n\n## 2026-09-25 07:06Z · ep-260925-0706-cc · imp 3 · run r-260925-0700-aa · #wake\nWoke; nothing new.\n\n" +
      "## 2026-09-23 12:00Z · ep-260923-1200-dd · imp 4 · source ed · #autonomy\nEd said keep it quiet this week.\n",
  );
  await put("runs/2026-09/r-260925-0700-aa.yaml", run("r-260925-0700-aa", "wake", "2026-09-25T07:00:02Z", "succeeded", "met"));
  await put(
    "runs/2026-09/r-260924-0700-bb.yaml",
    run("r-260924-0700-bb", "wake", "2026-09-24T07:00:02Z", "failed", "missing", "error: The API said no.\n"),
  );
  await put(
    "runs/2026-09/r-260920-0600-pc.yaml",
    run("r-260920-0600-pc", "publish-check", "2026-09-20T06:00:00Z", "failed", "missing", "error: boom\n"),
  );
  // The current run's own (running) record is excluded from "Recent runs".
  await put("runs/2026-09/r-260926-0700-cc.yaml", run("r-260926-0700-cc", "wake", "2026-09-26T07:00:00Z", "running", null));
  overview = "# Acme site\nThe blog and the docs.\n\n## Status\nHealthy.\n";
}

beforeEach(async () => {
  root = await makeTmpDir("managers-briefing-");
  proj = path.join(root, "acme");
  await fs.mkdir(proj, { recursive: true });
  overview = "";
});
afterEach(async () => rmTmpDir(root));

/** `## <heading>` lines of a briefing, in order. */
const headings = (text: string) => text.split("\n").filter((l) => /^## /.test(l));

function section(text: string, startsWith: string): string {
  const parts = text.split(/\n(?=## )/);
  return (parts.find((p) => p.startsWith(`## ${startsWith}`)) ?? "").trimEnd();
}

describe("buildBriefing (M7)", () => {
  it("matches the snapshot, and identical inputs give byte-identical output", async () => {
    await seedFixture();
    const a = await buildBriefing(sources(), WAKE);
    // A fresh state bundle (cold caches) gives the same bytes.
    const b = await buildBriefing(sources(), WAKE);
    expect(b.text).toBe(a.text);
    expect(a.sections.map((s) => s.name)).toEqual([...BRIEFING_SECTIONS]);
    expect(a.objective).toBe("grow-awareness");
    await expect(a.text).toMatchFileSnapshot("./__snapshots__/briefing-acme-wake.md");
  });

  it("orders the sections and leads Open tasks with awaiting-ed", async () => {
    await seedFixture();
    const { text } = await buildBriefing(sources(), WAKE);
    expect(headings(text)).toEqual([
      "## Briefing",
      "## Protocol",
      "## Behaviours",
      "## Connections",
      "## Shared memory",
      "## Project memory",
      "## Objective: Grow awareness of Widget (grow-awareness)",
      "## Open tasks",
      "## Answered since last wake",
      "## Recent runs of wake",
      "## Alerts",
      "## Recent project log",
      "## OVERVIEW.md",
    ]);
    const tasks = section(text, "Open tasks").split("\n").slice(1);
    expect(tasks.map((l) => /\[([a-z-]+)\]/.exec(l)?.[1])).toEqual(["awaiting-ed", "doing", "blocked", "open", "open"]);
    expect(tasks[0]).toContain('ask: Renovate #88 bumps a major; merge? (options: merge / skip)');
  });

  it("carries the header, the protocol and the bound objective's journal", async () => {
    await seedFixture();
    const { text } = await buildBriefing(sources(), WAKE);
    expect(text).toContain("- Now: 2026-09-26T07:00:00.000Z");
    expect(text).toContain("- Run: r-260926-0700-cc");
    expect(text).toContain("- Why: Scheduled wake (cron `0 7 * * *`)");
    expect(text).toContain(MANAGER_PROTOCOL);
    const obj = section(text, "Objective:");
    // The embedded objective.md's headings are demoted under the section.
    expect(obj).toContain("#### Where we are");
    expect(obj).not.toMatch(/^## Where we are/m);
    // Journal newest first.
    expect(obj.indexOf("ep-260925-0704-bb")).toBeLessThan(obj.indexOf("ep-260924-0704-aa"));
  });

  it("lists answers since this trigger's previous run, and its earlier runs with expect marks", async () => {
    await seedFixture();
    const { text } = await buildBriefing(sources(), WAKE);
    const answered = section(text, "Answered since last wake");
    expect(answered).toContain("Since 2026-09-25 07:00Z (the start of r-260925-0700-aa, this trigger's previous run)");
    // Newest answer first; the done task counts; the pre-wake answer does not.
    expect(answered.indexOf("t-260919-dnea")).toBeLessThan(answered.indexOf("t-260921-ansb"));
    expect(answered).toContain('chose "tooling"; said: Go with tooling');
    expect(answered).not.toContain("t-260918-olda");

    const runs = section(text, "Recent runs of wake");
    expect(runs).not.toContain("r-260926-0700-cc"); // the current run
    expect(runs).not.toContain("r-260920-0600-pc"); // another trigger
    expect(runs).toContain("r-260925-0700-aa · wake · 2026-09-25 07:00Z · succeeded · expect ✔ met (episode within 48h)");
    expect(runs).toContain("expect ✘ missing (episode within 48h) · error: The API said no.");

    // Alerts are the M6 dead-man's switch, computed at `now`.
    const alerts = section(text, "Alerts");
    expect(alerts).toContain("run-failed:publish-check");
  });

  it("without a bound objective, lists every active objective's title and first paragraph", async () => {
    await seedFixture();
    const { text, objective } = await buildBriefing(sources(), { kind: "chat", now: NOW });
    expect(objective).toBeNull();
    const obj = section(text, "Objectives");
    expect(obj).toContain("- **Burn down issues** (burn-down-issues) — 14 open issues, down from 30.");
    expect(obj).toContain("- **Grow awareness of Widget** (grow-awareness) — Two posts are out; the third is drafted.");
    expect(obj).not.toContain("Older detail");
    expect(obj).toContain("(+1 not active: paused, done or retired)");
    expect(text).toContain("- Why: Ed opened a new chat with preload on");
    expect(text).toContain("- Run: none");
  });

  it("notes a bound objective that does not exist and falls back to the list", async () => {
    await seedFixture();
    const { text, objective } = await buildBriefing(sources(), { ...WAKE, objective: "no-such-thing" });
    expect(objective).toBeNull();
    expect(section(text, "Objectives")).toContain("(the bound objective no-such-thing was not found)");
  });

  it("an empty project gives a minimal briefing with (none) markers", async () => {
    const { text, sections } = await buildBriefing(sources("acme", null), { kind: "wake", now: NOW });
    expect(sections.map((s) => s.name)).toEqual([...BRIEFING_SECTIONS]);
    for (const marker of [
      "(no memory yet)",
      "(no objectives)",
      "(no open tasks)",
      "(nothing answered)",
      "(no earlier runs)",
      "(no alerts)",
      "(no log entries yet)",
      "(no OVERVIEW.md yet)",
      "(none configured)",
    ]) {
      expect(text).toContain(marker);
    }
    expect(text).toContain("no earlier run, so the last 7 days");
    expect(text.length).toBeLessThan(6_000);
  });

  it("Home: shared memory is its own, and there is no separate project memory", async () => {
    await seedFixture();
    const { text } = await buildBriefing(sources("", null), { kind: "chat", now: NOW });
    expect(text).toContain("- Project: Home (the root workspace)");
    expect(section(text, "Shared memory")).toContain("Ed prefers short updates.");
    expect(section(text, "Project memory")).toContain("(Home's own memory is the shared memory above)");
  });

  it("truncates a 30KB MEMORY.md to its budget, with a note", async () => {
    const line = "- a remembered fact that goes on for a while, padded to a fixed width......\n";
    await put("memory/MEMORY.md", "# Big\n" + line.repeat(Math.ceil(30_000 / line.length)));
    const b = await buildBriefing(sources(), { kind: "chat", now: NOW });
    const mem = section(b.text, "Project memory");
    expect(mem).toMatch(/… \[truncated: showing \d+ of \d+ characters; read memory\/MEMORY\.md for the rest\]$/);
    const chars = b.sections.find((s) => s.name === "Project memory")!.chars;
    expect(chars).toBeLessThanOrEqual(SECTION_BUDGETS["Project memory"]);
    expect(chars).toBeGreaterThan(SECTION_BUDGETS["Project memory"] - 200);
  });

  it("keeps every section inside its budget when every input overflows", async () => {
    const big = (label: string, n: number) =>
      Array.from({ length: n }, (_, i) => `${label} line ${String(i).padStart(4, "0")} ${"x".repeat(60)}`).join("\n");
    await put("memory/MEMORY.md", big("shared", 500), root);
    await put("memory/MEMORY.md", big("project", 500));
    await put(
      "objectives/huge/objective.md",
      `---\ntitle: Huge\nstatus: active\nsuccess: s\ntriggers: [wake]\n---\n## Where we are\n${big("where", 300)}\n`,
    );
    for (let i = 0; i < 70; i++) {
      const id = `t-260920-${String(i).padStart(4, "0")}`;
      await put(
        `tasks/open/${id}.md`,
        task(id, i % 2 ? "awaiting-ed" : "open", `Task ${i} ${"y".repeat(100)}`, `ask: "${"z".repeat(200)}"\nanswer: {by: ed, at: "2026-09-25T0${i % 10}:00:00Z", text: "${"w".repeat(250)}"}\n`),
      );
    }
    const triggers: Record<string, PaddockTrigger> = {};
    for (let i = 0; i < 40; i++) {
      const name = `trig-${String(i).padStart(2, "0")}`;
      triggers[name] = { ...TRIGGERS.wake!, enabled: true } as PaddockTrigger;
      await put(`runs/2026-09/r-260925-07${String(i).padStart(2, "0")}-aa.yaml`, run(`r-260925-07${String(i).padStart(2, "0")}-aa`, name, `2026-09-25T07:${String(i).padStart(2, "0")}:00Z`, "failed", "missing", `error: ${"e".repeat(300)}\n`));
    }
    const entries = Array.from(
      { length: 30 },
      (_, i) => `## 2026-09-${String(10 + (i % 15)).padStart(2, "0")} 07:${String(i).padStart(2, "0")}Z · ep-260910-07${String(i).padStart(2, "0")}-aa · imp 3\n${"v".repeat(800)}\n`,
    ).join("\n");
    await put("log/2026-09.md", entries);
    overview = big("overview", 300);

    const b = await buildBriefing(sources("acme", triggers), { kind: "wake", trigger: "trig-00", objective: "huge", now: NOW });
    for (const s of b.sections) expect(s.chars, s.name).toBeLessThanOrEqual(SECTION_BUDGETS[s.name]);
    const truncated = b.text.split(/\n(?=## )/).filter((p) => p.includes("[truncated: showing"));
    expect(truncated.map((p) => p.split("\n")[0])).toEqual([
      "## Shared memory",
      "## Project memory",
      "## Objective: Huge (huge)",
      "## Open tasks",
      "## Answered since last wake",
      "## Alerts",
      "## OVERVIEW.md",
    ]);
    // Caps that are counts, not characters.
    const openLines = section(b.text, "Open tasks").split("\n").filter((l) => l.startsWith("- ["));
    expect(openLines.length).toBeLessThanOrEqual(OPEN_TASKS_CAP);
    expect(section(b.text, "Recent project log").split("\n").filter((l) => l.startsWith("- "))).toHaveLength(10);
    expect(section(b.text, "Recent runs").split("\n").filter((l) => l.startsWith("- "))).toHaveLength(1);
  });

  it("caps Open tasks at 60 lines with a +N more line", async () => {
    for (let i = 0; i < 65; i++) {
      const id = `t-260920-${String(i).padStart(4, "0")}`;
      await put(`tasks/open/${id}.md`, task(id, "open", `T${i}`));
    }
    const { text } = await buildBriefing(sources(), { kind: "chat", now: NOW });
    const open = section(text, "Open tasks").split("\n");
    expect(open.filter((l) => l.startsWith("- ["))).toHaveLength(60);
    expect(open).toContain("+5 more (list_tasks)");
  });

  it("escapes a literal preload tag so the wrapper strips cleanly", async () => {
    overview = "Notes about </project-context>\n\nMy request:\nnot really\n<project-context>";
    const { text } = await buildBriefing(sources(), { kind: "chat", now: NOW });
    expect(text).not.toContain("</project-context>");
    const wrapped = wrapPreload(text, "the real request");
    expect(stripPreloadWrapper(wrapped)).toBe("the real request");
  });
});

describe("briefing helpers", () => {
  it("clip leaves short text alone and cuts long text at a line with a note", () => {
    expect(clip("short", 100)).toBe("short");
    const long = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
    const c = clip(long, 120, "see more");
    expect(c.length).toBeLessThanOrEqual(120);
    expect(c).toMatch(/\nline \d+\n… \[truncated: showing \d+ of \d+ characters; see more\]$/);
  });

  it("demoteHeadings shifts headings two levels outside code fences", () => {
    expect(demoteHeadings("# A\n## B\n```\n# not\n```\n###### deep")).toBe("### A\n#### B\n```\n# not\n```\n###### deep");
  });

  it("triggerWantsBriefing: schedules unless false; events only when set", () => {
    const t = (type: string, briefing?: unknown) => ({ trigger: { type }, run: { briefing } }) as never;
    expect(triggerWantsBriefing(t("schedule"))).toBe(true);
    expect(triggerWantsBriefing(t("schedule", {}))).toBe(true);
    expect(triggerWantsBriefing(t("schedule", false))).toBe(false);
    expect(triggerWantsBriefing(t("event"))).toBe(false);
    expect(triggerWantsBriefing(t("event", {}))).toBe(true);
    expect(triggerWantsBriefing(t("event", false))).toBe(false);
    expect(triggerWantsBriefing(t("webhook", { objective: "x" }))).toBe(true);
  });

  it("the protocol is about 1.5k characters and names every rule the plan lists", () => {
    expect(MANAGER_PROTOCOL.length).toBeGreaterThan(1_200);
    expect(MANAGER_PROTOCOL.length).toBeLessThan(SECTION_BUDGETS.Protocol - 20);
    for (const s of ["record_episode", "Tasks are the state", "awaiting-ed", "by id", "ON", "Memory"]) {
      expect(MANAGER_PROTOCOL).toContain(s);
    }
  });
});
