#!/usr/bin/env node
/**
 * seed.mjs — stage a throwaway, fully synthetic Managers data dir for QA.
 *
 *   node scripts/managers-rig/seed.mjs --out <dir> [--now <ISO>]
 *
 * Writes, under <dir>:
 *   data/                 a complete MANAGERS_DATA_DIR (serve.mjs --data)
 *     projects/           the projects root = the data repo = the Home workspace:
 *                         `.managers-data` marker, root project.yaml/CLAUDE.md, one
 *                         dir per fixture project, `git init`ed with ONE commit
 *     .herdctl/jobs/      a job record per chat (without one a chat is invisible)
 *     read-state.json     which seeded chats read as unread
 *     run-provenance.json which seeded chats are scheduled runs
 *     sweep-state.json    every workspace stamped "swept at seed time" (see below)
 *   home/                 the rig's HOME (serve.mjs --home); never the real one
 *   fake-script.json      the fake `claude`'s prompt → reply book
 *   manifest.json         `<slug|_root>:<label>` → session id, for scripts
 *
 * Forked from scripts/demo-gif/seed.mjs. The differences that matter:
 *   • fixture-driven (fixtures.mjs), so later milestones add data, not code;
 *   • every time is relative to the wall clock — `--now` exists only to make a
 *     screenshot reproducible, never as a default;
 *   • the projects root is committed CLEAN (one initial commit, no dirty tree), so
 *     anything a QA step writes shows up as its own change.
 *
 * Rules inherited from the demo rig that fail SILENTLY if broken — see its README:
 *   • seed before boot (herdctl caches sessions and attribution for 30s);
 *   • job-record ids are `job-YYYY-MM-DD-[a-z0-9]{6}`, lowercase;
 *   • a scheduled run needs `origin: scheduled` in run-provenance.json, not just a
 *     `trigger_type` in its job record;
 *   • `tool_result.content` must be a non-empty string.
 * We do NOT create `~/.claude/projects/<mangled-cwd>` symlinks: the server makes
 * them itself for every workspace at boot.
 *
 * NEVER point --out at /data/projects, /data/.claude or anything under a real
 * Paddock/Managers data dir. The script refuses the obvious ones.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { ROOT_WORKSPACE, PROJECTS, FAKE_SCRIPT } from "./fixtures.mjs";
import { makeIds, clock, usage, userLine, assistantText, toolCall } from "./lib/transcript.mjs";

// ── args ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? dflt : argv[i + 1];
};
const outArg = arg("out");
if (!outArg) {
  console.error("usage: seed.mjs --out <dir> [--now <ISO>]");
  process.exit(2);
}
const OUT = path.resolve(outArg);
const NOW = arg("now") ? new Date(arg("now")) : new Date();
if (Number.isNaN(NOW.getTime())) {
  console.error(`seed.mjs: --now is not a valid date: ${arg("now")}`);
  process.exit(2);
}

// Belt and braces: `rm -rf` of the out dir is the first thing we do. Refuse any
// out dir that is, contains, or sits inside production data or a Claude home.
const PROTECTED = ["/data/projects", "/data/.claude", "/data/claude-home", "/var/lib/paddock"];
const real = (p) => {
  // Resolve the deepest existing ancestor, so a not-yet-created dir under a
  // symlinked prod path is still caught.
  let cur = p;
  const tail = [];
  while (!fs.existsSync(cur) && path.dirname(cur) !== cur) {
    tail.unshift(path.basename(cur));
    cur = path.dirname(cur);
  }
  return path.join(fs.realpathSync(cur), ...tail);
};
{
  const r = real(OUT);
  for (const f of PROTECTED.flatMap((x) => [x, fs.existsSync(x) ? fs.realpathSync(x) : x])) {
    if (r === f || f.startsWith(`${r === "/" ? "" : r}/`) || r.startsWith(`${f}/`)) {
      console.error(`seed.mjs: refusing to seed into ${OUT} (overlaps protected ${f})`);
      process.exit(2);
    }
  }
}

const DATA = path.join(OUT, "data");
const HOME = path.join(OUT, "home");
const PROJECTS_ROOT = path.join(DATA, "projects");
const JOBS_DIR = path.join(DATA, ".herdctl", "jobs");

const ids = makeIds("managers-rig-v1");
const write = (p, s) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, s, "utf8");
};
const hoursAgo = (h) => new Date(NOW.getTime() - h * 3600_000);
const daysAgoDate = (d) => hoursAgo(d * 24).toISOString().slice(0, 10);
const iso = (d) => d.toISOString();
const yamlStr = (s) => JSON.stringify(s);

// ── project.yaml ────────────────────────────────────────────────────────────
function projectYaml(p) {
  const L = [
    p.slug
      ? "# Managers project metadata (synthetic QA fixture). Directory name MUST equal `slug`."
      : "# The Home workspace (the projects root). Synthetic QA fixture.",
    `name: ${yamlStr(p.name)}`,
  ];
  if (p.slug) L.push(`slug: ${p.slug}`);
  L.push(`status: ${p.status}`);
  if (p.slug) L.push(p.domain?.length ? `domain:\n${p.domain.map((d) => `  - ${d}`).join("\n")}` : "domain: []");
  if (p.group) L.push(`group: ${p.group}`);
  L.push("visibility: public");
  L.push(`started: ${daysAgoDate(p.startedDaysAgo ?? 30)}`);
  L.push(`updated: ${iso(NOW).slice(0, 10)}`);
  L.push(`summary: ${yamlStr(p.summary)}`);
  if (p.slug) {
    L.push("links: []");
    L.push("pinned: []");
  }
  if (p.triggers) {
    L.push("triggers:");
    for (const [name, t] of Object.entries(p.triggers)) {
      L.push(`  ${name}:`);
      L.push("    trigger:");
      L.push(`      type: ${t.trigger.type}`);
      if (t.trigger.cron) L.push(`      cron: ${yamlStr(t.trigger.cron)}`);
      if (t.trigger.interval) L.push(`      interval: ${yamlStr(t.trigger.interval)}`);
      if (t.trigger.on) L.push(`      on: ${yamlStr(t.trigger.on)}`);
      L.push("    run:");
      if (t.run.promptFile) L.push(`      promptFile: ${yamlStr(t.run.promptFile)}`);
      if (t.run.prompt) L.push(`      prompt: ${yamlStr(t.run.prompt)}`);
      if (t.run.session) L.push(`      session: ${t.run.session}`);
      if (t.run.tools) L.push(`      tools: [${t.run.tools.join(", ")}]`);
      if (t.run.maxTurns) L.push(`      maxTurns: ${t.run.maxTurns}`);
      L.push(`    enabled: ${t.enabled ? "true" : "false"}`);
    }
  }
  // Later milestones' blocks (behaviours, mcp, reports…). JSON is valid YAML.
  for (const [k, v] of Object.entries(p.yaml ?? {})) L.push(`${k}: ${JSON.stringify(v)}`);
  return `${L.join("\n")}\n`;
}

// ── job records, provenance, read state ─────────────────────────────────────
function recordJob({ sessionId, slug, startedAt, finishedAt, triggerType = "web", schedule = null, prompt }) {
  const date = iso(startedAt).slice(0, 10);
  // zod-validated as job-YYYY-MM-DD-[a-z0-9]{6}: LOWERCASE, exactly six chars.
  const id = `job-${date}-${sessionId.replace(/-/g, "").slice(0, 6).toLowerCase()}`;
  const outputFile = path.join(JOBS_DIR, `${id}.jsonl`);
  const agent = slug === "" ? "keeper-_root" : `keeper-${slug}`;
  write(
    path.join(JOBS_DIR, `${id}.yaml`),
    [
      `id: ${id}`,
      `agent: ${agent}`,
      schedule === null ? "schedule: null" : `schedule: ${yamlStr(schedule)}`,
      `trigger_type: ${triggerType}`,
      "status: completed",
      "exit_reason: success",
      `session_id: ${sessionId}`,
      "forked_from: null",
      `started_at: ${iso(startedAt)}`,
      `finished_at: ${iso(finishedAt)}`,
      `duration_seconds: ${Math.max(1, Math.round((finishedAt - startedAt) / 1000))}`,
      ...(prompt ? [`prompt: ${yamlStr(prompt)}`] : []),
      `output_file: ${outputFile}`,
      "",
    ].join("\n"),
  );
  write(outputFile, "");
}

const runProvenance = {};
const readState = {};
const manifest = {};
let chatCount = 0;
let unreadCount = 0;

function seedChat(slug, dir, c) {
  const key = `${slug || "_root"}:${c.label}`;
  const sessionId = ids.stableUuid(`chat:${key}`);
  const startedAt = hoursAgo(c.hoursAgo ?? 1);
  const finishedAt = new Date(startedAt.getTime() + (c.durationMin ?? 3) * 60_000);
  const ctx = { sessionId, cwd: dir, model: "claude-opus-5", ids, clock: clock(iso(startedAt)), gitBranch: "main" };
  let body = userLine(ctx, c.prompt);
  if (c.tool) {
    body += toolCall(ctx, {
      name: c.tool.name,
      id: ids.toolId(`${key}:tool`),
      input: c.tool.input,
      content: c.tool.content,
      use: usage(8_000, 90, 20_000, 0),
    });
  }
  body += assistantText(ctx, c.reply, usage(9_400, 260, 31_000, 2_100), 45_000);
  const file = path.join(dir, ".chats", `${sessionId}.jsonl`);
  write(file, body);
  fs.utimesSync(file, finishedAt, finishedAt);

  const scheduled = c.origin === "scheduled";
  recordJob({
    sessionId,
    slug,
    startedAt,
    finishedAt,
    triggerType: scheduled ? "schedule" : "web",
    schedule: c.schedule ?? null,
    prompt: scheduled ? c.prompt : undefined,
  });
  if (scheduled) runProvenance[sessionId] = { origin: "scheduled", depth: 0 };
  // Unread = no read-state entry. With auth `none` the key is `<agent> NUL <session>`.
  if (c.unread) unreadCount++;
  else readState[`${slug === "" ? "keeper-_root" : `keeper-${slug}`}\u0000${sessionId}`] = finishedAt.getTime() + 60_000;
  manifest[key] = sessionId;
  chatCount++;
}

function seedWorkspace(p, dir, slug) {
  fs.mkdirSync(dir, { recursive: true });
  write(path.join(dir, "project.yaml"), projectYaml(p));
  for (const [name, content] of Object.entries(p.files ?? {})) write(path.join(dir, name), `${content.replace(/\n$/, "")}\n`);
  for (const [name, content] of Object.entries(p.triggerPrompts ?? {})) {
    write(path.join(dir, ".managers", "triggers", name), `${content}\n`);
  }
  for (const c of p.chats ?? []) seedChat(slug, dir, c);
}

// ── build it ────────────────────────────────────────────────────────────────
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
fs.mkdirSync(JOBS_DIR, { recursive: true });
fs.mkdirSync(path.join(HOME, ".claude"), { recursive: true });

// The data-dir guard (M1) refuses a projects root holding projects without this.
write(path.join(PROJECTS_ROOT, ".managers-data"), "Managers data repo (synthetic QA rig — scripts/managers-rig).\n");
// Transcripts are never tracked.
write(path.join(PROJECTS_ROOT, ".gitignore"), "*/.chats/\n.chats/\n");

seedWorkspace(ROOT_WORKSPACE, PROJECTS_ROOT, "");
for (const p of PROJECTS) seedWorkspace(p, path.join(PROJECTS_ROOT, p.slug), p.slug);

// ONE repo at the projects root (the Changes tab is that repo filtered to a
// project's subtree), with ONE clean initial commit. Author identity is synthetic
// and global/system git config is ignored so the box's own config can't leak in.
const git = (...a) =>
  execFileSync("git", ["-C", PROJECTS_ROOT, ...a], {
    stdio: "pipe",
    env: {
      PATH: process.env.PATH,
      HOME,
      GIT_AUTHOR_NAME: "Managers Rig",
      GIT_AUTHOR_EMAIL: "rig@example.invalid",
      GIT_COMMITTER_NAME: "Managers Rig",
      GIT_COMMITTER_EMAIL: "rig@example.invalid",
      GIT_AUTHOR_DATE: iso(NOW),
      GIT_COMMITTER_DATE: iso(NOW),
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    },
  });
git("init", "-q", "-b", "main");
git("add", "-A");
git("commit", "-q", "-m", "Seed synthetic Managers QA rig");

write(path.join(DATA, "read-state.json"), `${JSON.stringify(readState, null, 2)}\n`);
write(path.join(DATA, "run-provenance.json"), `${JSON.stringify(runProvenance, null, 2)}\n`);
// The post-turn sweeper's watermark. `MANAGERS_SWEEP_MIN_INTERVAL_MS` is measured
// from the LAST sweep, and a project that has never been swept counts as "last
// swept at epoch 0" — so without this the very first QA turn in each project
// rewrites its seeded OVERVIEW.md/CHANGELOG.md (and writes a CLAUDE.md). Stamping
// every workspace as swept at seed time makes the huge interval actually hold.
write(
  path.join(DATA, "sweep-state.json"),
  `${JSON.stringify(
    Object.fromEntries(
      ["", ...PROJECTS.map((p) => p.slug)].map((s) => [s, { lastSweptSessionMtime: iso(NOW), lastSweptAt: NOW.getTime() }]),
    ),
    null,
    2,
  )}\n`,
);
write(path.join(OUT, "fake-script.json"), `${JSON.stringify(FAKE_SCRIPT, null, 2)}\n`);
write(
  path.join(OUT, "manifest.json"),
  `${JSON.stringify({ generatedFrom: iso(NOW), projectsRoot: PROJECTS_ROOT, chats: manifest }, null, 2)}\n`,
);

console.log(`Seeded ${chatCount} chats (${unreadCount} unread) across ${PROJECTS.length} projects + Home`);
console.log(`  data: ${DATA}`);
console.log(`  home: ${HOME}`);
