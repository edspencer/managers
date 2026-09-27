/**
 * AlertsList (Managers M12): the workspace's dead-man's-switch alerts, as the
 * server computes them right now (`GET …/managers/alerts`, errors first).
 *
 * Each row is the severity, the message, and the trigger it concerns. An alert
 * that names a run offers "View run", which opens the run drawer — that is
 * where the error and "what the manager saw" live.
 *
 * Presentational: the caller fetches, so Home's status card can load alerts
 * beside its report and still render them when the report itself will not load.
 */
import type { ManagersAlert } from "../../lib/types";
import { Button, Chip } from "../ui";
import { ALERT_SEVERITY_TONE } from "./shared";

const SEVERITY_LABEL: Record<ManagersAlert["severity"], string> = {
  error: "Error",
  warning: "Warning",
  info: "Info",
};

export function AlertsList({
  alerts,
  onOpenRun,
  empty = "No alerts. Every trigger is producing what it should.",
}: {
  alerts: ManagersAlert[];
  onOpenRun?: (runId: string) => void;
  empty?: string;
}) {
  if (alerts.length === 0) {
    return (
      <p className="text-sm text-fg-subtle" data-testid="alerts-empty">
        {empty}
      </p>
    );
  }
  return (
    <ul className="space-y-2" data-testid="alerts-list">
      {alerts.map((a) => (
        <li key={a.id} className="flex items-start gap-2" data-testid={`alert-${a.id}`}>
          <Chip tone={ALERT_SEVERITY_TONE[a.severity]} shape="pill" dot className="mt-0.5 shrink-0">
            {SEVERITY_LABEL[a.severity]}
          </Chip>
          <div className="min-w-0 flex-1">
            <p className="break-words text-sm text-fg">{a.message}</p>
            <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-2xs text-fg-subtle">
              <span className="font-mono">{a.id}</span>
              {a.runId && onOpenRun && (
                <Button variant="link" size="sm" onClick={() => onOpenRun(a.runId!)}>
                  View run
                </Button>
              )}
            </p>
          </div>
        </li>
      ))}
    </ul>
  );
}
