/**
 * Small pieces shared by the Managers panes (M11): the status → tone maps, the
 * loading skeleton, the error callout with Retry, and date labels.
 *
 * Tones are MEANINGS (docs/DESIGN.md §2), so a theme decides the colour:
 * waiting on Ed is `warn` (it wants attention), in-progress is `info`, finished
 * is `success`, blocked is `danger`, and inert states are `neutral`.
 */
import type { ReactNode } from "react";
import { ApiError } from "../../lib/api";
import type { ObjectiveStatus, TaskAnswerResult, TaskStatus } from "../../lib/types";
import { Button, Callout, type ChipTone } from "../ui";
import { AlertIcon } from "../icons";

export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  "awaiting-ed": "Awaiting you",
  doing: "Doing",
  open: "Open",
  blocked: "Blocked",
  done: "Done",
  dropped: "Dropped",
};

export const TASK_STATUS_TONE: Record<TaskStatus, ChipTone> = {
  "awaiting-ed": "warn",
  doing: "info",
  open: "neutral",
  blocked: "danger",
  done: "success",
  dropped: "neutral",
};

/** Display order of the open-task groups: what needs Ed first. */
export const OPEN_TASK_ORDER: TaskStatus[] = ["awaiting-ed", "doing", "open", "blocked"];
/** Every status, in the order the filter menu lists them. */
export const ALL_TASK_STATUSES: TaskStatus[] = [...OPEN_TASK_ORDER, "done", "dropped"];

export const OBJECTIVE_STATUS_TONE: Record<ObjectiveStatus, ChipTone> = {
  active: "success",
  paused: "warn",
  done: "info",
  retired: "neutral",
};

export const OBJECTIVE_STATUS_LABEL: Record<ObjectiveStatus, string> = {
  active: "Active",
  paused: "Paused",
  done: "Done",
  retired: "Retired",
};

/** An error's message for a callout or toast. */
export function errorText(e: unknown, fallback: string): string {
  if (e instanceof ApiError) return e.message || fallback;
  if (e instanceof Error) return e.message || fallback;
  return fallback;
}

/** A pane's load failure: what went wrong, and a way out. */
export function PaneError({
  what,
  message,
  onRetry,
}: {
  /** "tasks", "objectives", … — completes "Couldn't load …". */
  what: string;
  message: string;
  onRetry: () => void;
}) {
  return (
    <Callout tone="danger" icon={<AlertIcon width={14} height={14} />}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span>
          Couldn&rsquo;t load {what}: {message}
        </span>
        <Button size="sm" variant="ghost" onClick={onRetry}>
          Retry
        </Button>
      </div>
    </Callout>
  );
}

/** Placeholder rows while a list loads. */
export function ListSkeleton({ rows = 3, testId }: { rows?: number; testId?: string }) {
  return (
    <div className="space-y-3" aria-busy="true" aria-label="Loading" data-testid={testId}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="h-20 animate-pulse rounded-2xl border border-edge bg-surface-raised" />
      ))}
    </div>
  );
}

/** The pane's scroll container and reading column, shared so the tabs line up. */
export function PaneScroll({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <div className="flex-1 overflow-y-auto overscroll-contain" data-testid={testId}>
      <div className="mx-auto max-w-3xl px-4 py-5 sm:px-6 sm:py-6">{children}</div>
    </div>
  );
}

/** `2026-09-24` → "Thu 24 Sep 2026" (UTC, because journal dates are UTC). */
export function dayLabel(ymd: string): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return ymd;
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** `2026-08` → "August 2026". */
export function monthLabel(ym: string): string {
  const d = new Date(`${ym}-01T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return ym;
  return d.toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" });
}

/** `…T07:04:00Z` → "07:04" (UTC, labelled as such where it matters). */
export function timeLabel(iso: string): string {
  const m = /T(\d{2}:\d{2})/.exec(iso);
  return m ? m[1]! : "";
}

/** What an answer did, in one line for the toast. */
export function answeredMessage(result: TaskAnswerResult, answer: string, wakeRequested: boolean): string {
  const said = answer.trim().replace(/[.!?…]+$/, "");
  const head = said ? `Answered “${said}”.` : "Answered.";
  if (result.wake?.fired) return `${head} The manager has been woken.`;
  if (wakeRequested && result.wake && !result.wake.fired) {
    return `${head} The manager was not woken: ${result.wake.reason ?? "the wake trigger did not start"}.`;
  }
  return `${head} The manager will see it on its next run.`;
}
