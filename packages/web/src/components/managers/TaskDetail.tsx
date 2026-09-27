/**
 * TaskDetailView (Managers M11): one task's page, `/tasks/:taskId`.
 *
 * Everything the file holds: the title and chips, the manager's ask with the
 * answer form (or Ed's answer, once given), the notes, where it was dispatched,
 * and its log. A task closed into `tasks/done/<month>/` resolves here too.
 */
import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ApiError, api } from "../../lib/api";
import { relativeTime } from "../../lib/format";
import type { TaskDetail, TaskStatus, WakeAvailability } from "../../lib/types";
import { tasksUrl } from "../../routes/ProjectView/urls";
import { Markdown } from "../Markdown";
import { Button, Card, EmptyState, Section } from "../ui";
import { ChevronRightIcon } from "../icons";
import { Toast } from "../Toast";
import { TaskAnswer } from "./TaskAnswer";
import { TaskChips, TaskStatusMenu } from "./TaskRow";
import { ListSkeleton, PaneError, PaneScroll, TASK_STATUS_LABEL, answeredMessage, errorText } from "./shared";

export function TaskDetailView({
  slug,
  base,
  taskId,
  wake,
  objectiveTitle,
}: {
  slug: string;
  base: string;
  taskId: string;
  wake: WakeAvailability | null;
  objectiveTitle: (id: string) => string | undefined;
}) {
  const [task, setTask] = useState<TaskDetail | null>(null);
  const [error, setError] = useState<{ message: string; notFound: boolean } | null>(null);
  const [toast, setToast] = useState<{ message: string; tone: "success" | "error" } | null>(null);
  const dismissToast = useCallback(() => setToast(null), []);
  const navigate = useNavigate();

  const load = useCallback(async () => {
    setError(null);
    try {
      setTask(await api.managersTask(slug, taskId));
    } catch (e) {
      const notFound = e instanceof ApiError && (e.status === 404 || e.status === 400);
      setError({ message: errorText(e, "unknown error"), notFound });
    }
  }, [slug, taskId]);

  useEffect(() => {
    setTask(null);
    void load();
  }, [load]);

  const back = (
    <Link
      to={tasksUrl(base)}
      className="mb-3 inline-flex items-center gap-1 rounded-sm text-xs text-fg-muted hover:text-accent focus-ring"
    >
      <ChevronRightIcon width={12} height={12} className="rotate-180" />
      All tasks
    </Link>
  );

  if (error) {
    return (
      <PaneScroll testId="task-detail">
        {back}
        {error.notFound ? (
          <EmptyState
            variant="panel"
            title="Task not found"
            body={`There is no task ${taskId} in this workspace. It may have been renamed or removed in Files.`}
            action={
              <Button variant="ghost" onClick={() => navigate(tasksUrl(base))}>
                Back to tasks
              </Button>
            }
          />
        ) : (
          <PaneError what="the task" message={error.message} onRetry={() => void load()} />
        )}
      </PaneScroll>
    );
  }
  if (!task) {
    return (
      <PaneScroll testId="task-detail">
        {back}
        <ListSkeleton rows={2} testId="task-loading" />
      </PaneScroll>
    );
  }

  const answer = task.answer;
  return (
    <PaneScroll testId="task-detail">
      {back}
      <div className="mb-5 flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h2 className="break-words text-xl font-semibold tracking-tight text-fg">{task.title}</h2>
          <div className="mt-2">
            <TaskChips
              task={task}
              base={base}
              objectiveTitle={task.objective ? objectiveTitle(task.objective) : undefined}
              showStatus
            />
          </div>
          <p className="mt-2 text-2xs text-fg-subtle">
            <span className="font-mono">{task.id}</span>
            {task.created && <> · created {relativeTime(task.created)}</>}
            {task.updated && <> · updated {relativeTime(task.updated)}</>}
          </p>
        </div>
        <TaskStatusMenu
          slug={slug}
          task={task}
          onChanged={(s: TaskStatus) => {
            setToast({ message: `Now ${TASK_STATUS_LABEL[s].toLowerCase()}.`, tone: "success" });
            void load();
          }}
          onError={(m) => setToast({ message: m, tone: "error" })}
        />
      </div>

      {task.status === "awaiting-ed" && (
        <Section title="The manager asks">
          <TaskAnswer
            slug={slug}
            task={task}
            wake={wake}
            onAnswered={(r, a) => {
              setToast({ message: answeredMessage(r, a, r.wake !== undefined), tone: "success" });
              void load();
            }}
          />
        </Section>
      )}

      {answer && task.status !== "awaiting-ed" && (
        <Section title="Your answer">
          {task.ask && <p className="text-sm text-fg-muted">{task.ask}</p>}
          <p className="mt-1 text-sm font-medium text-fg">{answer.choice ?? answer.text}</p>
          {answer.choice && answer.text && <p className="mt-1 text-sm text-fg">{answer.text}</p>}
          {answer.at && <p className="mt-1 text-2xs text-fg-subtle">Answered {relativeTime(answer.at)}</p>}
        </Section>
      )}

      <Section title="Notes">
        {task.notes.trim() ? (
          <Markdown>{task.notes}</Markdown>
        ) : (
          <EmptyState title="No notes" body="Notes are added by the manager, or by editing the task's file." />
        )}
      </Section>

      {task.dispatched.length > 0 && (
        <Section title="Dispatched" flush>
          <ul className="divide-y divide-edge-subtle">
            {task.dispatched.map((d, i) => (
              <li key={i} className="px-4 py-2.5 text-sm text-fg-muted">
                {d.connection ?? "?"} → {d.project ?? "?"}
                {d.chat && <span className="ml-2 font-mono text-2xs text-fg-subtle">{d.chat}</span>}
                {d.at && <span className="ml-2 text-2xs text-fg-subtle">{relativeTime(d.at)}</span>}
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section title="Log" variant="bare">
        {task.log.length ? (
          <Card className="font-mono text-2xs leading-relaxed text-fg-muted">
            <ul className="space-y-1">
              {task.log.map((l, i) => (
                <li key={i} className="break-words">
                  {l.replace(/^-\s*/, "")}
                </li>
              ))}
            </ul>
          </Card>
        ) : (
          <EmptyState title="No log lines yet" />
        )}
      </Section>

      <p className="text-2xs text-fg-subtle">
        File: <span className="font-mono break-all">{task.file}</span>
      </p>
      <Toast message={toast?.message ?? null} tone={toast?.tone} onDismiss={dismissToast} />
    </PaneScroll>
  );
}

