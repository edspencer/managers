/**
 * TasksPane (Managers M11): the workspace's task list — the Tasks tab.
 *
 * Open tasks are grouped by status, **Awaiting you** first, because those are
 * the manager asking Ed something and nothing moves until he answers. Each of
 * those rows carries the answer form inline. Closed tasks (done and dropped)
 * live in `tasks/done/<month>/` and are loaded a month at a time behind "Show
 * done", so a long history never slows the list down.
 *
 * Filters (objective, status) live in the URL query, so a filtered list can be
 * linked and survives a reload. `#<task-id>` scrolls to and highlights a row:
 * that's the link a status report's "Needs you" section uses.
 *
 * `/tasks/:taskId` renders {@link TaskDetailView} instead of the list.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useLocation, useSearchParams } from "react-router-dom";
import { api } from "../../lib/api";
import type {
  ManagersParseError,
  ObjectiveSummary,
  TaskAnswerResult,
  TaskList,
  TaskStatus,
  TaskSummary,
  WakeAvailability,
} from "../../lib/types";
import { Button, Callout, Checkbox, Chip, EmptyState, Menu, MenuItem, Section, cx } from "../ui";
import { CheckIcon, ChevronDownIcon, PlusIcon } from "../icons";
import { Toast } from "../Toast";
import { NewTaskModal } from "./NewTaskModal";
import { TaskDetailView } from "./TaskDetail";
import { TaskRow } from "./TaskRow";
import {
  ALL_TASK_STATUSES,
  ListSkeleton,
  OPEN_TASK_ORDER,
  PaneError,
  PaneScroll,
  TASK_STATUS_LABEL,
  answeredMessage,
  errorText,
  monthLabel,
} from "./shared";

/** `?objective=` value for "tasks with no objective". */
export const NO_OBJECTIVE = "none";

type ToastState = { message: string; tone: "success" | "error" } | null;

/** The pane's filters, parsed from (and written to) the URL query. */
function useTaskFilters() {
  const [params, setParams] = useSearchParams();
  const objective = params.get("objective") || null;
  const statusParam = params.get("status");
  const statuses = useMemo(
    () =>
      statusParam
        ? (statusParam.split(",").filter((s) => (ALL_TASK_STATUSES as string[]).includes(s)) as TaskStatus[])
        : [],
    [statusParam],
  );
  const update = useCallback(
    (next: { objective?: string | null; statuses?: TaskStatus[] }) => {
      setParams(
        (prev) => {
          const p = new URLSearchParams(prev);
          if (next.objective !== undefined) {
            if (next.objective) p.set("objective", next.objective);
            else p.delete("objective");
          }
          if (next.statuses !== undefined) {
            if (next.statuses.length) p.set("status", next.statuses.join(","));
            else p.delete("status");
          }
          return p;
        },
        { replace: true, preventScrollReset: true },
      );
    },
    [setParams],
  );
  return { objective, statuses, update, active: objective !== null || statuses.length > 0 };
}

function matches(t: TaskSummary, objective: string | null, statuses: TaskStatus[]): boolean {
  if (objective === NO_OBJECTIVE ? t.objective !== null : objective !== null && t.objective !== objective) return false;
  if (statuses.length && !statuses.includes(t.status)) return false;
  return true;
}

function FilterButton({
  label,
  value,
  open,
  setOpen,
  children,
}: {
  label: string;
  value: string | null;
  open: boolean;
  setOpen: (v: boolean) => void;
  children: ReactNode;
}) {
  return (
    <div className="relative">
      <Button
        size="sm"
        variant={value ? "ghost" : "subtle"}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="max-w-[14rem]"
      >
        <span className="truncate">
          {label}
          {value ? `: ${value}` : ""}
        </span>
        <ChevronDownIcon width={12} height={12} className="shrink-0" />
      </Button>
      <Menu open={open} onClose={() => setOpen(false)} label={`Filter by ${label.toLowerCase()}`} align="left">
        {children}
      </Menu>
    </div>
  );
}

function ParseErrors({ errors }: { errors: ManagersParseError[] }) {
  if (!errors.length) return null;
  return (
    <Callout tone="warn" className="mb-4">
      <p>
        {errors.length === 1 ? "One task file" : `${errors.length} task files`} could not be read and{" "}
        {errors.length === 1 ? "is" : "are"} not listed:
      </p>
      <ul className="mt-1 list-disc pl-5 text-xs">
        {errors.map((e) => (
          <li key={e.file}>
            <span className="font-mono">{e.file}</span>: {e.error}
          </li>
        ))}
      </ul>
    </Callout>
  );
}

export function TasksPane({
  slug,
  base,
  taskId,
}: {
  /** Workspace key (`""` = Home). */
  slug: string;
  /** `viewBase(slug)`: where this workspace's routes hang. */
  base: string;
  /** `/tasks/:taskId`: render that task's page instead of the list. */
  taskId?: string;
}) {
  const [list, setList] = useState<TaskList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [objectives, setObjectives] = useState<ObjectiveSummary[]>([]);
  const [wake, setWake] = useState<WakeAvailability | null>(null);
  // Closed tasks, one entry per loaded `tasks/done/<month>`, newest first.
  const [done, setDone] = useState<{ month: string; tasks: TaskSummary[] }[]>([]);
  const [doneLoading, setDoneLoading] = useState(false);
  const [doneError, setDoneError] = useState<string | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [objMenu, setObjMenu] = useState(false);
  const [statusMenu, setStatusMenu] = useState(false);
  const [toast, setToast] = useState<ToastState>(null);
  const [highlight, setHighlight] = useState<string | null>(null);
  const dismissToast = useCallback(() => setToast(null), []);
  const filters = useTaskFilters();
  const location = useLocation();

  const load = useCallback(async () => {
    setError(null);
    try {
      const next = await api.managersTasks(slug);
      setList(next);
    } catch (e) {
      setError(errorText(e, "unknown error"));
    }
  }, [slug]);

  // The objectives (titles for the chips, the filter, the New task picker) and
  // whether an answer can wake the manager. Neither failing blocks the list.
  const loadSide = useCallback(async () => {
    const [objs, w] = await Promise.all([
      api.managersObjectives(slug).catch(() => null),
      api.managersWake(slug).catch(() => null),
    ]);
    if (objs) setObjectives(objs.objectives);
    setWake(w ?? { available: false, reason: "couldn't check the wake trigger" });
  }, [slug]);

  useEffect(() => {
    setList(null);
    setDone([]);
    setWake(null);
    void load();
    void loadSide();
  }, [load, loadSide]);

  // Re-read the loaded done months after a change (a task may have moved in or out).
  const reloadDone = useCallback(
    async (months: string[]) => {
      if (!months.length) return;
      const pages = await Promise.all(
        months.map((m) => api.managersTasks(slug, { month: m }).then((r) => ({ month: m, tasks: r.tasks }))),
      ).catch(() => null);
      if (pages) setDone(pages);
    },
    [slug],
  );

  const loadNextDone = useCallback(async () => {
    const months = list?.doneMonths ?? [];
    const next = months.find((m) => !done.some((d) => d.month === m));
    if (!next) return;
    setDoneLoading(true);
    setDoneError(null);
    try {
      const r = await api.managersTasks(slug, { month: next });
      setDone((prev) => [...prev, { month: next, tasks: r.tasks }]);
    } catch (e) {
      setDoneError(errorText(e, "unknown error"));
    } finally {
      setDoneLoading(false);
    }
  }, [slug, list, done]);

  // A status filter asking for closed tasks loads the newest closed month, so
  // the answer to "show me what's done" is never a misleading "no tasks match".
  const wantsClosed = filters.statuses.some((s) => s === "done" || s === "dropped");
  useEffect(() => {
    if (wantsClosed && list && done.length === 0 && list.doneMonths.length && !doneLoading) void loadNextDone();
  }, [wantsClosed, list, done.length, doneLoading, loadNextDone]);

  // `#<task-id>`: scroll to the row and flash it once the list is in.
  useEffect(() => {
    const id = location.hash.replace(/^#/, "");
    if (!id || !list) return;
    const el = document.getElementById(id);
    if (!el) return;
    el.scrollIntoView({ block: "center" });
    setHighlight(id);
    const t = setTimeout(() => setHighlight(null), 2500);
    return () => clearTimeout(t);
  }, [location.hash, list]);

  const afterChange = useCallback(async () => {
    await load();
    await reloadDone(done.map((d) => d.month));
  }, [load, reloadDone, done]);

  const onAnswered = useCallback(
    (_task: TaskSummary, result: TaskAnswerResult, answer: string) => {
      setToast({ message: answeredMessage(result, answer, result.wake !== undefined), tone: "success" });
      void afterChange();
    },
    [afterChange],
  );
  const onStatusChanged = useCallback(
    (task: TaskSummary, status: TaskStatus) => {
      setToast({ message: `“${task.title}” is now ${TASK_STATUS_LABEL[status].toLowerCase()}.`, tone: "success" });
      void afterChange();
    },
    [afterChange],
  );
  const onError = useCallback((message: string) => setToast({ message, tone: "error" }), []);

  const titleOf = useMemo(() => new Map(objectives.map((o) => [o.id, o.title])), [objectives]);

  if (taskId) {
    return (
      <TaskDetailView
        slug={slug}
        base={base}
        taskId={taskId}
        wake={wake}
        objectiveTitle={(id) => titleOf.get(id)}
      />
    );
  }

  const openTasks = list?.tasks ?? [];
  const closedTasks = done.flatMap((d) => d.tasks);
  const shownOpen = openTasks.filter((t) => matches(t, filters.objective, filters.statuses));
  const shownClosed = closedTasks.filter((t) => matches(t, filters.objective, filters.statuses));
  const groups = OPEN_TASK_ORDER.map((s) => ({ status: s, tasks: shownOpen.filter((t) => t.status === s) })).filter(
    (g) => g.tasks.length > 0,
  );
  const moreDone = (list?.doneMonths ?? []).find((m) => !done.some((d) => d.month === m)) ?? null;
  const nothingAtAll = list !== null && openTasks.length === 0 && list.doneMonths.length === 0;
  const zeroMatches =
    list !== null && !nothingAtAll && filters.active && shownOpen.length === 0 && shownClosed.length === 0;
  const objectiveFilterLabel =
    filters.objective === NO_OBJECTIVE
      ? "None"
      : filters.objective
        ? (titleOf.get(filters.objective) ?? filters.objective)
        : null;
  const statusFilterLabel = filters.statuses.length
    ? filters.statuses.map((s) => TASK_STATUS_LABEL[s]).join(", ")
    : null;
  const rowProps = { slug, base, wake, onAnswered, onStatusChanged, onError };

  const toggleStatus = (s: TaskStatus) =>
    filters.update({
      statuses: filters.statuses.includes(s) ? filters.statuses.filter((x) => x !== s) : [...filters.statuses, s],
    });

  return (
    <PaneScroll testId="tasks-pane">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <h2 className="mr-auto text-lg font-semibold tracking-tight text-fg">Tasks</h2>
        <Button
          size="sm"
          variant="primary"
          icon={<PlusIcon width={13} height={13} />}
          onClick={() => setNewOpen(true)}
          disabled={list === null}
        >
          New task
        </Button>
      </div>

      {list !== null && !nothingAtAll && (
        <div className="mb-5 flex flex-wrap items-center gap-2" data-testid="task-filters">
          <FilterButton label="Objective" value={objectiveFilterLabel} open={objMenu} setOpen={setObjMenu}>
            <MenuItem
              onClick={() => {
                filters.update({ objective: null });
                setObjMenu(false);
              }}
            >
              {filters.objective === null && <CheckIcon width={12} height={12} />}
              <span className={filters.objective === null ? "" : "pl-5"}>All objectives</span>
            </MenuItem>
            {objectives.map((o) => (
              <MenuItem
                key={o.id}
                onClick={() => {
                  filters.update({ objective: o.id });
                  setObjMenu(false);
                }}
              >
                {filters.objective === o.id && <CheckIcon width={12} height={12} />}
                <span className={cx("truncate", filters.objective === o.id ? "" : "pl-5")}>{o.title}</span>
              </MenuItem>
            ))}
            <MenuItem
              onClick={() => {
                filters.update({ objective: NO_OBJECTIVE });
                setObjMenu(false);
              }}
            >
              {filters.objective === NO_OBJECTIVE && <CheckIcon width={12} height={12} />}
              <span className={filters.objective === NO_OBJECTIVE ? "" : "pl-5"}>No objective</span>
            </MenuItem>
          </FilterButton>
          <FilterButton label="Status" value={statusFilterLabel} open={statusMenu} setOpen={setStatusMenu}>
            {ALL_TASK_STATUSES.map((s) => (
              <label
                key={s}
                role="menuitemcheckbox"
                aria-checked={filters.statuses.includes(s)}
                className="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm text-fg-muted hover:bg-surface-hover hover:text-fg"
              >
                <Checkbox checked={filters.statuses.includes(s)} onChange={() => toggleStatus(s)} />
                {TASK_STATUS_LABEL[s]}
              </label>
            ))}
          </FilterButton>
          {filters.active && (
            <Button size="sm" variant="link" onClick={() => filters.update({ objective: null, statuses: [] })}>
              Clear filters
            </Button>
          )}
        </div>
      )}

      {error ? (
        <PaneError what="tasks" message={error} onRetry={() => void load()} />
      ) : list === null ? (
        <ListSkeleton rows={4} testId="tasks-loading" />
      ) : nothingAtAll ? (
        <EmptyState
          variant="panel"
          icon={<CheckIcon width={24} height={24} />}
          title="No tasks yet"
          body="Tasks are the concrete steps toward an objective. The manager adds its own; add one of yours here."
          action={
            <Button variant="primary" icon={<PlusIcon width={13} height={13} />} onClick={() => setNewOpen(true)}>
              New task
            </Button>
          }
        />
      ) : (
        <>
          <ParseErrors errors={list.parseErrors ?? []} />
          {zeroMatches ? (
            <EmptyState
              variant="panel"
              title="No tasks match"
              body="Nothing here fits these filters. Try a different objective or status."
              action={
                <Button variant="ghost" onClick={() => filters.update({ objective: null, statuses: [] })}>
                  Clear filters
                </Button>
              }
            />
          ) : (
            <>
              {groups.length === 0 && !filters.active && (
                <EmptyState
                  title="Nothing open right now"
                  body="Every task is done or dropped."
                  action={
                    <Button size="sm" variant="ghost" icon={<PlusIcon width={12} height={12} />} onClick={() => setNewOpen(true)}>
                      New task
                    </Button>
                  }
                  className="mb-6"
                />
              )}
              {groups.map((g) => (
                <Section
                  key={g.status}
                  id={`group-${g.status}`}
                  title={
                    <span className="inline-flex items-center gap-2" data-testid={`task-group-${g.status}`}>
                      {TASK_STATUS_LABEL[g.status]} ({g.tasks.length})
                      {g.status === "awaiting-ed" && <Chip tone="warn" shape="pill" size="sm">needs you</Chip>}
                    </span>
                  }
                  flush
                  className={g.status === "awaiting-ed" ? "[&>div:last-child]:border-warn-edge" : undefined}
                >
                  <ul className="divide-y divide-edge-subtle">
                    {g.tasks.map((t) => (
                      <TaskRow
                        key={t.id}
                        {...rowProps}
                        task={t}
                        objectiveTitle={t.objective ? titleOf.get(t.objective) : undefined}
                        highlighted={highlight === t.id}
                      />
                    ))}
                  </ul>
                </Section>
              ))}

              {(list.doneMonths.length > 0 || done.length > 0) && (
                <section className="mb-6" data-testid="tasks-done">
                  {done.length === 0 ? (
                    <Button
                      variant="subtle"
                      size="sm"
                      loading={doneLoading}
                      loadingLabel="Loading…"
                      onClick={() => void loadNextDone()}
                    >
                      Show done
                    </Button>
                  ) : (
                    <>
                      <h3 className="text-sm font-semibold uppercase tracking-wide text-fg-muted">
                        Done &amp; dropped
                      </h3>
                      {done.map((d) => {
                        const rows = d.tasks.filter((t) => matches(t, filters.objective, filters.statuses));
                        return (
                          <div key={d.month} className="mt-3">
                            <p className="mb-1.5 text-2xs font-medium text-fg-subtle">{monthLabel(d.month)}</p>
                            {rows.length ? (
                              <ul className="divide-y divide-edge-subtle overflow-hidden rounded-2xl border border-edge bg-surface-raised">
                                {rows.map((t) => (
                                  <TaskRow
                                    key={t.id}
                                    {...rowProps}
                                    task={t}
                                    showStatus
                                    objectiveTitle={t.objective ? titleOf.get(t.objective) : undefined}
                                    highlighted={highlight === t.id}
                                  />
                                ))}
                              </ul>
                            ) : (
                              <EmptyState title={filters.active ? "None match the filters" : "Nothing closed this month"} />
                            )}
                          </div>
                        );
                      })}
                      {moreDone && (
                        <Button
                          className="mt-3"
                          variant="subtle"
                          size="sm"
                          loading={doneLoading}
                          loadingLabel="Loading…"
                          onClick={() => void loadNextDone()}
                        >
                          Load older · {monthLabel(moreDone)}
                        </Button>
                      )}
                    </>
                  )}
                  {doneError && (
                    <div className="mt-3">
                      <PaneError what="closed tasks" message={doneError} onRetry={() => void loadNextDone()} />
                    </div>
                  )}
                </section>
              )}
            </>
          )}
        </>
      )}

      <NewTaskModal
        slug={slug}
        open={newOpen}
        objectives={objectives}
        defaultObjective={filters.objective && filters.objective !== NO_OBJECTIVE ? filters.objective : null}
        onClose={() => setNewOpen(false)}
        onCreated={(t) => {
          setNewOpen(false);
          setToast({ message: `Added “${t.title}”.`, tone: "success" });
          void afterChange();
        }}
      />
      <Toast message={toast?.message ?? null} tone={toast?.tone} onDismiss={dismissToast} />
    </PaneScroll>
  );
}
