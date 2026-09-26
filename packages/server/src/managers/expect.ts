/**
 * expect — evaluating a run's `expect` against what the run recorded (M6).
 *
 * Pure. The run record already lists the episodes, tasks, reports and artifacts
 * the run's own writes touched (the writer notes each one on the run as it lands),
 * so the check needs no scan of the logs.
 *
 *   none / no expect      → n/a
 *   episode               → met when the run recorded at least one episode
 *   report                → met when it wrote `expect.report` (any report when unset)
 *   artifact              → met when it called `record_artifact` at least once.
 *                           This trusts the agent (plan M6); the `stale` alert is
 *                           the backstop that does not.
 */
import type { RunWrite } from "./schemas.js";

export type ExpectResult = "met" | "missing" | "n/a";

type RunLike = Pick<RunWrite, "expect" | "episodes" | "reports" | "artifacts">;

export function evaluateExpect(run: RunLike): ExpectResult {
  const e = run.expect;
  if (!e || e.kind === "none") return "n/a";
  switch (e.kind) {
    case "episode":
      return run.episodes.length > 0 ? "met" : "missing";
    case "report":
      return (e.report ? run.reports.includes(e.report) : run.reports.length > 0) ? "met" : "missing";
    case "artifact":
      return run.artifacts.length > 0 ? "met" : "missing";
    default:
      return "n/a";
  }
}

/** `48h` / `7d` → milliseconds, or null for anything else. */
export function withinMs(within: string | null | undefined): number | null {
  const m = typeof within === "string" ? /^(\d+)([hd])$/.exec(within) : null;
  if (!m) return null;
  const n = Number(m[1]);
  return n * (m[2] === "h" ? 3_600_000 : 86_400_000);
}
