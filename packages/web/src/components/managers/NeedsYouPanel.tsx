/**
 * NeedsYouPanel (Managers M13): the top of the ROOT's Home — everything any
 * manager is waiting on Ed for, across every project and Home itself.
 *
 * One read, `GET /api/managers/needs-you`, which the server computes from the
 * same files the per-project routes read (no model involved). Grouped by
 * workspace, in the server's order (longest-waiting ask first):
 *
 *   - the group's header links to that workspace's Home, with its counts and a
 *     "Status report 3d old" hint when the report is out of date;
 *   - each ask renders {@link TaskAnswer}, so Ed answers from here — the same
 *     form, the same route and the same "Wake the manager now" switch as the
 *     Tasks tab;
 *   - each alert is a row with its severity that opens the project's Home, where
 *     the status card shows the same alert live;
 *   - a workspace the server could not read is an error row of its own, and
 *     never hides the others.
 *
 * Empty: "Nothing needs you — N projects checked". Failed: an error Callout with
 * Retry. Paddock's Running/Unread feeds stay below it, untouched.
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { api } from "../../lib/api";
import { relativeTime } from "../../lib/format";
import type {
  ManagersAlert,
  NeedsYouEntry,
  NeedsYouError,
  NeedsYouGroup,
  NeedsYouResponse,
  TaskAnswerResult,
  TaskSummary,
  WakeAvailability,
} from "../../lib/types";
import { homeUrl, tasksUrl, viewBase } from "../../routes/ProjectView/urls";
import { Toast } from "../Toast";
import { AlertIcon, CheckIcon, ChevronRightIcon } from "../icons";
import { Button, Callout, Card, Chip, EmptyState } from "../ui";
import { TaskAnswer } from "./TaskAnswer";
import { ALERT_SEVERITY_TONE, ListSkeleton, PaneError, answeredMessage, errorText } from "./shared";

const SEVERITY_LABEL: Record<ManagersAlert["severity"], string> = {
  error: "Error",
  warning: "Warning",
  info: "Info",
};

const isError = (e: NeedsYouEntry): e is NeedsYouError => "error" in e;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** A test id segment for a workspace: Home's key is `""`. */
const keyOf = (slug: string) => slug || "home";

/** "3d old", "20h old" — how old a status report is. */
export function reportAge(generated: string, now = Date.now()): string {
  const ms = now - Date.parse(generated);
  if (!Number.isFinite(ms)) return "out of date";
  // Rounded like `relativeTime`, so this hint and the project's status card
  // ("Generated 3d ago") never disagree about the same report.
  const hours = Math.round(ms / 3_600_000);
  return hours < 48 ? `${hours}h old` : `${Math.round(hours / 24)}d old`;
}

/** The header's one-line summary of the totals. */
export function totalsLine(t: NeedsYouResponse["totals"]): string {
  const parts: string[] = [];
  if (t.needsYou) parts.push(plural(t.needsYou, "ask"));
  if (t.alerts) parts.push(plural(t.alerts, "alert"));
  if (t.errors) parts.push(`${plural(t.errors, "project")} unreadable`);
  const checked = plural(t.checked, "project");
  return parts.length ? `${parts.join(" · ")} — ${checked} checked` : `${checked} checked`;
}

type ToastState = { message: string; tone: "success" | "error" } | null;

export function NeedsYouPanel() {
  const [data, setData] = useState<NeedsYouResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<ToastState>(null);
  const dismissToast = useCallback(() => setToast(null), []);

  // `quiet`: keep showing what we have while re-reading (after an answer), so
  // the list does not flash back to a skeleton.
  const load = useCallback(async (quiet = false) => {
    if (!quiet) {
      setError(null);
      setData(null);
    }
    try {
      setData(await api.managersNeedsYou());
      setError(null);
    } catch (e) {
      if (!quiet) setError(errorText(e, "unknown error"));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const onAnswered = (slug: string, taskId: string, message: string) => {
    // Drop the row at once; the quiet re-read then settles the counts (and
    // removes a group with nothing left in it).
    setData((d) =>
      d && {
        ...d,
        projects: d.projects.map((p) =>
          !isError(p) && p.slug === slug ? { ...p, needsYou: p.needsYou.filter((t) => t.id !== taskId) } : p,
        ),
      },
    );
    setToast({ message, tone: "success" });
    void load(true);
  };

  return (
    <section className="@container mb-8" data-testid="needs-you">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-fg-muted">
          Needs you
          {data && data.totals.needsYou > 0 && <span className="ml-1.5 text-fg-subtle">{data.totals.needsYou}</span>}
        </h3>
        {/* Not on the empty state, which already says how many were checked. */}
        {data && data.projects.length > 0 && (
          <span className="text-xs text-fg-subtle tabular" data-testid="needs-you-totals">
            {totalsLine(data.totals)}
          </span>
        )}
      </div>

      {error ? (
        <PaneError what="what needs you" message={error} onRetry={() => void load()} />
      ) : !data ? (
        <ListSkeleton rows={2} testId="needs-you-loading" />
      ) : data.projects.length === 0 ? (
        <EmptyState
          variant="panel"
          icon={<CheckIcon width={22} height={22} />}
          title={`Nothing needs you — ${plural(data.totals.checked, "project")} checked`}
          body="No manager is waiting on an answer, and every trigger is producing what it should."
          action={
            <Button variant="ghost" onClick={() => void load()}>
              Check again
            </Button>
          }
        />
      ) : (
        // Side by side only when the PANE is wide (a container query, not the
        // viewport: with the sidebar and the chat list open, a 1280px window
        // leaves Home ~700px, and two columns there wrap every ask into a
        // tower). `items-start` so a group with one alert doesn't stretch to its
        // neighbour's three asks. `min-w-0`: a long ask must wrap, not widen.
        <div className="grid items-start gap-4 @4xl:grid-cols-2" data-testid="needs-you-groups">
          {data.projects.map((p) =>
            isError(p) ? (
              <ErrorGroup key={`e:${p.slug}`} entry={p} />
            ) : (
              <Group
                key={`g:${p.slug}`}
                group={p}
                onAnswered={(taskId, message) => onAnswered(p.slug, taskId, message)}
              />
            ),
          )}
        </div>
      )}
      <Toast message={toast?.message ?? null} tone={toast?.tone} onDismiss={dismissToast} />
    </section>
  );
}

function GroupHeader({ slug, name, children }: { slug: string; name: string; children?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <Link
        to={homeUrl(viewBase(slug))}
        className="group inline-flex min-w-0 items-center gap-1 rounded-md text-sm font-semibold text-fg focus-visible:focus-ring can-hover:hover:underline"
        data-testid={`needs-you-project-${keyOf(slug)}`}
      >
        <span className="truncate">{name}</span>
        <ChevronRightIcon width={13} height={13} className="shrink-0 text-fg-subtle" />
      </Link>
      {children}
    </div>
  );
}

function Group({
  group,
  onAnswered,
}: {
  group: NeedsYouGroup;
  onAnswered: (taskId: string, message: string) => void;
}) {
  const base = viewBase(group.slug);
  const [wake, setWake] = useState<WakeAvailability | null>(null);
  const hasAsks = group.needsYou.length > 0;

  // Whether an answer can wake THIS workspace's manager — only asked when there
  // is something to answer.
  useEffect(() => {
    if (!hasAsks) return;
    let live = true;
    api
      .managersWake(group.slug)
      .then((w) => live && setWake(w))
      .catch(() => live && setWake({ available: false, reason: "couldn't check the wake trigger" }));
    return () => {
      live = false;
    };
  }, [group.slug, hasAsks]);

  return (
    <Card className="min-w-0 space-y-3 p-4" data-testid={`needs-you-group-${keyOf(group.slug)}`}>
      <GroupHeader slug={group.slug} name={group.name}>
        {hasAsks && (
          <Chip tone="warn" shape="pill">
            {plural(group.needsYou.length, "ask")}
          </Chip>
        )}
        {group.alerts.length > 0 && (
          <Chip tone={ALERT_SEVERITY_TONE[group.alerts[0]!.severity]} shape="pill">
            {plural(group.alerts.length, "alert")}
          </Chip>
        )}
        {group.status.stale && group.status.generated && (
          <Chip tone="neutral" shape="pill" title={`Generated ${group.status.generated}`}>
            Status report {reportAge(group.status.generated)}
          </Chip>
        )}
      </GroupHeader>

      {hasAsks && (
        <ul className="space-y-3">
          {group.needsYou.map((t) => (
            <AskRow
              key={t.id}
              slug={group.slug}
              base={base}
              task={t}
              wake={wake}
              onAnswered={(result, answer) => onAnswered(t.id, answeredMessage(result, answer, !!result.wake))}
            />
          ))}
        </ul>
      )}

      {group.alerts.length > 0 && (
        <ul className="space-y-1" data-testid="needs-you-alerts">
          {group.alerts.map((a) => (
            <li key={a.id}>
              <Link
                to={homeUrl(base)}
                className="-mx-2 flex items-start gap-2 rounded-lg px-2 py-1.5 transition-colors focus-visible:focus-ring can-hover:hover:bg-surface-hover"
                data-testid={`needs-you-alert-${a.id}`}
              >
                <Chip tone={ALERT_SEVERITY_TONE[a.severity]} shape="pill" dot className="mt-0.5 shrink-0">
                  {SEVERITY_LABEL[a.severity]}
                </Chip>
                <span className="min-w-0 flex-1">
                  <span className="block break-words text-sm text-fg">{a.message}</span>
                  <span className="block font-mono text-2xs text-fg-subtle">{a.id}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {group.parseErrors.length > 0 && (
        <p className="text-xs text-warn" data-testid="needs-you-parse-errors">
          {plural(group.parseErrors.length, "task file")} won&rsquo;t parse, so an ask could be missing here.{" "}
          <Link to={tasksUrl(base)} className="underline underline-offset-2">
            Open Tasks
          </Link>
        </p>
      )}
    </Card>
  );
}

function AskRow({
  slug,
  base,
  task,
  wake,
  onAnswered,
}: {
  slug: string;
  base: string;
  task: TaskSummary;
  wake: WakeAvailability | null;
  onAnswered: (result: TaskAnswerResult, answer: string) => void;
}) {
  const waiting = task.updated ?? task.created;
  return (
    <li className="min-w-0 border-t border-edge-subtle pt-3 first:border-t-0 first:pt-0" data-testid={`needs-you-task-${task.id}`}>
      <div className="mb-1.5 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <Link
          to={`${tasksUrl(base)}#${task.id}`}
          className="min-w-0 break-words text-sm font-medium text-fg focus-visible:focus-ring can-hover:hover:underline"
        >
          {task.title}
        </Link>
        {waiting && <span className="text-2xs text-fg-subtle">asked {relativeTime(waiting)}</span>}
      </div>
      <TaskAnswer slug={slug} task={task} wake={wake} onAnswered={onAnswered} />
    </li>
  );
}

function ErrorGroup({ entry }: { entry: NeedsYouError }) {
  return (
    <Card className="min-w-0 space-y-3 p-4" data-testid={`needs-you-error-${keyOf(entry.slug)}`}>
      <GroupHeader slug={entry.slug} name={entry.name} />
      <Callout tone="danger" icon={<AlertIcon width={14} height={14} />}>
        <span className="break-words">
          Couldn&rsquo;t read this project&rsquo;s tasks or alerts: <span className="font-mono">{entry.error}</span>
        </span>
      </Callout>
    </Card>
  );
}
