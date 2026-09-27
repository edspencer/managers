/**
 * TaskAnswer (Managers M11): Ed answers a task the manager is waiting on, in
 * place.
 *
 * It shows the manager's `ask`, then either one button per `options` entry (a
 * click IS the answer) or, when the ask is open-ended, a textarea. The "Wake the
 * manager now" switch also fires the workspace's `wake` trigger so the manager
 * acts on the answer straight away; it is disabled, with the reason, when no
 * enabled and permitted `wake` exists (`GET …/managers/wake`).
 *
 * Self-contained on purpose: it takes the workspace key and the task, and
 * reports success upward. M13's cross-project "Needs you" list reuses it as is.
 */
import { useId, useState } from "react";
import { api } from "../../lib/api";
import { notifyNeedsYouChanged } from "../../lib/needsYouCounts";
import type { TaskAnswerResult, TaskSummary, WakeAvailability } from "../../lib/types";
import { Button, Callout, Textarea, Toggle, cx } from "../ui";
import { Tooltip } from "../Tooltip";
import { errorText } from "./shared";

export interface TaskAnswerProps {
  /** Workspace key (`""` = Home). */
  slug: string;
  task: Pick<TaskSummary, "id" | "title" | "ask" | "options">;
  /** `null` while unknown: the switch stays off and disabled until it is known. */
  wake: WakeAvailability | null;
  /** Called with the server's result and a short label for what was answered. */
  onAnswered: (result: TaskAnswerResult, answer: string) => void;
  className?: string;
}

export function TaskAnswer({ slug, task, wake, onAnswered, className }: TaskAnswerProps) {
  const [text, setText] = useState("");
  const [wakeNow, setWakeNow] = useState(false);
  // The option being sent (or "text"), so only that button spins.
  const [sending, setSending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const textId = useId();
  const wakeId = useId();
  const hasOptions = task.options.length > 0;
  const canWake = wake?.available === true;
  const wakeReason = wake === null ? "Checking whether the manager can be woken…" : wake.reason;

  const send = async (input: { choice?: string; text?: string }, key: string) => {
    if (sending) return;
    setSending(key);
    setError(null);
    try {
      const result = await api.managersAnswerTask(slug, task.id, {
        ...input,
        ...(wakeNow && canWake ? { wake: true } : {}),
      });
      setText("");
      // The shell's sidebar pills and fleet strip re-read their counts.
      notifyNeedsYouChanged();
      onAnswered(result, input.choice ?? input.text ?? "");
    } catch (e) {
      setError(errorText(e, "The answer was not saved"));
    } finally {
      setSending(null);
    }
  };

  // M15: the visible text is a <label> for the switch too, so clicking the words
  // toggles it (before, only the 32px switch did and a click on the text was lost).
  const toggle = (
    <span className="inline-flex items-center gap-2">
      <Toggle
        id={wakeId}
        checked={wakeNow && canWake}
        onChange={setWakeNow}
        disabled={!canWake || sending !== null}
        label="Wake the manager now"
      />
      <label
        htmlFor={wakeId}
        className={cx("text-xs", canWake ? "cursor-pointer text-fg-muted" : "text-fg-subtle")}
      >
        Wake the manager now
      </label>
    </span>
  );

  return (
    <div className={cx("space-y-3", className)} data-testid={`task-answer-${task.id}`}>
      {task.ask && <p className="whitespace-pre-wrap text-sm text-fg">{task.ask}</p>}

      {hasOptions ? (
        <div className="flex flex-wrap gap-2" role="group" aria-label="Answer options">
          {task.options.map((o) => (
            <Button
              key={o}
              size="sm"
              variant="ghost"
              loading={sending === o}
              loadingLabel="Sending…"
              disabled={sending !== null && sending !== o}
              onClick={() => void send({ choice: o }, o)}
              className="max-w-full"
            >
              <span className="truncate">{o}</span>
            </Button>
          ))}
        </div>
      ) : (
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim()) void send({ text: text.trim() }, "text");
          }}
        >
          <label htmlFor={textId} className="sr-only">
            Your answer
          </label>
          <Textarea
            id={textId}
            rows={2}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Your answer…"
            disabled={sending !== null}
          />
          <Button
            type="submit"
            size="sm"
            variant="primary"
            disabled={!text.trim()}
            loading={sending === "text"}
            loadingLabel="Sending…"
          >
            Send answer
          </Button>
        </form>
      )}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {canWake || !wakeReason ? (
          toggle
        ) : (
          <Tooltip content={`Can't wake the manager: ${wakeReason}.`}>{toggle}</Tooltip>
        )}
        {!canWake && wakeReason && (
          // Also in plain text: a tooltip is unreachable on touch.
          <span className="text-2xs text-fg-subtle" data-testid="wake-reason">
            ({wakeReason})
          </span>
        )}
      </div>

      {error && (
        <Callout tone="danger">
          <span data-testid="task-answer-error">{error}</span>
        </Callout>
      )}
    </div>
  );
}
