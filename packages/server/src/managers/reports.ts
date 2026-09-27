/**
 * reports — the report primitive (M10, plan §5 M10).
 *
 * A REPORT TYPE is config plus a schedule plus a template. It is declared in
 * `project.yaml` `reports:`:
 *
 *   reports:
 *     status:
 *       enabled: false                 # the schedule; off by default (behaviour-like)
 *       schedule: { cron: "0 8 * * *" } # cron xor interval
 *       promptFile: status.md          # optional: .managers/triggers/status.md
 *       model: claude-sonnet-…         # optional
 *       description: …                 # optional
 *
 * The rules are the behaviours' (§2.2): DEFINITIONS merge field by field,
 * built-in < Home (the root) < project; `enabled` counts only when it is literally
 * `true` in the workspace's own file (the root's flag switches Home's own schedule
 * only). So the built-in `status` type exists everywhere and is scheduled nowhere
 * until a project opts in. "Refresh now" always works: a manual run is deliberate.
 *
 * Each effective type becomes a DERIVED trigger `report-<type>`
 * (`effective-triggers.ts`). `write_report` composes the file here
 * ({@link composeReport}): server frontmatter, a server title, then the
 * server-rendered "Needs you" (awaiting-ed tasks) and "Alerts" sections, then the
 * model's body with any model-written copies of those two sections removed — so
 * the model can never omit, soften or fake them.
 *
 * PURE: records in, records or text out.
 */
import { NAME_RE } from "./layout.js";
import type { Alert } from "./alerts.js";
import type { TaskSummary } from "./tasks-store.js";
import { STATUS_REPORT_TEMPLATE, genericReportTemplate } from "./templates/report-status.js";

/** One `project.yaml` `reports:` entry, as stored. Every field is optional. */
export interface ReportConfig {
  enabled?: boolean;
  description?: string;
  schedule?: ReportSchedule;
  /** A `.managers/triggers/*.md` prompt file (relative, `.md`). */
  promptFile?: string;
  model?: string;
}

export type ReportSchedule = { cron: string; interval?: undefined } | { interval: string; cron?: undefined };

export type ReportOrigin = "builtin" | "home" | "project";

/** A report type as it applies to one workspace. */
export interface EffectiveReportType {
  type: string;
  /** Whether its schedule is armed here (this workspace's own flag only). */
  enabled: boolean;
  description: string;
  schedule: ReportSchedule;
  promptFile: string | null;
  model: string | null;
  origin: ReportOrigin;
  /** Defined above this workspace. */
  inherited: boolean;
  /** The derived trigger's name, `report-<type>`. */
  trigger: string;
}

/** The derived trigger prefix; `report-*` names are reserved. */
export const REPORT_TRIGGER_PREFIX = "report-";
/** A report type fits a trigger name (≤ 64 characters) once prefixed. */
export const REPORT_TYPE_MAX = 64 - REPORT_TRIGGER_PREFIX.length;
/** Used when a type defines no schedule anywhere (it still needs one to be a schedule trigger). */
export const DEFAULT_REPORT_CRON = "0 8 * * *";

export function isReportType(name: unknown): name is string {
  return typeof name === "string" && name.length <= REPORT_TYPE_MAX && NAME_RE.test(name);
}

export function reportTriggerName(type: string): string {
  return `${REPORT_TRIGGER_PREFIX}${type}`;
}

/** Built-in report types, defined in every workspace (off until enabled there). */
export const BUILTIN_REPORT_TYPES: Readonly<Record<string, Readonly<ReportConfig>>> = {
  status: {
    description: "What the manager is working on, what is in flight, and what it needs from Ed.",
    schedule: { cron: DEFAULT_REPORT_CRON },
  },
};

/** The prompt a type runs when no `promptFile` is set (or it cannot be read). */
export function reportTemplate(t: Pick<EffectiveReportType, "type" | "description">): string {
  return t.type === "status" ? STATUS_REPORT_TEMPLATE : genericReportTemplate(t.type, t.description);
}

// --- sanitising ----------------------------------------------------------------

const str = (v: unknown, max: number): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined;

function sanitizeSchedule(v: unknown): ReportSchedule | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const r = v as Record<string, unknown>;
  const cron = str(r.cron, 200);
  const interval = str(r.interval, 100);
  if (cron && !interval) return { cron };
  if (interval && !cron) return { interval };
  return undefined;
}

/** A relative `.md` path with no traversal; the fire path re-checks containment. */
function sanitizePromptFile(v: unknown): string | undefined {
  const s = str(v, 200);
  if (!s || s.startsWith("/") || s.split(/[\\/]/).includes("..") || !s.toLowerCase().endsWith(".md")) return undefined;
  return s;
}

/**
 * One entry, leniently: an unusable FIELD is dropped, never the whole entry
 * (a dropped `enabled` just leaves the schedule off).
 */
export function sanitizeReport(raw: unknown): ReportConfig | null {
  if (raw === null) return {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const out: ReportConfig = {};
  if (typeof r.enabled === "boolean") out.enabled = r.enabled;
  const description = str(r.description, 500);
  if (description !== undefined) out.description = description;
  const schedule = sanitizeSchedule(r.schedule);
  if (schedule) out.schedule = schedule;
  const promptFile = sanitizePromptFile(r.promptFile);
  if (promptFile) out.promptFile = promptFile;
  const model = str(r.model, 200);
  if (model) out.model = model;
  return out;
}

/** A whole `reports:` map; `undefined` when nothing survives (so a report-less file stays byte-identical). */
export function sanitizeReports(raw: unknown): Record<string, ReportConfig> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: Record<string, ReportConfig> = {};
  for (const [name, val] of Object.entries(raw as Record<string, unknown>)) {
    if (!isReportType(name)) continue;
    const r = sanitizeReport(val);
    if (r) out[name] = r;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

// --- the merge -------------------------------------------------------------------

export interface ReportWorkspaceLike {
  slug: string;
  reports?: Record<string, ReportConfig>;
  /** M9.5: an unreadable `project.yaml` — every schedule here reads as off. */
  configError?: string;
}

const DEFINITION_KEYS = ["description", "schedule", "promptFile", "model"] as const;

/**
 * The report types that apply to `project`: built-ins, then Home's definitions,
 * then the project's own, field by field; `enabled` from the project's own entry
 * only. Sorted by type. `root` may be null (unreadable): built-ins and the
 * project's own definitions still apply. A workspace whose own file is
 * unreadable arms nothing (fail closed).
 */
export function effectiveReportTypes(
  project: ReportWorkspaceLike,
  root: ReportWorkspaceLike | null,
): EffectiveReportType[] {
  const isHome = project.slug === "";
  const own = project.reports ?? {};
  const home = isHome ? {} : (root?.reports ?? {});
  const names = [...new Set([...Object.keys(BUILTIN_REPORT_TYPES), ...Object.keys(home), ...Object.keys(own)])]
    .filter(isReportType)
    .sort();
  return names.map((type): EffectiveReportType => {
    const b = BUILTIN_REPORT_TYPES[type];
    const h = home[type];
    const o = own[type];
    const origin: ReportOrigin = b ? "builtin" : h || isHome ? "home" : "project";
    const pick = <K extends (typeof DEFINITION_KEYS)[number]>(k: K): ReportConfig[K] =>
      o?.[k] !== undefined ? o[k] : h?.[k] !== undefined ? h[k] : b?.[k];
    return {
      type,
      enabled: !project.configError && o?.enabled === true,
      description: pick("description") ?? "",
      schedule: pick("schedule") ?? { cron: DEFAULT_REPORT_CRON },
      promptFile: pick("promptFile") ?? null,
      model: pick("model") ?? null,
      origin,
      inherited: origin === "builtin" || (origin === "home" && !isHome),
      trigger: reportTriggerName(type),
    };
  });
}

// --- composing a report ------------------------------------------------------------

/** Headings the server owns; a model-written copy (and its section) is removed. */
const SERVER_SECTION_RE = /^(needs\s+you|alerts)\s*[:.!]?\s*$/i;

/**
 * Remove the model's own "Needs you" / "Alerts" sections (heading AND body, up
 * to the next `#`/`##` heading) and any leading `# ` title (the server writes the
 * title). Fence-aware: headings inside a code fence are content.
 */
export function stripServerSections(body: string): string {
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let fence = false;
  let skipping = false;
  let seenContent = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const h = fence ? null : /^(#{1,2})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      if (h[1] === "#" && !seenContent) {
        // A leading title: the server writes its own.
        skipping = false;
        continue;
      }
      skipping = SERVER_SECTION_RE.test(h[2] ?? "");
      if (skipping) continue;
    }
    if (skipping) continue;
    if (line.trim()) seenContent = true;
    out.push(line);
  }
  return out.join("\n").replace(/^\n+/, "").replace(/\s+$/, "");
}

/** `status` → `Status`, `weekly-digest` → `Weekly digest`. */
export function reportTypeTitle(type: string): string {
  const words = type.split("-");
  return [words[0]!.charAt(0).toUpperCase() + words[0]!.slice(1), ...words.slice(1)].join(" ");
}

/** Where a task opens in the UI (`/tasks#<id>` for Home). */
export function taskLink(slug: string, id: string): string {
  return slug === "" ? `/tasks#${id}` : `/projects/${slug}/tasks#${id}`;
}

const oneLine = (s: string, max: number): string => {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
};
/** Keep a title from closing its Markdown link. */
const linkText = (s: string): string => oneLine(s, 160).replace(/[[\]]/g, (c) => `\\${c}`);

export function renderNeedsYou(slug: string, tasks: TaskSummary[]): string {
  const asks = tasks
    .filter((t) => t.status === "awaiting-ed")
    .sort((a, b) => (a.created ?? "").localeCompare(b.created ?? "") || a.id.localeCompare(b.id));
  if (asks.length === 0) return "Nothing needs you right now.";
  return asks
    .map((t) => {
      const opts = t.options.length ? ` (options: ${t.options.map((o) => oneLine(o, 60)).join(" / ")})` : "";
      const ask = t.ask ? ` — ${oneLine(t.ask, 240)}${opts}` : "";
      return `- [${linkText(t.title)}](${taskLink(slug, t.id)})${ask}`;
    })
    .join("\n");
}

export function renderAlerts(alerts: Alert[]): string {
  if (alerts.length === 0) return "No alerts.";
  return alerts.map((a) => `- **${a.severity}** \`${a.id}\` — ${oneLine(a.message, 300)}`).join("\n");
}

export interface ComposeReportInput {
  type: string;
  /** Workspace key (`""` is Home). */
  slug: string;
  /** The project's display name (the title). */
  projectName: string;
  date: string;
  /** ISO second the report was written. */
  generated: string;
  runId: string | null;
  /** The previous dated report's date, or null. */
  previous: string | null;
  /** The model's body, already stripped of server sections. */
  body: string;
  tasks: TaskSummary[];
  alerts: Alert[];
}

/** The report file: server frontmatter, title, "Needs you", "Alerts", then the model's body. */
export function composeReport(i: ComposeReportInput): { frontmatter: Record<string, unknown>; body: string } {
  const frontmatter = { type: i.type, generated: i.generated, run: i.runId, previous: i.previous };
  const body = [
    `# ${reportTypeTitle(i.type)}: ${i.projectName}, ${i.date}`,
    "",
    "## Needs you",
    renderNeedsYou(i.slug, i.tasks),
    "",
    "## Alerts",
    renderAlerts(i.alerts),
    "",
    i.body.trim(),
    "",
  ].join("\n");
  return { frontmatter, body };
}
