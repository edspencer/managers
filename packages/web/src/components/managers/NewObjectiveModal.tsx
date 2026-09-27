/**
 * NewObjectiveModal (Managers M11): Ed states a new long-running objective.
 *
 * Two fields are required — the title and the success statement (what "done"
 * looks like) — because an objective without a success statement is a wish the
 * manager cannot measure progress against. The id (its directory name) is
 * derived from the title and editable; the server refuses one that exists.
 * The rest of the objective ("Where we are", Strategy) is the manager's to
 * write as it works.
 */
import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import type { ObjectiveDetail } from "../../lib/types";
import { Button, Callout, Dialog, Field, Input, Textarea } from "../ui";
import { errorText } from "./shared";

/** "Grow awareness of Widget!" → "grow-awareness-of-widget" (the server's NAME_RE, ≤80). */
export function objectiveIdFrom(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/, "");
}

const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function NewObjectiveModal({
  slug,
  open,
  onClose,
  onCreated,
}: {
  slug: string;
  open: boolean;
  onClose: () => void;
  onCreated: (objective: ObjectiveDetail) => void;
}) {
  const [title, setTitle] = useState("");
  const [success, setSuccess] = useState("");
  const [id, setId] = useState("");
  // Once Ed edits the id by hand, the title stops overwriting it.
  const [idTouched, setIdTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setTitle("");
    setSuccess("");
    setId("");
    setIdTouched(false);
    setError(null);
  }, [open]);

  const effectiveId = idTouched ? id : objectiveIdFrom(title);
  const idValid = ID_RE.test(effectiveId) && effectiveId.length <= 80;
  const ready = title.trim() !== "" && success.trim() !== "" && idValid;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ready || saving) return;
    setSaving(true);
    setError(null);
    try {
      const objective = await api.managersCreateObjective(slug, {
        id: effectiveId,
        title: title.trim(),
        success: success.trim(),
      });
      onCreated(objective);
    } catch (err) {
      setError(errorText(err, "The objective was not created"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="New objective"
      description="A long-running goal the manager works toward and reports on."
      dismissOnBackdrop={!saving}
      onSubmit={(e) => void submit(e)}
      footer={
        <>
          <Button variant="subtle" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!ready} loading={saving} loadingLabel="Creating…">
            Create objective
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
              placeholder="Publish one blog post a week"
            />
          )}
        </Field>
        <Field label="Success looks like" hint="How you and the manager will know it's done.">
          {(p) => (
            <Textarea
              {...p}
              rows={3}
              value={success}
              maxLength={2000}
              onChange={(e) => setSuccess(e.target.value)}
              placeholder="Eight posts published in eight consecutive weeks."
            />
          )}
        </Field>
        <Field
          label="Id"
          hint="Lower-case words joined by hyphens. It names the objective's folder and can't be changed later."
          error={effectiveId !== "" && !idValid ? "Use lower-case letters, digits and single hyphens." : undefined}
        >
          {(p) => (
            <Input
              {...p}
              value={effectiveId}
              onChange={(e) => {
                setIdTouched(true);
                setId(e.target.value);
              }}
              className="font-mono"
              placeholder="blog-cadence"
            />
          )}
        </Field>
        {error && (
          <Callout tone="danger">
            <span data-testid="new-objective-error">{error}</span>
          </Callout>
        )}
      </div>
    </Dialog>
  );
}
