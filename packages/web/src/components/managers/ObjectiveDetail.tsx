/**
 * ObjectiveDetailView (Managers M11): one objective's page,
 * `…/objectives/:id`.
 *
 * The manager's three sections — "Where we are" (its rolling summary),
 * Strategy and Lessons — rendered as Markdown, then the tasks open against the
 * objective and its journal ({@link JournalTimeline}). The text is edited
 * through chat or the file itself in v1, so the page links "Edit in Files"
 * rather than offering a form.
 */
import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ApiError, api } from "../../lib/api";
import { relativeTime } from "../../lib/format";
import type { ObjectiveDetail, TaskSummary } from "../../lib/types";
import { objectivesUrl, tasksUrl } from "../../routes/ProjectView/urls";
import { Markdown } from "../Markdown";
import { Button, Chip, EmptyState, Section } from "../ui";
import { ChevronRightIcon, FileIcon, PlusIcon } from "../icons";
import { Toast } from "../Toast";
import { JournalTimeline } from "./JournalTimeline";
import { NewTaskModal } from "./NewTaskModal";
import {
  ListSkeleton,
  OBJECTIVE_STATUS_LABEL,
  OBJECTIVE_STATUS_TONE,
  PaneError,
  PaneScroll,
  TASK_STATUS_LABEL,
  TASK_STATUS_TONE,
  errorText,
} from "./shared";

/** `[[fact-name]]` → inline code, until M12 links facts to Memory. */
export function renderFactLinks(md: string): string {
  return md.replace(/\[\[([a-z0-9-]+)\]\]/g, "`$1`");
}

/** A workspace-relative file → its Files-tab URL, one segment at a time. */
function filesUrl(base: string, file: string): string {
  return `${base}/files/${file.split("/").map(encodeURIComponent).join("/")}`;
}

function Prose({ text, empty }: { text: string; empty: string }) {
  return text.trim() ? <Markdown>{renderFactLinks(text)}</Markdown> : <EmptyState title={empty} />;
}

export function ObjectiveDetailView({
  slug,
  base,
  objectiveId,
}: {
  slug: string;
  base: string;
  objectiveId: string;
}) {
  const [objective, setObjective] = useState<ObjectiveDetail | null>(null);
  const [error, setError] = useState<{ message: string; notFound: boolean } | null>(null);
  const [tasks, setTasks] = useState<TaskSummary[] | null>(null);
  const [tasksError, setTasksError] = useState<string | null>(null);
  const [newTask, setNewTask] = useState(false);
  const [toast, setToast] = useState<{ message: string; tone: "success" | "error" } | null>(null);
  const dismissToast = useCallback(() => setToast(null), []);
  const onError = useCallback((message: string) => setToast({ message, tone: "error" }), []);
  const navigate = useNavigate();

  const load = useCallback(async () => {
    setError(null);
    try {
      setObjective(await api.managersObjective(slug, objectiveId, { months: 1 }));
    } catch (e) {
      const notFound = e instanceof ApiError && (e.status === 404 || e.status === 400);
      setError({ message: errorText(e, "unknown error"), notFound });
    }
  }, [slug, objectiveId]);

  const loadTasks = useCallback(async () => {
    setTasksError(null);
    try {
      setTasks((await api.managersTasks(slug, { objective: objectiveId })).tasks);
    } catch (e) {
      setTasksError(errorText(e, "unknown error"));
    }
  }, [slug, objectiveId]);

  useEffect(() => {
    setObjective(null);
    setTasks(null);
    void load();
    void loadTasks();
  }, [load, loadTasks]);

  const back = (
    <Link
      to={objectivesUrl(base)}
      className="mb-3 inline-flex items-center gap-1 rounded-sm text-xs text-fg-muted hover:text-accent focus-visible:focus-ring"
    >
      <ChevronRightIcon width={12} height={12} className="rotate-180" />
      All objectives
    </Link>
  );

  if (error) {
    return (
      <PaneScroll testId="objective-detail">
        {back}
        {error.notFound ? (
          <EmptyState
            variant="panel"
            title="Objective not found"
            body={`There is no objective "${objectiveId}" in this workspace.`}
            action={
              <Button variant="ghost" onClick={() => navigate(objectivesUrl(base))}>
                Back to objectives
              </Button>
            }
          />
        ) : (
          <PaneError what="the objective" message={error.message} onRetry={() => void load()} />
        )}
      </PaneScroll>
    );
  }
  if (!objective) {
    return (
      <PaneScroll testId="objective-detail">
        {back}
        <ListSkeleton rows={3} testId="objective-loading" />
      </PaneScroll>
    );
  }

  const o = objective;
  return (
    <PaneScroll testId="objective-detail">
      {back}
      <header className="mb-6">
        <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
          <h2 className="min-w-0 flex-1 break-words text-xl font-semibold tracking-tight text-fg">{o.title}</h2>
          <Chip tone={OBJECTIVE_STATUS_TONE[o.status]} shape="pill" dot className="mt-1 shrink-0">
            {OBJECTIVE_STATUS_LABEL[o.status]}
          </Chip>
        </div>
        {o.success && (
          <p className="mt-2 text-sm text-fg-muted">
            <span className="font-medium text-fg">Success: </span>
            {o.success}
          </p>
        )}
        <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-fg-subtle">
          {o.updated && <span>Updated {relativeTime(o.updated)}</span>}
          {o.triggers.length > 0 && <span>Woken by {o.triggers.join(", ")}</span>}
          <Link
            to={filesUrl(base, o.file)}
            className="inline-flex items-center gap-1 rounded-sm text-accent hover:underline focus-visible:focus-ring"
          >
            <FileIcon width={11} height={11} />
            Edit in Files
          </Link>
        </p>
      </header>

      {o.preamble.trim() && (
        <div className="mb-6">
          <Markdown>{o.preamble}</Markdown>
        </div>
      )}
      {!o.whereWeAre.trim() && !o.strategy.trim() && !o.lessons.trim() ? (
        // A brand-new objective: one line, not three identical empty cards.
        <Section title="Where we are">
          <EmptyState
            title="The manager hasn't written anything here yet"
            body="On its next run it summarises where the objective stands, its strategy and what it has learned."
          />
        </Section>
      ) : (
        <>
          <Section title="Where we are">
            <Prose text={o.whereWeAre} empty="The manager hasn't summarised progress yet." />
          </Section>
          <Section title="Strategy">
            <Prose text={o.strategy} empty="No strategy written yet." />
          </Section>
          <Section title="Lessons">
            <Prose text={o.lessons} empty="No lessons recorded yet." />
          </Section>
        </>
      )}
      {o.otherSections.map((s) => (
        <Section key={s.heading} title={s.heading}>
          <Prose text={s.body} empty="Empty." />
        </Section>
      ))}

      <Section
        title={`Open tasks${tasks ? ` (${tasks.length})` : ""}`}
        flush
        action={
          <Button size="sm" variant="subtle" icon={<PlusIcon width={12} height={12} />} onClick={() => setNewTask(true)}>
            New task
          </Button>
        }
      >
        {tasksError ? (
          <div className="p-3">
            <PaneError what="tasks" message={tasksError} onRetry={() => void loadTasks()} />
          </div>
        ) : tasks === null ? (
          <div className="h-12 animate-pulse" aria-busy="true" />
        ) : tasks.length === 0 ? (
          <EmptyState className="px-4 py-3" title="No open tasks for this objective" />
        ) : (
          <ul className="divide-y divide-edge-subtle" data-testid="objective-tasks">
            {tasks.map((t) => (
              <li key={t.id} className="flex items-center gap-2 px-4 py-2.5">
                <Link
                  to={tasksUrl(base, t.id)}
                  className="min-w-0 flex-1 truncate rounded-sm text-sm text-fg hover:text-accent focus-visible:focus-ring"
                >
                  {t.title}
                </Link>
                <Chip tone={TASK_STATUS_TONE[t.status]} shape="pill" dot className="shrink-0">
                  {TASK_STATUS_LABEL[t.status]}
                </Chip>
              </li>
            ))}
          </ul>
        )}
      </Section>
      {tasks && tasks.length > 0 && (
        <p className="-mt-4 mb-6 text-2xs">
          <Link to={`${tasksUrl(base)}?objective=${encodeURIComponent(o.id)}`} className="text-accent hover:underline">
            All of this objective&rsquo;s tasks, including done
          </Link>
        </p>
      )}

      <Section title="Journal" variant="bare">
        <JournalTimeline slug={slug} base={base} objectiveId={o.id} initial={o.journal} onError={onError} />
      </Section>

      <NewTaskModal
        slug={slug}
        open={newTask}
        objectives={[{ id: o.id, title: o.title }]}
        defaultObjective={o.id}
        onClose={() => setNewTask(false)}
        onCreated={(t) => {
          setNewTask(false);
          setToast({ message: `Added “${t.title}”.`, tone: "success" });
          void loadTasks();
        }}
      />
      <Toast message={toast?.message ?? null} tone={toast?.tone} onDismiss={dismissToast} />
    </PaneScroll>
  );
}
