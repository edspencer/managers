/**
 * ObjectivesPane (Managers M11): the workspace's objectives — the Objectives
 * tab.
 *
 * One card per objective: the title, its status, the start of "Where we are"
 * (the manager's rolling summary), when it last changed and how many tasks
 * are open against it. Active objectives come first (the server sorts). A
 * card opens the objective's page, `…/objectives/:id`, which renders
 * {@link ObjectiveDetailView} instead of the list.
 */
import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../../lib/api";
import { relativeTime } from "../../lib/format";
import type { ManagersParseError, ObjectiveSummary } from "../../lib/types";
import { objectivesUrl } from "../../routes/ProjectView/urls";
import { Button, Callout, Card, Chip, EmptyState } from "../ui";
import { PinIcon, PlusIcon } from "../icons";
import { NewObjectiveModal } from "./NewObjectiveModal";
import { ObjectiveDetailView } from "./ObjectiveDetail";
import {
  ListSkeleton,
  OBJECTIVE_STATUS_LABEL,
  OBJECTIVE_STATUS_TONE,
  PaneError,
  PaneScroll,
  errorText,
} from "./shared";

function ObjectiveCard({ base, o }: { base: string; o: ObjectiveSummary }) {
  const open = o.openTasks ?? 0;
  return (
    <Link
      to={objectivesUrl(base, o.id)}
      className="block rounded-2xl focus-visible:focus-ring"
      data-testid={`objective-card-${o.id}`}
    >
      <Card interactive className="flex h-full flex-col">
        <div className="flex items-start gap-2">
          <h3 className="min-w-0 flex-1 break-words text-sm font-semibold text-fg">{o.title}</h3>
          <Chip tone={OBJECTIVE_STATUS_TONE[o.status]} shape="pill" dot className="shrink-0">
            {OBJECTIVE_STATUS_LABEL[o.status]}
          </Chip>
        </div>
        {o.excerpt ? (
          <p className="mt-2 line-clamp-3 text-sm text-fg-muted">{o.excerpt}</p>
        ) : (
          <p className="mt-2 text-sm text-fg-subtle">No progress summary yet.</p>
        )}
        <p className="mt-auto flex flex-wrap gap-x-2 pt-3 text-2xs text-fg-subtle">
          {o.updated && <span>Updated {relativeTime(o.updated)}</span>}
          <span aria-hidden>·</span>
          <span className={open > 0 ? "text-fg-muted" : undefined}>
            {open === 0 ? "No open tasks" : `${open} open task${open === 1 ? "" : "s"}`}
          </span>
        </p>
      </Card>
    </Link>
  );
}

export function ObjectivesPane({
  slug,
  base,
  objectiveId,
}: {
  /** Workspace key (`""` = Home). */
  slug: string;
  base: string;
  /** `…/objectives/:id`: render that objective's page instead of the list. */
  objectiveId?: string;
}) {
  const [objectives, setObjectives] = useState<ObjectiveSummary[] | null>(null);
  const [parseErrors, setParseErrors] = useState<ManagersParseError[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const navigate = useNavigate();

  const load = useCallback(async () => {
    setError(null);
    try {
      const r = await api.managersObjectives(slug);
      setObjectives(r.objectives);
      setParseErrors(r.parseErrors ?? []);
    } catch (e) {
      setError(errorText(e, "unknown error"));
    }
  }, [slug]);

  useEffect(() => {
    if (objectiveId) return;
    setObjectives(null);
    void load();
  }, [load, objectiveId]);

  if (objectiveId) return <ObjectiveDetailView slug={slug} base={base} objectiveId={objectiveId} />;

  const newButton = (
    <Button variant="primary" size="sm" icon={<PlusIcon width={13} height={13} />} onClick={() => setNewOpen(true)}>
      New objective
    </Button>
  );

  return (
    <PaneScroll testId="objectives-pane">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <h2 className="mr-auto text-lg font-semibold tracking-tight text-fg">Objectives</h2>
        {objectives !== null && objectives.length > 0 && newButton}
      </div>

      {error ? (
        <PaneError what="objectives" message={error} onRetry={() => void load()} />
      ) : objectives === null ? (
        <ListSkeleton rows={3} testId="objectives-loading" />
      ) : (
        <>
          {parseErrors.length > 0 && (
            <Callout tone="warn" className="mb-4">
              <p>
                {parseErrors.length === 1 ? "One objective" : `${parseErrors.length} objectives`} could not be
                read and {parseErrors.length === 1 ? "is" : "are"} not listed:
              </p>
              <ul className="mt-1 list-disc pl-5 text-xs">
                {parseErrors.map((p) => (
                  <li key={p.file}>
                    <span className="font-mono">{p.file}</span>: {p.error}
                  </li>
                ))}
              </ul>
            </Callout>
          )}
          {objectives.length === 0 ? (
            <EmptyState
              variant="panel"
              icon={<PinIcon width={24} height={24} />}
              title="No objectives yet"
              body="An objective is a long-running goal. The manager works toward it on its schedule and keeps a journal of what it did."
              action={
                <Button variant="primary" icon={<PlusIcon width={13} height={13} />} onClick={() => setNewOpen(true)}>
                  New objective
                </Button>
              }
            />
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              {objectives.map((o) => (
                <ObjectiveCard key={o.id} base={base} o={o} />
              ))}
            </div>
          )}
        </>
      )}

      <NewObjectiveModal
        slug={slug}
        open={newOpen}
        onClose={() => setNewOpen(false)}
        onCreated={(o) => {
          setNewOpen(false);
          navigate(objectivesUrl(base, o.id));
        }}
      />
    </PaneScroll>
  );
}
