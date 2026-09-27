/**
 * ObjectivesSummary (Managers M12): the compact objectives list on a project's
 * Home — one line per objective that is still in play (active or paused), with
 * its status and open-task count, linking to its page. Finished and retired
 * objectives are left to the Objectives tab; the header link goes there.
 */
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../lib/api";
import type { ObjectiveSummary } from "../../lib/types";
import { objectivesUrl } from "../../routes/ProjectView/urls";
import { EmptyState, StatusDot, cx } from "../ui";
import { OBJECTIVE_STATUS_LABEL, OBJECTIVE_STATUS_TONE, PaneError, errorText } from "./shared";

export function ObjectivesSummary({ slug, base }: { slug: string; base: string }) {
  const [objectives, setObjectives] = useState<ObjectiveSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setObjectives((await api.managersObjectives(slug)).objectives);
    } catch (e) {
      setError(errorText(e, "unknown error"));
    }
  }, [slug]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <PaneError what="objectives" message={error} onRetry={() => void load()} />;
  if (objectives === null) {
    return <div className="h-16 animate-pulse rounded-2xl border border-edge bg-surface-raised" aria-busy="true" aria-label="Loading objectives" />;
  }
  const live = objectives.filter((o) => o.status === "active" || o.status === "paused");
  const closed = objectives.length - live.length;
  if (live.length === 0) {
    return (
      <EmptyState
        title={objectives.length === 0 ? "No objectives yet" : "No objectives in play"}
        body={
          objectives.length === 0
            ? "An objective is a long-running goal the manager works toward on its schedule."
            : `${closed} finished or retired.`
        }
        action={
          <Link to={objectivesUrl(base)} className="text-sm text-accent underline-offset-2 hover:underline">
            {objectives.length === 0 ? "Create one in Objectives" : "Open Objectives"}
          </Link>
        }
      />
    );
  }
  return (
    <div className="overflow-hidden rounded-2xl border border-edge bg-surface-raised" data-testid="objectives-summary">
      {live.map((o, i) => {
        const open = o.openTasks ?? 0;
        return (
          <Link
            key={o.id}
            to={objectivesUrl(base, o.id)}
            className={cx(
              "flex items-center gap-2.5 px-3 py-2.5 transition-colors can-hover:hover:bg-surface-hover focus-visible:focus-ring",
              i > 0 && "border-t border-edge-subtle",
            )}
          >
            <StatusDot tone={OBJECTIVE_STATUS_TONE[o.status]} />
            {o.status !== "paused" && <span className="sr-only">{OBJECTIVE_STATUS_LABEL[o.status]}</span>}
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg">{o.title}</span>
            {o.status === "paused" && <span className="shrink-0 text-2xs text-warn">Paused</span>}
            <span className="shrink-0 text-2xs tabular text-fg-subtle">
              {open === 0 ? "no open tasks" : `${open} open`}
            </span>
          </Link>
        );
      })}
      {closed > 0 && (
        <Link
          to={objectivesUrl(base)}
          className="block border-t border-edge-subtle px-3 py-2 text-2xs text-fg-subtle transition-colors can-hover:hover:bg-surface-hover can-hover:hover:text-fg focus-visible:focus-ring"
        >
          {closed} finished or retired
        </Link>
      )}
    </div>
  );
}
