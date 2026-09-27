/**
 * alerts — the dead-man's switch (M6, plan §5 M6).
 *
 * {@link computeAlerts} is PURE and deterministic: the same triggers, runs,
 * schedules and `now` always give the same alerts in the same order. The kinds:
 *
 *   run-failed        the trigger's last run failed
 *   artifact-missing  the trigger's last FINISHED run succeeded but its
 *                     `expectResult` is `missing`
 *   stale             an ENABLED trigger with `expect.within` has no `met` run
 *                     inside that window — it stopped firing, or it fires and
 *                     produces nothing. The server-side backstop that does not
 *                     trust the agent.
 *   schedule-stalled  an ENABLED schedule whose herdctl `nextRunAt` is more than
 *                     15 minutes in the past
 *   run-stuck         a run still `running` more than 2 hours after it started
 *   behaviours-changed-outside-ui
 *                     (M8, info) the workspace's autonomy — a behaviour flag,
 *                     definition or trigger binding — changed other than
 *                     through the Behaviours route (`managers/behaviour-state.ts`)
 *   config-unreadable (M9.5, error) this workspace's or Home's `project.yaml`
 *                     could not be read, so every behaviour is treated as OFF
 *   bypass-permissions
 *                     (M9.5, warning) the keeper runs `bypassPermissions` while
 *                     a connection is narrowed by `tools:` (an allowlist, which
 *                     that mode does not enforce) or an OFF behaviour gates tools
 *   data-sync-failed  (M15, Home only) the data repo's pull/push failed — a
 *                     conflicting rebase (error, aborted) or anything else
 *                     (warning); see `managers/data-sync.ts`
 *
 * M8: a trigger whose behaviour is off counts as DISABLED here (it cannot fire,
 * so it is not stale and its schedule is not stalled).
 *
 * Ids are `<kind>:<trigger>`, one alert per kind per trigger. A failed run is
 * reported as `run-failed` only, never also as `artifact-missing`: the failure
 * is the cause.
 *
 * {@link loadAlerts} is the I/O wrapper the REST route and the `list_alerts`
 * tool share, so both see the same list.
 */
import type { PaddockTrigger } from "../trigger-config.js";
import type { RunRecord } from "./schemas.js";
import type { ManagersState } from "./state.js";
import { withinMs } from "./expect.js";
import { MAX_PAGE_MONTHS } from "./episodes-store.js";
import { CONFIG_UNREADABLE_BEHAVIOUR, triggerGatePredicate, type EffectiveBehaviour } from "./behaviours.js";
import { behaviourDriftAlert } from "./behaviour-state.js";
import { dataSyncAlert } from "./data-sync.js";
import path from "node:path";

export const ALERT_KINDS = [
  "run-failed",
  "schedule-stalled",
  "run-stuck",
  "stale",
  "artifact-missing",
  "behaviours-changed-outside-ui",
  "config-unreadable",
  "bypass-permissions",
  "data-sync-failed",
] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];
export type AlertSeverity = "error" | "warning" | "info";

export interface Alert {
  /** `<kind>:<trigger>` — stable across calls, so a UI can key on it. */
  id: string;
  kind: AlertKind;
  trigger: string;
  severity: AlertSeverity;
  message: string;
  /** The run the alert is about, when there is one. */
  runId: string | null;
  /** When the thing the alert is about happened (a run's start/finish, a missed fire). */
  at: string | null;
}

/** The slice of a trigger the alerts need. */
export interface AlertTrigger {
  name: string;
  type: "schedule" | "event" | "webhook";
  enabled: boolean;
  expect?: { kind: string; within?: string | null } | null;
}

/** The slice of herdctl's `ScheduleInfo` the alerts need, keyed by trigger name. */
export interface AlertSchedule {
  name: string;
  status?: string | null;
  nextRunAt?: string | null;
}

type AlertRun = Pick<RunRecord, "id" | "trigger" | "status" | "started" | "finished" | "expectResult" | "error">;

export const SCHEDULE_STALL_MS = 15 * 60_000;
export const RUN_STUCK_MS = 2 * 3_600_000;

const SEVERITY: Record<AlertKind, AlertSeverity> = {
  "run-failed": "error",
  "schedule-stalled": "error",
  "run-stuck": "warning",
  stale: "warning",
  "artifact-missing": "warning",
  "behaviours-changed-outside-ui": "info",
  "config-unreadable": "error",
  "bypass-permissions": "warning",
  "data-sync-failed": "error",
};

const SEVERITY_RANK: Record<AlertSeverity, number> = { error: 0, warning: 1, info: 2 };

const ts = (s: string | null | undefined): number | null => {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
};

/** Newest first by start time, id as the tie-break (deterministic). */
function byStartDesc(a: AlertRun, b: AlertRun): number {
  return (b.started ?? "").localeCompare(a.started ?? "") || b.id.localeCompare(a.id);
}

function ago(ms: number): string {
  const h = Math.floor(ms / 3_600_000);
  if (h >= 48) return `${Math.floor(h / 24)} days`;
  if (h >= 1) return `${h} h`;
  return `${Math.max(1, Math.floor(ms / 60_000))} min`;
}

export function computeAlerts(input: {
  triggers: AlertTrigger[];
  runs: AlertRun[];
  schedules: AlertSchedule[];
  now: Date;
}): Alert[] {
  const now = input.now.getTime();
  const out: Alert[] = [];
  const add = (kind: AlertKind, trigger: string, message: string, runId: string | null, at: string | null) =>
    out.push({ id: `${kind}:${trigger}`, kind, trigger, severity: SEVERITY[kind], message, runId, at });

  const runsBy = new Map<string, AlertRun[]>();
  for (const r of input.runs) {
    if (!r.trigger) continue;
    const list = runsBy.get(r.trigger) ?? [];
    list.push(r);
    runsBy.set(r.trigger, list);
  }
  for (const list of runsBy.values()) list.sort(byStartDesc);
  const triggerByName = new Map(input.triggers.map((t) => [t.name, t]));
  const schedByName = new Map(input.schedules.map((s) => [s.name, s]));

  // Every trigger that is configured OR has runs on disk (a deleted trigger's
  // last failure is still worth seeing until it ages out of the window read).
  const names = [...new Set([...triggerByName.keys(), ...runsBy.keys()])].sort();
  for (const name of names) {
    const trig = triggerByName.get(name);
    const runs = runsBy.get(name) ?? [];

    // run-stuck: the oldest run still running past the bound.
    const stuck = runs
      .filter((r) => r.status === "running")
      .map((r) => ({ r, t: ts(r.started) }))
      .filter((x): x is { r: AlertRun; t: number } => x.t !== null && now - x.t > RUN_STUCK_MS)
      .sort((a, b) => a.t - b.t || a.r.id.localeCompare(b.r.id))[0];
    if (stuck) {
      add("run-stuck", name, `Run ${stuck.r.id} has been running for ${ago(now - stuck.t)}.`, stuck.r.id, stuck.r.started);
    }

    // run-failed / artifact-missing: the last FINISHED run.
    const last = runs.find((r) => r.status !== "running");
    if (last?.status === "failed") {
      const why = last.error ? `: ${last.error}` : ".";
      add("run-failed", name, `The last run (${last.id}) failed${why}`, last.id, last.finished ?? last.started);
    } else if (last && last.status === "succeeded" && last.expectResult === "missing") {
      add(
        "artifact-missing",
        name,
        `The last run (${last.id}) finished without producing what it was expected to.`,
        last.id,
        last.finished ?? last.started,
      );
    }

    if (!trig || !trig.enabled) continue;

    // stale: no met run inside the expect window.
    const win = trig.expect && trig.expect.kind !== "none" ? withinMs(trig.expect.within) : null;
    if (win !== null) {
      const lastMet = runs.find((r) => r.expectResult === "met");
      const metAt = lastMet ? ts(lastMet.finished ?? lastMet.started) : null;
      if (metAt === null || now - metAt > win) {
        add(
          "stale",
          name,
          metAt === null
            ? `No run of ${name} has met its expectation yet (expected within ${trig.expect!.within}).`
            : `No run of ${name} has met its expectation for ${ago(now - metAt)} (expected within ${trig.expect!.within}).`,
          lastMet?.id ?? null,
          lastMet ? (lastMet.finished ?? lastMet.started) : null,
        );
      }
    }

    // schedule-stalled: herdctl says the next fire is long overdue.
    if (trig.type === "schedule") {
      const s = schedByName.get(name);
      const next = ts(s?.nextRunAt);
      if (s && s.status !== "disabled" && next !== null && now - next > SCHEDULE_STALL_MS) {
        add("schedule-stalled", name, `The schedule should have fired ${ago(now - next)} ago.`, null, s.nextRunAt ?? null);
      }
    }
  }

  return sortAlerts(out);
}

/** The one alert order: severity (error, warning, info), then kind, then trigger. */
export function sortAlerts(alerts: Alert[]): Alert[] {
  const order = (k: AlertKind) => ALERT_KINDS.indexOf(k);
  return [...alerts].sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      order(a.kind) - order(b.kind) ||
      a.trigger.localeCompare(b.trigger),
  );
}

/** A project's trigger map → the alert view of it. */
export function alertTriggers(
  map: Record<string, PaddockTrigger> | undefined,
  /** M8: the behaviour gate; a gated-off trigger reads as disabled. */
  gate?: (name: string, trigger: PaddockTrigger) => boolean,
): AlertTrigger[] {
  return Object.entries(map ?? {}).map(([name, t]) => ({
    name,
    type: t.trigger.type,
    enabled: t.enabled === true && (gate ? gate(name, t) : true),
    expect: t.run.expect ?? null,
  }));
}

/** How many months of run records to read so the widest `within` window is covered. */
export function monthsToRead(triggers: AlertTrigger[]): number {
  let widest = 31 * 86_400_000; // at least the last month, for run-failed / artifact-missing
  for (const t of triggers) widest = Math.max(widest, withinMs(t.expect?.within) ?? 0);
  return Math.min(MAX_PAGE_MONTHS, Math.ceil(widest / (28 * 86_400_000)) + 1);
}

/** Read a workspace's triggers, recent runs and live schedules, then compute its alerts. */
export async function loadAlerts(opts: {
  state: ManagersState;
  project: {
    dir: string;
    triggers?: Record<string, PaddockTrigger>;
    /** M9.5: for the `bypass-permissions` alert. */
    permissionMode?: string;
    mcp?: Record<string, unknown>;
  };
  schedules: () => Promise<AlertSchedule[]>;
  /** M8: the workspace's effective behaviours — gates triggers and checks for out-of-UI changes. */
  behaviours?: EffectiveBehaviour[];
  now?: Date;
}): Promise<Alert[]> {
  const gate = opts.behaviours ? triggerGatePredicate(opts.behaviours) : undefined;
  const triggers = alertTriggers(opts.project.triggers, gate);
  const layout = opts.state.layout(opts.project.dir);
  const [page, schedules] = await Promise.all([
    opts.state.runs.list(layout, { months: monthsToRead(triggers) }),
    opts.schedules().catch(() => [] as AlertSchedule[]),
  ]);
  const now = opts.now ?? new Date();
  const computed = computeAlerts({ triggers, runs: page.runs, schedules, now });
  // M15: the data repo is instance-wide, so its sync failure is Home's alert.
  const sync =
    path.resolve(opts.project.dir) === path.resolve(opts.state.projectsRoot)
      ? dataSyncAlert(opts.state.dataSync?.status)
      : null;
  const out = sync ? sortAlerts([...computed, sync]) : computed;
  if (!opts.behaviours) return out;
  const drift = await behaviourDriftAlert(opts.project.dir, opts.behaviours, opts.project.triggers).catch(() => null);
  const extra = [...(drift ? [drift] : []), ...configAlerts(opts.project, opts.behaviours)];
  return extra.length ? sortAlerts([...out, ...extra]) : out;
}

/** The one `config-unreadable` alert shape (M9.5; M14.5 reuses it for a hidden project). */
export function configUnreadableAlert(message: string): Alert {
  return {
    id: "config-unreadable:",
    kind: "config-unreadable",
    trigger: "",
    severity: SEVERITY["config-unreadable"],
    message,
    runId: null,
    at: null,
  };
}

/** M9.5: the `config-unreadable` and `bypass-permissions` alerts (pure). */
export function configAlerts(
  project: { permissionMode?: string; mcp?: Record<string, unknown> },
  behaviours: EffectiveBehaviour[],
): Alert[] {
  const out: Alert[] = [];
  const broken = behaviours.find((b) => b.name === CONFIG_UNREADABLE_BEHAVIOUR);
  if (broken) {
    out.push(configUnreadableAlert(broken.description));
  }
  if (project.permissionMode === "bypassPermissions") {
    const gatedTools = behaviours.some((b) => !b.enabled && b.tools.length > 0);
    const narrowed = Object.entries(project.mcp ?? {})
      .filter(([, c]) => !!c && typeof c === "object" && (c as { tools?: unknown }).tools !== undefined)
      .map(([name]) => name);
    if (gatedTools || narrowed.length > 0) {
      const why = [
        narrowed.length ? `the connection tool list (${narrowed.join(", ")}) is an allowlist this mode does not enforce` : null,
        gatedTools ? "OFF behaviours' tools are denied only by deny rules" : null,
      ].filter(Boolean);
      out.push({
        id: "bypass-permissions:",
        kind: "bypass-permissions",
        trigger: "",
        severity: SEVERITY["bypass-permissions"],
        message:
          `This project's keeper runs with permissionMode bypassPermissions: ${why.join("; ")}. ` +
          "Switch Settings → Permission mode back to a prompting mode unless you mean it.",
        runId: null,
        at: null,
      });
    }
  }
  return out;
}
