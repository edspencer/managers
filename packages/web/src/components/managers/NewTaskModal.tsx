/**
 * NewTaskModal (Managers M11): Ed adds a task to the workspace's list.
 *
 * Ed's tasks are `source: ed`. The status is limited to the ones Ed would
 * start a task in — Open, Doing or Blocked. "Awaiting you" is the manager's
 * way of asking Ed something, so Ed can't create one here.
 */
import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import type { ObjectiveSummary, TaskDetail, TaskStatus } from "../../lib/types";
import { Button, Callout, Dialog, Field, Input, Select, Textarea } from "../ui";
import { TASK_STATUS_LABEL, errorText } from "./shared";

const START_STATUSES: TaskStatus[] = ["open", "doing", "blocked"];

export function NewTaskModal({
  slug,
  open,
  objectives,
  defaultObjective,
  onClose,
  onCreated,
}: {
  slug: string;
  open: boolean;
  /** The objectives the task may be linked to. */
  objectives: Pick<ObjectiveSummary, "id" | "title">[];
  /** Pre-selected objective (opening from an objective's page). */
  defaultObjective?: string | null;
  onClose: () => void;
  onCreated: (task: TaskDetail) => void;
}) {
  const [title, setTitle] = useState("");
  const [objective, setObjective] = useState("");
  const [status, setStatus] = useState<TaskStatus>("open");
  const [due, setDue] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setTitle("");
    setObjective(defaultObjective ?? "");
    setStatus("open");
    setDue("");
    setNotes("");
    setError(null);
  }, [open, defaultObjective]);

  const ready = title.trim() !== "";

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ready || saving) return;
    setSaving(true);
    setError(null);
    try {
      const task = await api.managersCreateTask(slug, {
        title: title.trim(),
        status,
        source: "ed",
        ...(objective ? { objective } : {}),
        ...(due ? { due } : {}),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
      });
      onCreated(task);
    } catch (err) {
      setError(errorText(err, "The task was not created"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="New task"
      dismissOnBackdrop={!saving}
      onSubmit={(e) => void submit(e)}
      footer={
        <>
          <Button variant="subtle" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!ready} loading={saving} loadingLabel="Adding…">
            Add task
          </Button>
        </>
      }
    >
      <div className="space-y-4 pt-3">
        <Field label="Title">
          {(p) => (
            <Input
              {...p}
              autoFocus
              value={title}
              maxLength={200}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="What needs doing?"
            />
          )}
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Objective">
            {(p) => (
              <Select {...p} value={objective} onChange={(e) => setObjective(e.target.value)}>
                <option value="">None</option>
                {objectives.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.title}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Status">
            {(p) => (
              <Select {...p} value={status} onChange={(e) => setStatus(e.target.value as TaskStatus)}>
                {START_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {TASK_STATUS_LABEL[s]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
        <Field label="Due" hint="Optional.">
          {(p) => <Input {...p} type="date" value={due} onChange={(e) => setDue(e.target.value)} />}
        </Field>
        <Field label="Notes" hint="Optional. Markdown.">
          {(p) => <Textarea {...p} rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />}
        </Field>
        {error && (
          <Callout tone="danger">
            <span data-testid="new-task-error">{error}</span>
          </Callout>
        )}
      </div>
    </Dialog>
  );
}
