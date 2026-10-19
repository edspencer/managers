/**
 * TaskAnswer (Managers M11): Ed answers a task the manager is waiting on, in
 * place.
 *
 * It shows the manager's `ask`, then either one primary button per `options`
 * entry (a click IS the answer) or, when the ask is open-ended, a textarea with
 * an **Answer** button. When something can be woken, every answer also gets an
 * **Answer & wake** action that fires a trigger so the manager acts on it
 * straight away: the one whose run asked, else the workspace's `wake` — this
 * task's entry in `GET …/managers/wake`'s `tasks` map (or `?task=` when the map
 * predates the task), the same target the answer route fires. Its label names a
 * trigger other than `wake`. When nothing can be woken, or while that is still
 * being checked, the action is not shown at all.
 *
 * Self-contained on purpose: it takes the workspace key and the task, and
 * reports success upward. M13's cross-project "Needs you" list reuses it as is.
 */
import { useEffect, useId, useState } from "react";
import { api } from "../../lib/api";
import { notifyNeedsYouChanged } from "../../lib/needsYouCounts";
import type { TaskAnswerResult, TaskSummary, WakeAvailability } from "../../lib/types";
import { Button, Callout, Textarea, cx } from "../ui";
import { errorText } from "./shared";

export interface TaskAnswerProps {
  /** Workspace key (`""` = Home). */
  slug: string;
  task: Pick<TaskSummary, "id" | "title" | "ask" | "options">;
  /**
   * The workspace's `GET …/managers/wake`; this task's own entry is read from its
   * `tasks` map. `null` while unknown: Answer & wake stays hidden until known.
   */
  wake: WakeAvailability | null;
  /** Called with the server's result and a short label for what was answered. */
  onAnswered: (result: TaskAnswerResult, answer: string) => void;
  className?: string;
}

export function TaskAnswer({ slug, task, wake, onAnswered, className }: TaskAnswerProps) {
  const [text, setText] = useState("");
  // The action being sent (an option, or "text"; `+wake` for Answer & wake), so
  // only that button spins.
  const [sending, setSending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const textId = useId();
  const hasOptions = task.options.length > 0;
  // This task's target: its entry in the map; a task the map predates asks for
  // itself; a response without a map (an older server) is the workspace's answer.
  const listed = wake?.tasks?.[task.id] ?? null;
  const needOwn = wake !== null && wake.tasks !== undefined && listed === null;
  const [own, setOwn] = useState<WakeAvailability | null>(null);
  useEffect(() => {
    if (!needOwn) return;
    let live = true;
    api
      .managersWake(slug, task.id)
      .then((w) => live && setOwn(w))
      .catch(() => live && setOwn({ available: false, reason: "couldn't check the wake trigger" }));
    return () => {
      live = false;
    };
  }, [needOwn, slug, task.id]);
  const target = wake === null ? null : (listed ?? (needOwn ? own : wake));
  const canWake = target?.available === true;
  // Name the trigger when it is not the obvious one.
  const wakeTrigger = canWake && target?.trigger && target.trigger !== "wake" ? target.trigger : null;
  const wakeSuffix = wakeTrigger ? ` (${wakeTrigger})` : "";

  const send = async (input: { choice?: string; text?: string }, key: string, wakeNow: boolean) => {
    if (sending) return;
    const sendKey = wakeNow ? `${key}+wake` : key;
    setSending(sendKey);
    setError(null);
    try {
      const result = await api.managersAnswerTask(slug, task.id, { ...input, ...(wakeNow ? { wake: true } : {}) });
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
  const busy = (key: string) => sending !== null && sending !== key;

  return (
    <div className={cx("space-y-3", className)} data-testid={`task-answer-${task.id}`}>
      {task.ask && <p className="whitespace-pre-wrap text-sm text-fg">{task.ask}</p>}

      {hasOptions ? (
        <div className="space-y-1.5">
          <div className="flex flex-wrap gap-2" role="group" aria-label="Answer options">
            {task.options.map((o) =>
              canWake ? (
                // A split button: the option answers, its "& wake" half answers
                // and wakes. Two real buttons, so each is its own tab stop.
                <span key={o} className="inline-flex max-w-full" data-testid="answer-option">
                  <Button
                    size="sm"
                    variant="primary"
                    loading={sending === o}
                    loadingLabel="Sending…"
                    disabled={busy(o)}
                    onClick={() => void send({ choice: o }, o, false)}
                    className="min-w-0 rounded-r-none"
                  >
                    <span className="truncate">{o}</span>
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`${o} & wake${wakeSuffix}`}
                    title={`Answer “${o}” and wake the manager${wakeTrigger ? ` (runs ${wakeTrigger})` : ""}`}
                    loading={sending === `${o}+wake`}
                    loadingLabel="Waking…"
                    disabled={busy(`${o}+wake`)}
                    onClick={() => void send({ choice: o }, o, true)}
                    className="shrink-0 rounded-l-none border-l border-accent-solid"
                  >
                    &amp; wake
                  </Button>
                </span>
              ) : (
                <Button
                  key={o}
                  size="sm"
                  variant="primary"
                  loading={sending === o}
                  loadingLabel="Sending…"
                  disabled={busy(o)}
                  onClick={() => void send({ choice: o }, o, false)}
                  className="max-w-full"
                  data-testid="answer-option"
                >
                  <span className="truncate">{o}</span>
                </Button>
              ),
            )}
          </div>
          {canWake && (
            <p className="text-2xs text-fg-subtle" data-testid="wake-hint">
              “&amp; wake” also wakes the manager now{wakeTrigger ? ` (runs ${wakeTrigger})` : ""}.
            </p>
          )}
        </div>
      ) : (
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim()) void send({ text: text.trim() }, "text", false);
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
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="submit"
              size="sm"
              variant="primary"
              disabled={!text.trim() || busy("text")}
              loading={sending === "text"}
              loadingLabel="Sending…"
            >
              Answer
            </Button>
            {canWake && (
              <Button
                size="sm"
                variant="ghost"
                disabled={!text.trim() || busy("text+wake")}
                loading={sending === "text+wake"}
                loadingLabel="Waking…"
                onClick={() => {
                  if (text.trim()) void send({ text: text.trim() }, "text", true);
                }}
              >
                Answer &amp; wake{wakeSuffix}
              </Button>
            )}
          </div>
        </form>
      )}

      {error && (
        <Callout tone="danger">
          <span data-testid="task-answer-error">{error}</span>
        </Callout>
      )}
    </div>
  );
}
