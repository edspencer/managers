/**
 * briefing — the deterministic wake briefing (M7, plan §5 M7).
 *
 * {@link buildBriefing} assembles what a manager sees when it wakes (or when Ed
 * opens a chat with preload on): one Markdown document of twelve sections, in a
 * fixed order, each with a hard character budget. It is DETERMINISTIC: no
 * randomness, stable sorts, `now` injected, so identical inputs give
 * byte-identical output (pinned by a snapshot test).
 *
 *   1  Header          project, now, run, trigger, why woken
 *   2  Protocol        MANAGER_PROTOCOL (protocol.ts)
 *   3  Behaviours      ON behaviours with their instructions, then "Not permitted" (M8)
 *   4  Connections     placeholder until M9 (names only)
 *   5  Shared memory   root memory/MEMORY.md          (≤20k chars)
 *      Project memory  <project>/memory/MEMORY.md     (≤20k chars)
 *   6  Objective(s)    the bound objective in full plus its recent journal, or
 *                      every active objective's title and first paragraph
 *   7  Open tasks      one line each, awaiting-ed first, capped at 60
 *   8  Answered since the last wake of this trigger
 *   9  Recent runs     of this trigger, ≤5, with expect ✔/✘
 *   10 Alerts          the M6 dead-man's switch
 *   11 Recent project log  the last 10 project-level episodes
 *   12 OVERVIEW.md     (≤8k chars)
 *
 * A section over its budget is cut at a line boundary and ends with a
 * `[truncated: …]` note, so the agent knows there is more (and where to read it).
 * Headings inside embedded documents are demoted two levels so they never read as
 * briefing sections, and a literal `<project-context>` tag inside one is escaped
 * so the preload wrapper (preload.ts) can always be stripped back off.
 *
 * The total is about 40k characters (≈10k tokens) for a typical project; the
 * worst case, with both memory files at their cap, is about 90k.
 */
import { promises as fs } from "node:fs";
import type { PaddockTrigger } from "../trigger-config.js";
import type { ManagersState } from "./state.js";
import type { WorkspaceLayout } from "./layout.js";
import type { Episode } from "./episodes-store.js";
import type { TaskSummary } from "./tasks-store.js";
import type { RunSummary } from "./runs-store.js";
import { computeAlerts, alertTriggers, monthsToRead, sortAlerts, type Alert, type AlertSchedule } from "./alerts.js";
import {
  behavioursBriefingBody,
  behavioursFor,
  effectiveBehaviours,
  triggerGatePredicate,
  type BehaviourConfig,
  type EffectiveBehaviour,
} from "./behaviours.js";
import { behaviourDriftAlert } from "./behaviour-state.js";
import { MANAGER_PROTOCOL } from "./protocol.js";
import { isMissing, isParseFailure } from "./store-util.js";

export type BriefingKind = "wake" | "chat" | "report" | "consolidation";

/** Section names, in output order (also the `sections[].name` values). */
export const BRIEFING_SECTIONS = [
  "Header",
  "Protocol",
  "Behaviours",
  "Connections",
  "Shared memory",
  "Project memory",
  "Objective",
  "Open tasks",
  "Answered since last wake",
  "Recent runs",
  "Alerts",
  "Recent project log",
  "OVERVIEW.md",
] as const;
export type BriefingSectionName = (typeof BRIEFING_SECTIONS)[number];

/** Hard per-section budgets in characters, heading included. */
export const SECTION_BUDGETS: Record<BriefingSectionName, number> = {
  Header: 1_000,
  Protocol: 2_500,
  Behaviours: 2_000,
  Connections: 1_000,
  "Shared memory": 20_000,
  "Project memory": 20_000,
  Objective: 12_000,
  "Open tasks": 8_000,
  "Answered since last wake": 4_000,
  "Recent runs": 2_000,
  Alerts: 3_000,
  "Recent project log": 5_000,
  "OVERVIEW.md": 8_000,
};

export const OPEN_TASKS_CAP = 60;
export const RECENT_RUNS_CAP = 5;
export const LOG_ENTRIES = 10;
export const JOURNAL_MIN_ENTRIES = 20;
export const JOURNAL_DAYS = 14;
export const OBJECTIVE_SUMMARY_MAX = 600;
/** With no earlier run to measure from, "answered since" looks back this far. */
export const ANSWERED_FALLBACK_DAYS = 7;

export interface BriefingParams {
  kind: BriefingKind;
  /** The objective to brief on in full (a trigger's `run.briefing.objective`, or its binding). */
  objective?: string | null;
  /** The trigger being fired, if any. */
  trigger?: string | null;
  runId?: string | null;
  /** Why the manager is being woken, in words (e.g. "Run now (manual)"). Derived when absent. */
  why?: string | null;
  now: Date;
}

/** Everything the briefing reads, for one workspace. */
export interface BriefingSources {
  state: ManagersState;
  project: { slug: string; dir: string; triggers?: Record<string, PaddockTrigger> };
  /** OVERVIEW.md's text ("" when there is none). */
  readOverview: () => Promise<string>;
  /** herdctl's live schedules for the alerts (none when absent). */
  schedules?: () => Promise<AlertSchedule[]>;
  /** M8: the workspace's effective behaviours (the built-ins alone when absent). */
  behaviours?: EffectiveBehaviour[];
  /** M8: alerts computed outside the pure M6 set (the out-of-UI behaviour change). */
  extraAlerts?: () => Promise<Alert[]>;
}

export interface Briefing {
  text: string;
  sections: { name: BriefingSectionName; chars: number }[];
  /** The objective the Objective section briefed on in full, when one resolved. */
  objective: string | null;
}

// --- text helpers ----------------------------------------------------------------------

/** Demote Markdown headings by two levels (outside fences), so embedded docs nest. */
export function demoteHeadings(text: string): string {
  let fence = false;
  return text
    .split("\n")
    .map((line) => {
      if (/^(```|~~~)/.test(line)) fence = !fence;
      if (fence) return line;
      const m = /^(#{1,6})(\s)/.exec(line);
      return m ? `${"#".repeat(Math.min(6, m[1]!.length + 2))}${line.slice(m[1]!.length)}` : line;
    })
    .join("\n");
}

/** Escape a literal preload tag so a document can never close the wrapper early. */
export function escapePreloadTags(text: string): string {
  return text.replace(/<(\/?)project-context>/g, "&lt;$1project-context&gt;");
}

/** Embed a user-authored Markdown document inside a section. */
function embed(text: string): string {
  return escapePreloadTags(demoteHeadings(text.replace(/\r\n?/g, "\n").trim()));
}

/** One line, whitespace collapsed, capped at `max` characters. */
export function oneLine(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/**
 * Fit `body` into `budget` characters. When it does not fit, cut at the last line
 * boundary that leaves room for the note (or mid-line when there is none in the
 * second half) and append `[truncated: showing N of M characters…]`.
 */
export function clip(body: string, budget: number, hint = ""): string {
  if (body.length <= budget) return body;
  const note = (shown: number) =>
    `\n… [truncated: showing ${shown} of ${body.length} characters${hint ? `; ${hint}` : ""}]`;
  const room = Math.max(0, budget - note(body.length).length);
  let cut = body.slice(0, room);
  const nl = cut.lastIndexOf("\n");
  if (nl > room / 2) cut = cut.slice(0, nl);
  cut = cut.trimEnd();
  return `${cut}${note(cut.length)}`;
}

/** `2026-09-26T07:04:00Z` → `2026-09-26 07:04Z`. */
function stamp(iso: string | null | undefined): string {
  if (!iso) return "?";
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(iso);
  return m ? `${m[1]} ${m[2]}Z` : iso;
}

async function readText(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, "utf8");
  } catch (err) {
    if (isMissing(err)) return null;
    throw err;
  }
}

function monthOf(d: Date): string {
  return d.toISOString().slice(0, 7);
}

function workspaceName(slug: string): string {
  return slug === "" ? "Home (the root workspace)" : slug;
}

function describeWhy(p: BriefingParams, trigger: PaddockTrigger | undefined): string {
  if (p.why) return p.why;
  if (p.kind === "chat") return "Ed opened a new chat with preload on";
  if (p.kind === "report") return "A report run";
  if (p.kind === "consolidation") return "A consolidation run";
  if (!trigger) return p.trigger ? `Trigger ${p.trigger}` : "A wake with no trigger";
  const w = trigger.trigger;
  if (w.type === "schedule") {
    return w.cron !== undefined ? `Scheduled wake (cron \`${w.cron}\`)` : `Scheduled wake (every ${String(w.interval)})`;
  }
  if (w.type === "event") return `Event trigger (\`${w.on}\`)`;
  return `Webhook trigger (\`${w.path}\`)`;
}

// --- sections --------------------------------------------------------------------------

type Section = { name: BriefingSectionName; title: string; body: string; hint?: string };

function renderSection(s: Section): string {
  const head = `## ${s.title}\n`;
  return head + clip(s.body.trimEnd() || "(none)", SECTION_BUDGETS[s.name] - head.length, s.hint);
}

async function memorySection(
  name: "Shared memory" | "Project memory",
  layout: WorkspaceLayout,
  shownAs: string,
): Promise<Section> {
  const text = await readText(layout.memoryIndexFile);
  return {
    name,
    title: name,
    body: text && text.trim() ? embed(text) : "(no memory yet)",
    hint: `read ${shownAs} for the rest`,
  };
}

function episodeLine(e: Episode, textMax: number): string {
  const tags = e.tags.length ? ` · ${e.tags.map((t) => `#${t}`).join(" ")}` : "";
  const src = e.source ? ` · ${e.source}` : "";
  return `- ${stamp(e.at)} · ${e.id} · imp ${e.importance}${src}${tags} — ${oneLine(e.text, textMax)}`;
}

async function objectiveSection(
  src: BriefingSources,
  layout: WorkspaceLayout,
  wanted: string | null,
  now: Date,
): Promise<{ section: Section; objective: string | null }> {
  const { state } = src;
  let missingNote = "";
  if (wanted) {
    const got = await state.objectives.get(layout, wanted, { months: 3 }).catch(() => null);
    if (got && !isParseFailure(got)) {
      const raw = (await readText(layout.objectiveFile(wanted))) ?? "";
      // Enough journal to cover max(20 entries, 14 days): page back until both hold.
      const entries: Episode[] = [...got.journal.entries];
      let before = got.journal.nextBefore;
      const since = now.getTime() - JOURNAL_DAYS * 86_400_000;
      while (before && entries.length < JOURNAL_MIN_ENTRIES) {
        const page = await state.episodes.page(layout, wanted, { before, months: 3 });
        entries.push(...page.entries);
        before = page.nextBefore;
      }
      const recent = entries.filter((e) => Date.parse(e.at) >= since).length;
      const shown = entries.slice(0, Math.max(JOURNAL_MIN_ENTRIES, recent));
      const journal = shown.length
        ? shown.map((e) => episodeLine(e, 400)).join("\n")
        : "(no journal entries yet)";
      return {
        objective: wanted,
        section: {
          name: "Objective",
          title: `Objective: ${got.title} (${wanted})`,
          body:
            `${embed(raw)}\n\n` +
            `### Journal (newest first; the last ${JOURNAL_MIN_ENTRIES} entries or ${JOURNAL_DAYS} days, whichever is more)\n` +
            journal,
          hint: `read_objective ${wanted} for the rest`,
        },
      };
    }
    missingNote =
      got && isParseFailure(got)
        ? `(the bound objective ${wanted} does not parse: ${got.parseError.error})\n\n`
        : `(the bound objective ${wanted} was not found)\n\n`;
  }

  const { objectives } = await state.objectives.list(layout);
  const active = objectives.filter((o) => o.status === "active");
  const lines: string[] = [];
  for (const o of active) {
    const d = await state.objectives.get(layout, o.id, { months: 1 }).catch(() => null);
    const where = d && !isParseFailure(d) ? d.whereWeAre : "";
    const para = where.split(/\n\s*\n/).map((p) => p.trim()).find(Boolean) ?? "";
    lines.push(`- **${oneLine(o.title, 120)}** (${o.id})${para ? ` — ${oneLine(para, OBJECTIVE_SUMMARY_MAX)}` : ""}`);
  }
  const others = objectives.length - active.length;
  const tail = others > 0 ? `\n(+${others} not active: paused, done or retired)` : "";
  return {
    objective: null,
    section: {
      name: "Objective",
      title: "Objectives",
      body: missingNote + (lines.length ? lines.join("\n") : "(no objectives)") + tail,
      hint: "list_objectives for the rest",
    },
  };
}

function taskLine(t: TaskSummary): string {
  const parts = [`- [${t.status}] ${t.id} — ${oneLine(t.title, 160)}`];
  if (t.status === "awaiting-ed" && t.ask) {
    parts.push(`ask: ${oneLine(t.ask, 240)}${t.options.length ? ` (options: ${t.options.join(" / ")})` : ""}`);
  }
  if (t.objective) parts.push(`objective ${t.objective}`);
  if (t.due) parts.push(`due ${t.due}`);
  return parts.join(" · ");
}

function openTasksSection(tasks: TaskSummary[]): Section {
  const shown = tasks.slice(0, OPEN_TASKS_CAP);
  const more = tasks.length - shown.length;
  return {
    name: "Open tasks",
    title: "Open tasks",
    body: shown.length
      ? shown.map(taskLine).join("\n") + (more > 0 ? `\n+${more} more (list_tasks)` : "")
      : "(no open tasks)",
    hint: "list_tasks for the rest",
  };
}

function answeredSection(tasks: TaskSummary[], since: string | null, sinceLabel: string): Section {
  const lines = tasks.map((t) => {
    const a = t.answer!;
    const what = [a.choice ? `chose "${oneLine(a.choice, 80)}"` : "", a.text ? `said: ${oneLine(a.text, 300)}` : ""]
      .filter(Boolean)
      .join("; ");
    return `- ${t.id} — ${oneLine(t.title, 120)} · answered by ${a.by ?? "?"} at ${stamp(a.at)}${what ? ` · ${what}` : ""} · now ${t.status}`;
  });
  return {
    name: "Answered since last wake",
    title: "Answered since last wake",
    body: `Since ${since ? stamp(since) : "?"} (${sinceLabel}).\n` + (lines.length ? lines.join("\n") : "(nothing answered)"),
  };
}

function runLine(r: RunSummary): string {
  const mark = r.expectResult === "met" ? "✔" : r.expectResult === "missing" ? "✘" : "–";
  const exp = r.expect ? ` (${r.expect.kind}${r.expect.within ? ` within ${r.expect.within}` : ""})` : "";
  const err = r.status === "failed" && r.error ? ` · error: ${oneLine(r.error, 160)}` : "";
  const who = r.trigger ? `${r.trigger} · ` : "";
  return `- ${r.id} · ${who}${stamp(r.started)} · ${r.status} · expect ${mark} ${r.expectResult ?? "n/a"}${exp}${err}`;
}

function alertLine(a: Alert): string {
  return `- [${a.severity}] ${a.id} — ${oneLine(a.message, 240)}`;
}

// --- the builder -----------------------------------------------------------------------

export async function buildBriefing(src: BriefingSources, p: BriefingParams): Promise<Briefing> {
  const { state, project } = src;
  const layout = state.layout(project.dir);
  const isHome = project.slug === "";
  const trig = p.trigger ? project.triggers?.[p.trigger] : undefined;
  const now = p.now;

  // Runs: enough months for the alert windows; this run itself is excluded below.
  const effective = src.behaviours ?? effectiveBehaviours({ slug: project.slug }, null);
  const aTriggers = alertTriggers(project.triggers, triggerGatePredicate(effective));
  const runPage = await state.runs.list(layout, { months: monthsToRead(aTriggers) });
  const allRuns = runPage.runs;
  const earlier = allRuns.filter((r) => r.id !== p.runId && (p.trigger ? r.trigger === p.trigger : true));

  // 1 Header
  const header: Section = {
    name: "Header",
    title: "Briefing",
    body: [
      `- Project: ${workspaceName(project.slug)}`,
      `- Now: ${now.toISOString()}`,
      `- Kind: ${p.kind}`,
      `- Run: ${p.runId ?? "none"}`,
      `- Trigger: ${p.trigger ?? "none"}`,
      `- Why: ${describeWhy(p, trig)}`,
    ].join("\n"),
  };

  // 2–4
  const protocol: Section = { name: "Protocol", title: "Protocol", body: MANAGER_PROTOCOL };
  const behaviours: Section = {
    name: "Behaviours",
    title: "Behaviours",
    body: behavioursBriefingBody(effective),
  };
  const connections: Section = { name: "Connections", title: "Connections", body: "(none configured)" };

  // 5 Memory
  const shared = await memorySection("Shared memory", state.rootLayout, "memory/MEMORY.md at the root");
  const own: Section = isHome
    ? { name: "Project memory", title: "Project memory", body: "(Home's own memory is the shared memory above)" }
    : await memorySection("Project memory", layout, "memory/MEMORY.md");

  // 6 Objective(s)
  const obj = await objectiveSection(src, layout, p.objective ?? null, now);

  // 7 Open tasks
  const open = await state.tasks.list(layout);
  const openTasks = openTasksSection(open.tasks);

  // 8 Answered since the last wake (of this trigger; any trigger for a chat)
  const last = earlier[0];
  const since = last?.started ?? new Date(now.getTime() - ANSWERED_FALLBACK_DAYS * 86_400_000).toISOString();
  const sinceLabel = last
    ? `the start of ${last.id}${p.trigger ? `, this trigger's previous run` : ", the latest run"}`
    : `no earlier run, so the last ${ANSWERED_FALLBACK_DAYS} days`;
  const doneMonths = [...new Set([monthOf(now), since.slice(0, 7)])].filter((m) => open.doneMonths.includes(m)).sort();
  const candidates: TaskSummary[] = [...open.tasks];
  for (const m of doneMonths) candidates.push(...(await state.tasks.list(layout, { month: m })).tasks);
  const sinceMs = Date.parse(since);
  const answered = candidates
    .filter((t) => t.answer?.at && Date.parse(t.answer.at) > sinceMs)
    .sort((a, b) => b.answer!.at!.localeCompare(a.answer!.at!) || a.id.localeCompare(b.id));
  const answeredSec = answeredSection(answered, since, sinceLabel);

  // 9 Recent runs
  const runs: Section = {
    name: "Recent runs",
    title: p.trigger ? `Recent runs of ${p.trigger}` : "Recent runs",
    body: earlier.length ? earlier.slice(0, RECENT_RUNS_CAP).map(runLine).join("\n") : "(no earlier runs)",
  };

  // 10 Alerts
  const schedules = src.schedules ? await src.schedules().catch(() => [] as AlertSchedule[]) : [];
  const extra = src.extraAlerts ? await src.extraAlerts().catch(() => [] as Alert[]) : [];
  const alerts = sortAlerts([...computeAlerts({ triggers: aTriggers, runs: allRuns, schedules, now }), ...extra]);
  const alertsSec: Section = {
    name: "Alerts",
    title: "Alerts",
    body: alerts.length ? alerts.map(alertLine).join("\n") : "(no alerts)",
  };

  // 11 Recent project log
  const logPage = await state.episodes.page(layout, null, { months: 3 });
  const logSec: Section = {
    name: "Recent project log",
    title: "Recent project log",
    body: logPage.entries.length
      ? logPage.entries.slice(0, LOG_ENTRIES).map((e) => episodeLine(e, 300)).join("\n")
      : "(no log entries yet)",
  };

  // 12 OVERVIEW.md
  const overview = (await src.readOverview().catch(() => "")).trim();
  const overviewSec: Section = {
    name: "OVERVIEW.md",
    title: "OVERVIEW.md",
    body: overview ? embed(overview) : "(no OVERVIEW.md yet)",
    hint: "read OVERVIEW.md for the rest",
  };

  const ordered = [
    header,
    protocol,
    behaviours,
    connections,
    shared,
    own,
    obj.section,
    openTasks,
    answeredSec,
    runs,
    alertsSec,
    logSec,
    overviewSec,
  ];
  const rendered = ordered.map((s) => ({ name: s.name, text: renderSection(s) }));
  return {
    text: rendered.map((r) => r.text).join("\n\n") + "\n",
    sections: rendered.map((r) => ({ name: r.name, chars: r.text.length })),
    objective: obj.objective,
  };
}

// --- wiring ----------------------------------------------------------------------------

/** What a caller (the fire path, the REST preview, the tool, the chat preload) supplies. */
type BriefedWorkspace = {
  slug: string;
  dir: string;
  triggers?: Record<string, PaddockTrigger>;
  behaviours?: Record<string, BehaviourConfig>;
};

export interface BriefingDeps<P extends BriefedWorkspace> {
  state: ManagersState;
  projects: { get(slug: string): Promise<P>; readOverview(slug: string): Promise<string> };
  herdctl?: { listAgentSchedules(project: P): Promise<AlertSchedule[]> };
}

/** Resolve a workspace (throws the ProjectStore's not-found) and build its briefing. */
export async function briefingForWorkspace<P extends BriefedWorkspace>(
  deps: BriefingDeps<P>,
  slug: string,
  params: BriefingParams,
  project?: P,
): Promise<Briefing> {
  const p = project ?? (await deps.projects.get(slug));
  const behaviours = await behavioursFor(deps.projects, { slug, behaviours: p.behaviours });
  return buildBriefing(
    {
      state: deps.state,
      project: { slug, dir: p.dir, triggers: p.triggers },
      readOverview: () => deps.projects.readOverview(slug),
      schedules: deps.herdctl ? () => deps.herdctl!.listAgentSchedules(p) : undefined,
      behaviours,
      extraAlerts: async () => {
        const a = await behaviourDriftAlert(p.dir, behaviours, p.triggers);
        return a ? [a] : [];
      },
    },
    params,
  );
}

/** A trigger's `run.briefing` → whether a fire is briefed (schedule: on unless `false`; others: only when set). */
export function triggerWantsBriefing(t: { trigger: { type: string }; run: { briefing?: false | { objective?: string } } }): boolean {
  const b = t.run.briefing;
  if (t.trigger.type === "schedule") return b !== false;
  return typeof b === "object" && b !== null;
}
