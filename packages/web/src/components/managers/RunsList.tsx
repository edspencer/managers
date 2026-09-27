/**
 * RunsList (Managers M12): the workspace's last ten Managers runs (trigger
 * fires — wakes, report refreshes, checks), newest first, on the project's Home.
 *
 * One dense row per run: status, the trigger, when it started, how long it took,
 * and whether it produced what its trigger expects (✔ met, ✘ missed). A row
 * opens the run drawer. These are Managers runs, not the chat History tab.
 *
 * Presentational over the list; the caller owns the drawer so an alert's "View
 * run" and a row open the same one.
 */
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../lib/api";
import { relativeTime } from "../../lib/format";
import type { RunRecord } from "../../lib/types";
import { EmptyState, StatusDot, cx } from "../ui";
import { CheckIcon, XIcon } from "../icons";
import { PaneError, RUN_STATUS_LABEL, RUN_STATUS_TONE, durationLabel, errorText, runSeconds } from "./shared";

/** How many runs Home shows. */
export const RUNS_SHOWN = 10;
/** How far back (months) it looks for them before giving up. */
const MAX_MONTHS = 12;

/** The newest `n` runs, paging back month by month until there are enough. */
export async function latestRuns(slug: string, n = RUNS_SHOWN): Promise<RunRecord[]> {
  const out: RunRecord[] = [];
  let before: string | undefined;
  let scanned = 0;
  do {
    const page = await api.managersRuns(slug, { before, months: 3 });
    out.push(...page.runs);
    scanned += page.months.length || 3;
    before = page.nextBefore ?? undefined;
  } while (out.length < n && before && scanned < MAX_MONTHS);
  return out.slice(0, n);
}

function ExpectMark({ run }: { run: RunRecord }) {
  if (run.expectResult === "met") {
    return (
      <span className="inline-flex items-center gap-1 text-success" title="Expectation met">
        <CheckIcon width={12} height={12} aria-hidden />
        <span className="sr-only">Expectation met</span>
      </span>
    );
  }
  if (run.expectResult === "missing") {
    return (
      <span className="inline-flex items-center gap-1 text-danger" title="Expectation missed">
        <XIcon width={12} height={12} aria-hidden />
        <span className="sr-only">Expectation missed</span>
      </span>
    );
  }
  return (
    <span className="text-fg-subtle" title="No expectation">
      –<span className="sr-only">No expectation</span>
    </span>
  );
}

export function RunsList({
  slug,
  base,
  onOpenRun,
  reloadKey = 0,
}: {
  slug: string;
  base: string;
  onOpenRun: (runId: string) => void;
  /** Bump to reload (e.g. after Refresh now finished a run). */
  reloadKey?: number;
}) {
  const [runs, setRuns] = useState<RunRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setRuns(await latestRuns(slug));
    } catch (e) {
      setError(errorText(e, "unknown error"));
    }
  }, [slug]);

  useEffect(() => {
    void load();
  }, [load, reloadKey]);

  if (error) return <PaneError what="runs" message={error} onRetry={() => void load()} />;
  if (runs === null) {
    return <div className="h-24 animate-pulse rounded-2xl border border-edge bg-surface-raised" aria-busy="true" aria-label="Loading runs" />;
  }
  if (runs.length === 0) {
    return (
      <EmptyState
        title="No runs yet — enable a trigger"
        body="A run is one scheduled wake, check or report. They appear here as soon as a trigger fires."
        action={
          <Link to={`${base}/triggers`} className="text-sm text-accent underline-offset-2 hover:underline">
            Open Triggers
          </Link>
        }
      />
    );
  }
  return (
    <div className="overflow-hidden rounded-2xl border border-edge bg-surface-raised" data-testid="runs-list">
      {runs.map((r, i) => {
        const secs = runSeconds(r);
        return (
          <button
            key={r.id}
            type="button"
            onClick={() => onOpenRun(r.id)}
            data-testid={`run-row-${r.id}`}
            className={cx(
              "flex w-full items-center gap-2.5 px-3 py-2.5 text-left transition-colors can-hover:hover:bg-surface-hover focus-visible:focus-ring",
              i > 0 && "border-t border-edge-subtle",
            )}
          >
            <StatusDot tone={RUN_STATUS_TONE[r.status]} pulse={r.status === "running"} />
            <span className="sr-only">{RUN_STATUS_LABEL[r.status]}</span>
            <span className="min-w-0 flex-1 truncate">
              <span className="font-mono text-sm text-fg">{r.trigger ?? r.kind}</span>
              {r.status === "failed" && <span className="ml-2 text-2xs font-medium text-danger">failed</span>}
            </span>
            <ExpectMark run={r} />
            <span className="w-12 shrink-0 text-right text-2xs tabular text-fg-subtle">
              {r.status === "running" ? "…" : durationLabel(secs)}
            </span>
            <span className="w-16 shrink-0 text-right text-2xs text-fg-subtle" title={r.started ?? undefined}>
              {relativeTime(r.started ?? undefined)}
            </span>
          </button>
        );
      })}
    </div>
  );
}
