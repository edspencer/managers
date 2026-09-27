/**
 * One task as a list row (Managers M11), plus the status menu it carries.
 *
 * A row is the task's title (a link to its page), its chips — objective, due
 * date, GitHub refs, "ready to start" — and one line of metadata. A task the
 * manager is waiting on also renders {@link TaskAnswer} inline, so Ed answers
 * from the list without opening anything.
 */
import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../lib/api";
import { relativeTime } from "../../lib/format";
import type { TaskAnswerResult, TaskStatus, TaskSummary, WakeAvailability } from "../../lib/types";
import { objectivesUrl, tasksUrl } from "../../routes/ProjectView/urls";
import { Button, Chip, Menu, MenuItem, cx } from "../ui";
import { MoreIcon } from "../icons";
import { TaskAnswer } from "./TaskAnswer";
import { TASK_STATUS_LABEL, TASK_STATUS_TONE, errorText } from "./shared";

/** The statuses Ed can move a task to by hand. `awaiting-ed` is the manager's to set. */
const MOVE_TARGETS: { status: TaskStatus; label: string }[] = [
  { status: "open", label: "Mark open" },
  { status: "doing", label: "Mark doing" },
  { status: "blocked", label: "Mark blocked" },
  { status: "done", label: "Mark done" },
  { status: "dropped", label: "Drop" },
];

export function TaskStatusMenu({
  slug,
  task,
  onChanged,
  onError,
}: {
  slug: string;
  task: Pick<TaskSummary, "id" | "title" | "status">;
  onChanged: (status: TaskStatus) => void;
  onError: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const move = async (status: TaskStatus) => {
    setOpen(false);
    setBusy(true);
    try {
      await api.managersUpdateTask(slug, task.id, { status });
      onChanged(status);
    } catch (e) {
      onError(errorText(e, "The task was not updated"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="relative shrink-0">
      <Button
        size="icon-sm"
        variant="subtle"
        aria-label={`Change status of ${task.title}`}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={busy}
        onClick={() => setOpen((v) => !v)}
      >
        <MoreIcon width={14} height={14} />
      </Button>
      <Menu open={open} onClose={() => setOpen(false)} label="Change status" position="top-7">
        {MOVE_TARGETS.filter((m) => m.status !== task.status).map((m) => (
          <MenuItem key={m.status} onClick={() => void move(m.status)} danger={m.status === "dropped"}>
            {m.label}
          </MenuItem>
        ))}
      </Menu>
    </div>
  );
}

export function TaskChips({
  task,
  base,
  objectiveTitle,
  showStatus,
}: {
  task: TaskSummary;
  base: string;
  objectiveTitle?: string;
  showStatus?: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      {showStatus && (
        <Chip tone={TASK_STATUS_TONE[task.status]} shape="pill" dot>
          {TASK_STATUS_LABEL[task.status]}
        </Chip>
      )}
      {task.objective && (
        <Link
          to={objectivesUrl(base, task.objective)}
          className="min-w-0 max-w-full rounded-md focus-ring"
          title={`Objective: ${objectiveTitle ?? task.objective}`}
        >
          <Chip tone="lineage" className="max-w-full">
            <span className="truncate">{objectiveTitle ?? task.objective}</span>
          </Chip>
        </Link>
      )}
      {task.due && (
        <Chip tone="neutral" title={`Due ${task.due}`}>
          due {task.due.slice(0, 10)}
        </Chip>
      )}
      {task.shovel_ready && (
        <Chip tone="success" title="Ready to start: nothing is blocking it">
          ready
        </Chip>
      )}
      {task.github.map((g) => (
        <Chip key={g} tone="neutral" className="font-mono">
          {g}
        </Chip>
      ))}
    </div>
  );
}

export function TaskRow({
  slug,
  base,
  task,
  objectiveTitle,
  wake,
  highlighted,
  showStatus,
  onAnswered,
  onStatusChanged,
  onError,
}: {
  slug: string;
  base: string;
  task: TaskSummary;
  objectiveTitle?: string;
  wake: WakeAvailability | null;
  highlighted?: boolean;
  /** Show the status chip (the row is not already under its status heading). */
  showStatus?: boolean;
  onAnswered: (task: TaskSummary, result: TaskAnswerResult, answer: string) => void;
  onStatusChanged: (task: TaskSummary, status: TaskStatus) => void;
  onError: (message: string) => void;
}) {
  const closed = task.status === "done" || task.status === "dropped";
  const answer = task.answer?.choice ?? task.answer?.text ?? null;
  return (
    <li
      id={task.id}
      data-testid={`task-row-${task.id}`}
      className={cx(
        "scroll-mt-24 px-4 py-3 motion-base transition-colors",
        highlighted && "bg-accent-soft",
      )}
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <Link
            to={tasksUrl(base, task.id)}
            className={cx(
              "block break-words text-sm font-medium hover:text-accent focus-ring rounded-sm",
              closed ? "text-fg-muted" : "text-fg",
              task.status === "dropped" && "line-through",
            )}
          >
            {task.title}
          </Link>
          <div className="mt-1.5">
            <TaskChips task={task} base={base} objectiveTitle={objectiveTitle} showStatus={showStatus} />
          </div>
          <p className="mt-1.5 text-2xs text-fg-subtle">
            {task.source === "ed" ? "Added by you" : task.source === "harvested" ? "Proposed by the manager" : "From the manager"}
            {task.updated && <> · updated {relativeTime(task.updated)}</>}
            {answer && task.status !== "awaiting-ed" && (
              <>
                {" "}
                · you answered <span className="text-fg-muted">&ldquo;{answer}&rdquo;</span>
              </>
            )}
          </p>
        </div>
        <TaskStatusMenu
          slug={slug}
          task={task}
          onChanged={(s) => onStatusChanged(task, s)}
          onError={onError}
        />
      </div>
      {task.status === "awaiting-ed" && (
        <TaskAnswer
          slug={slug}
          task={task}
          wake={wake}
          className="mt-3 rounded-xl border border-warn-edge bg-surface-sunken p-3"
          onAnswered={(r, a) => onAnswered(task, r, a)}
        />
      )}
    </li>
  );
}
