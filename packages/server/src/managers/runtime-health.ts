/**
 * runtime-health — the instance-level `runtime-unavailable` alert (#11).
 *
 * When the Claude login expires, EVERY turn in every workspace fails the same
 * way: a synthetic API-error reply and nothing else. Each of those runs is now
 * recorded `failed` with `errorKind: runtime` (or `no-output`), which would give
 * Ed one `run-failed` alert per trigger (plus the `stale` ones they cause), a
 * screenful of near-identical rows. {@link runtimeAlert} turns that into ONE error
 * on Home's "Needs you" instead, derived from the run records alone (so it
 * survives a restart and needs no state of its own):
 *
 *   - Walk every workspace's finished runs, newest first. A `succeeded` run ends
 *     the walk: the runtime worked then, so nothing older counts. That is what
 *     clears the alert: the next good run anywhere.
 *   - A failed run with a runtime-class `errorKind` joins the streak; any other
 *     failure (the agent's own error, a restart) is skipped, neither counted nor
 *     ending the streak.
 *   - The streak raises the alert at {@link RUNTIME_ALERT_MIN_RUNS} runs when they
 *     span two or more workspaces, or when the same error repeats. One project's
 *     one bad run stays that project's `run-failed`. The message quotes the error
 *     most of the streak shares.
 *
 * Pure and deterministic; {@link foldRuntimeAlerts} applies it to the collation.
 */
import type { Alert } from "./alerts.js";
import type { RunRecord } from "./schemas.js";

/** Runs in a streak before the instance alert is raised. */
export const RUNTIME_ALERT_MIN_RUNS = 2;

/** The one id (and kind) of the instance alert. */
export const RUNTIME_ALERT_ID = "runtime-unavailable:";

/** A run as the health check sees it, tagged with its workspace. */
export interface HealthRun extends Pick<RunRecord, "id" | "trigger" | "status" | "started" | "finished" | "error" | "errorKind"> {
  /** Workspace key (`""` is Home). */
  slug: string;
}

export interface RuntimeHealth {
  alert: Alert;
  /** The streak's runs, newest first. */
  runs: HealthRun[];
  /** Workspace key → the triggers whose LATEST finished run is in the streak. */
  triggers: Map<string, Set<string>>;
}

const finishedAt = (r: HealthRun): string => r.finished ?? r.started ?? "";

/** Newest first. Finish times are to the second, so on a tie a success counts as newer: the alert errs towards clearing. */
const newestFirst = (a: HealthRun, b: HealthRun): number =>
  finishedAt(b).localeCompare(finishedAt(a)) ||
  Number(b.status === "succeeded") - Number(a.status === "succeeded") ||
  b.id.localeCompare(a.id);

const isRuntimeFailure = (r: HealthRun): boolean =>
  r.status === "failed" && (r.errorKind === "runtime" || r.errorKind === "no-output");

/** "2026-10-04 11:15 UTC": absolute, since the alert can sit for days. */
function whenText(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "an unknown time";
  return `${new Date(t).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** The instance alert for these runs, or null when the runtime looks fine. */
export function runtimeAlert(runs: HealthRun[]): RuntimeHealth | null {
  const finished = runs
    .filter((r) => r.status === "succeeded" || r.status === "failed")
    .sort(newestFirst);
  const streak: HealthRun[] = [];
  for (const r of finished) {
    if (r.status === "succeeded") break;
    if (isRuntimeFailure(r)) streak.push(r);
  }
  if (streak.length < RUNTIME_ALERT_MIN_RUNS) return null;
  const workspaces = new Set(streak.map((r) => r.slug));
  const byError = new Map<string, number>();
  for (const r of streak) byError.set(r.error ?? "", (byError.get(r.error ?? "") ?? 0) + 1);
  const repeats = [...byError.values()].some((n) => n >= 2);
  if (workspaces.size < 2 && !repeats) return null;

  const latest = streak[0]!;
  const earliest = streak[streak.length - 1]!;
  // The error most of the streak shares (the newest on a tie): one odd empty turn
  // must not stand in for forty "Not logged in" ones.
  let common = latest.error ?? "";
  for (const r of streak) {
    const e = r.error ?? "";
    if ((byError.get(e) ?? 0) > (byError.get(common) ?? 0)) common = e;
  }
  const why = (common || "the turn produced no output").replace(/[.\s]+$/, "");
  const where = workspaces.size > 1 ? ` across ${workspaces.size} workspaces` : "";
  const alert: Alert = {
    id: RUNTIME_ALERT_ID,
    kind: "runtime-unavailable",
    trigger: "",
    severity: "error",
    message:
      `Claude runtime is failing: ${why}. ${streak.length} runs failed${where} since ${whenText(finishedAt(earliest))}. ` +
      "It clears on the next run that succeeds.",
    runId: latest.id,
    at: finishedAt(latest) || null,
  };

  // The triggers this explains: those whose newest finished run is in the streak.
  const inStreak = new Set(streak.map((r) => `${r.slug}\0${r.id}`));
  const seen = new Set<string>();
  const triggers = new Map<string, Set<string>>();
  for (const r of finished) {
    if (!r.trigger) continue;
    const key = `${r.slug}\0${r.trigger}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!inStreak.has(`${r.slug}\0${r.id}`)) continue;
    const set = triggers.get(r.slug) ?? new Set<string>();
    set.add(r.trigger);
    triggers.set(r.slug, set);
  }
  return { alert, runs: streak, triggers };
}

/**
 * A workspace's alerts minus the ones the instance alert already explains: a
 * `run-failed` or `stale` for a trigger whose latest run is in the streak.
 * Returns the kept alerts and how many were folded.
 */
export function foldRuntimeAlerts(
  alerts: Alert[],
  explained: Set<string> | undefined,
): { alerts: Alert[]; folded: number } {
  if (!explained || explained.size === 0) return { alerts, folded: 0 };
  const kept = alerts.filter(
    (a) => !((a.kind === "run-failed" || a.kind === "stale") && explained.has(a.trigger)),
  );
  return { alerts: kept, folded: alerts.length - kept.length };
}
