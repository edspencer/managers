/**
 * ManagersOverview (Managers M12): the manager's part of a project's Home tab,
 * above the Running/Unread feeds and the notes cards — the status report (with
 * live Needs you and Alerts), the objectives in play, and the last ten runs.
 *
 * It owns the one run drawer, so a run row, an alert's "View run" and a failed
 * refresh all open the same thing, and it reloads the runs list when a refresh
 * run finishes.
 */
import { useState } from "react";
import { Link } from "react-router-dom";
import { objectivesUrl } from "../../routes/ProjectView/urls";
import { ObjectivesSummary } from "./ObjectivesSummary";
import { RunDrawer } from "./RunDrawer";
import { RunsList } from "./RunsList";
import { StatusReportCard } from "./StatusReportCard";

function Heading({ label, link }: { label: string; link?: { to: string; text: string } }) {
  return (
    <div className="mb-2 flex items-center justify-between gap-2">
      <h3 className="text-sm font-semibold uppercase tracking-wide text-fg-muted">{label}</h3>
      {link && (
        <Link to={link.to} className="text-xs text-fg-muted underline-offset-2 can-hover:hover:text-fg can-hover:hover:underline">
          {link.text}
        </Link>
      )}
    </div>
  );
}

export function ManagersOverview({ slug, base }: { slug: string; base: string }) {
  const [runId, setRunId] = useState<string | null>(null);
  const [runsKey, setRunsKey] = useState(0);
  return (
    <div data-testid="managers-overview">
      <StatusReportCard
        slug={slug}
        base={base}
        onOpenRun={setRunId}
        onRunFinished={() => setRunsKey((k) => k + 1)}
      />
      <div className="mb-8 grid items-start gap-6 xl:grid-cols-2">
        <section>
          <Heading label="Objectives" link={{ to: objectivesUrl(base), text: "All objectives" }} />
          <ObjectivesSummary slug={slug} base={base} />
        </section>
        <section>
          <Heading label="Runs" />
          <RunsList slug={slug} base={base} onOpenRun={setRunId} reloadKey={runsKey} />
        </section>
      </div>
      <RunDrawer slug={slug} base={base} runId={runId} onClose={() => setRunId(null)} />
    </div>
  );
}
