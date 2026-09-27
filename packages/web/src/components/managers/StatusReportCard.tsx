/**
 * StatusReportCard (Managers M12): the top of a project's Home — "what are you
 * up to, and what do you need from me".
 *
 * It shows the manager's current `status` report (`reports/status/current.md`,
 * M10), but NOT the report's own "Needs you" and "Alerts" sections. Those were
 * rendered by the server when the report was written, so a report from this
 * morning still lists a task Ed answered an hour ago. The card renders both
 * LIVE instead, from `…/tasks?status=awaiting-ed` and `…/alerts`, and shows
 * only the rest of the stored text (see `reportBody`). A day-old report can
 * therefore never hide a new request or show a stale one.
 *
 * The three reads are independent: if the report will not load, Needs you and
 * Alerts still render and the report slot shows the error with Retry.
 *
 * "Refresh now" fires the report's derived trigger (M10's refresh route, which
 * runs even while the schedule is off) and polls the run until it finishes,
 * with a spinner; then it re-reads everything. A failed run, a run that wrote
 * no report, and a refused refresh (a behaviour is off) each say so in place.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ApiError, api } from "../../lib/api";
import { relativeTime } from "../../lib/format";
import type { ManagersAlert, ReportDoc, TaskSummary } from "../../lib/types";
import { reportsUrl, tasksUrl } from "../../routes/ProjectView/urls";
import { Markdown } from "../Markdown";
import { Button, Callout, Card, Chip, EmptyState, StatusDot } from "../ui";
import { AlertIcon, ClockIcon } from "../icons";
import { AlertsList } from "./AlertsList";
import { isReportStale, reportBody, reportGenerated } from "./reportMarkdown";
import { PaneError, Spinner, errorText, useInternalLinks } from "./shared";

const TYPE = "status";
/** How often the card polls a refresh run, and for how long at most. */
export const REFRESH_POLL_MS = 1500;
const REFRESH_GIVE_UP_MS = 10 * 60 * 1000;

type Refresh =
  | { phase: "idle" }
  | { phase: "starting" }
  | { phase: "running"; runId: string | null }
  | { phase: "done" }
  | { phase: "failed"; runId: string | null; message: string }
  | { phase: "no-report"; runId: string | null }
  | { phase: "refused"; message: string };

function SubHeading({ label, count }: { label: string; count?: number }) {
  return (
    <h4 className="mb-2 text-2xs font-semibold uppercase tracking-wide text-fg-muted">
      {label}
      {count !== undefined && count > 0 && <span className="ml-1.5 text-fg-subtle">{count}</span>}
    </h4>
  );
}

export function StatusReportCard({
  slug,
  base,
  onOpenRun,
  onRunFinished,
  pollMs = REFRESH_POLL_MS,
}: {
  /** How often to poll a refresh run (tests shorten it). */
  pollMs?: number;
  slug: string;
  base: string;
  onOpenRun: (runId: string) => void;
  /** Called when a refresh run ends, so siblings (the runs list) can reload. */
  onRunFinished?: () => void;
}) {
  const [report, setReport] = useState<ReportDoc | null | undefined>(undefined);
  const [reportError, setReportError] = useState<string | null>(null);
  const [needs, setNeeds] = useState<TaskSummary[] | null>(null);
  const [needsError, setNeedsError] = useState<string | null>(null);
  const [alerts, setAlerts] = useState<ManagersAlert[] | null>(null);
  const [alertsError, setAlertsError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState<Refresh>({ phase: "idle" });
  const alive = useRef(true);
  const onLinkClick = useInternalLinks();

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const loadReport = useCallback(async () => {
    setReportError(null);
    try {
      const r = await api.managersReport(slug, TYPE);
      if (alive.current) setReport(r.current);
    } catch (e) {
      if (alive.current) setReportError(errorText(e, "unknown error"));
    }
  }, [slug]);

  const loadLive = useCallback(async () => {
    setNeedsError(null);
    setAlertsError(null);
    await Promise.all([
      api
        .managersTasks(slug, { status: ["awaiting-ed"] })
        .then((r) => alive.current && setNeeds(r.tasks))
        .catch((e) => alive.current && setNeedsError(errorText(e, "unknown error"))),
      api
        .managersAlerts(slug)
        .then((a) => alive.current && setAlerts(a))
        .catch((e) => alive.current && setAlertsError(errorText(e, "unknown error"))),
    ]);
  }, [slug]);

  useEffect(() => {
    void loadReport();
    void loadLive();
  }, [loadReport, loadLive]);

  const refreshNow = async () => {
    setRefresh({ phase: "starting" });
    let runId: string | null = null;
    try {
      const r = await api.managersRefreshReport(slug, TYPE);
      runId = r.runId;
    } catch (e) {
      if (!alive.current) return;
      const message =
        e instanceof ApiError && e.code === "behaviour_off"
          ? `Refresh is switched off: ${e.message}`
          : `The refresh did not start: ${errorText(e, "unknown error")}`;
      setRefresh({ phase: "refused", message });
      return;
    }
    if (!alive.current) return;
    setRefresh({ phase: "running", runId });
    // Poll the run until it ends. Without a run id (should not happen) there is
    // nothing to poll, so just re-read after one interval.
    const started = Date.now();
    let reports: string[] = [];
    let status: string = "running";
    let error: string | null = null;
    while (runId && alive.current && Date.now() - started < REFRESH_GIVE_UP_MS) {
      await new Promise((res) => setTimeout(res, pollMs));
      if (!alive.current) return;
      try {
        const run = await api.managersRun(slug, runId);
        status = run.status;
        reports = run.reports;
        error = run.error;
        if (status !== "running") break;
      } catch {
        /* a blip; keep polling */
      }
    }
    if (!runId) await new Promise((res) => setTimeout(res, pollMs));
    if (!alive.current) return;
    await Promise.all([loadReport(), loadLive()]);
    onRunFinished?.();
    if (!alive.current) return;
    if (status === "running" && runId) {
      setRefresh({ phase: "failed", runId, message: "The report run is still going after ten minutes." });
    } else if (status === "failed" || status === "cancelled") {
      setRefresh({ phase: "failed", runId, message: error ?? `The report run ${status}.` });
    } else if (runId && !reports.includes(TYPE)) {
      setRefresh({ phase: "no-report", runId });
    } else {
      setRefresh({ phase: "done" });
    }
  };

  const busy = refresh.phase === "starting" || refresh.phase === "running";
  const generated = report ? reportGenerated(report) : null;
  const body = report ? reportBody(report.body) : "";
  const stale = generated ? isReportStale(generated) : false;

  return (
    <section className="mb-8" data-testid="status-report-card" aria-labelledby="status-report-heading">
      <Card flush>
        <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-edge-subtle px-4 py-3">
          <div className="mr-auto min-w-0">
            <h3 id="status-report-heading" className="text-sm font-semibold text-fg">
              Status report
            </h3>
            <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-2xs text-fg-subtle" data-testid="status-report-generated">
              {busy ? (
                <span className="text-fg-muted">Writing a fresh report…</span>
              ) : generated ? (
                <>
                  <span title={new Date(generated).toLocaleString()}>Generated {relativeTime(generated)}</span>
                  {stale && (
                    <Chip tone="warn" size="sm" icon={<ClockIcon width={10} height={10} />}>
                      Out of date
                    </Chip>
                  )}
                </>
              ) : report === null ? (
                <span>Never generated</span>
              ) : null}
            </p>
          </div>
          <Link
            to={reportsUrl(base, TYPE)}
            className="rounded-md px-2 py-1 text-xs font-medium text-fg-muted transition-colors can-hover:hover:bg-surface-hover can-hover:hover:text-fg focus-visible:focus-ring"
          >
            History
          </Link>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void refreshNow()}
            loading={busy}
            icon={busy ? <Spinner /> : undefined}
            loadingLabel="Refreshing…"
          >
            Refresh now
          </Button>
        </header>

        <div className="space-y-5 px-4 py-4">
          {refresh.phase === "failed" && (
            <Callout tone="danger" icon={<AlertIcon width={14} height={14} />}>
              <span className="break-words">The refresh run failed: {refresh.message}</span>{" "}
              {refresh.runId && (
                <Button size="sm" variant="link" onClick={() => onOpenRun(refresh.runId!)}>
                  View run
                </Button>
              )}
            </Callout>
          )}
          {refresh.phase === "no-report" && (
            <Callout tone="warn">
              The refresh run finished without writing a report.{" "}
              {refresh.runId && (
                <Button size="sm" variant="link" onClick={() => onOpenRun(refresh.runId!)}>
                  View run
                </Button>
              )}
            </Callout>
          )}
          {refresh.phase === "refused" && <Callout tone="warn">{refresh.message}</Callout>}

          {/* Needs you — LIVE, never the stored section. */}
          <div data-testid="needs-you">
            <SubHeading label="Needs you" count={needs?.length} />
            {needsError ? (
              <p className="text-sm text-danger">Couldn’t load what needs you: {needsError}</p>
            ) : needs === null ? (
              <div className="h-5 w-2/3 animate-pulse rounded-md bg-surface-active" aria-busy="true" />
            ) : needs.length === 0 ? (
              <p className="text-sm text-fg-subtle">Nothing needs you right now.</p>
            ) : (
              <ul className="space-y-2">
                {needs.map((t) => (
                  <li key={t.id} className="flex items-start gap-2">
                    <StatusDot tone="warn" className="mt-1.5" />
                    <div className="min-w-0">
                      <Link
                        to={`${tasksUrl(base)}#${t.id}`}
                        className="break-words text-sm font-medium text-fg underline-offset-2 can-hover:hover:underline focus-visible:focus-ring"
                      >
                        {t.title}
                      </Link>
                      {t.ask && <p className="break-words text-sm text-fg-muted">{t.ask}</p>}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Alerts — LIVE. */}
          <div data-testid="status-alerts">
            <SubHeading label="Alerts" count={alerts?.length} />
            {alertsError ? (
              <p className="text-sm text-danger">Couldn’t load alerts: {alertsError}</p>
            ) : alerts === null ? (
              <div className="h-5 w-1/2 animate-pulse rounded-md bg-surface-active" aria-busy="true" />
            ) : (
              <AlertsList alerts={alerts} onOpenRun={onOpenRun} />
            )}
          </div>

          {/* The rest of the stored report. */}
          <div className="border-t border-edge-subtle pt-4" data-testid="status-report-body">
            {reportError ? (
              <PaneError what="the status report" message={reportError} onRetry={() => void loadReport()} />
            ) : report === undefined ? (
              <div className="space-y-2" aria-busy="true" aria-label="Loading the report">
                <div className="h-4 w-1/3 animate-pulse rounded-md bg-surface-active" />
                <div className="h-4 w-5/6 animate-pulse rounded-md bg-surface-active" />
              </div>
            ) : report === null ? (
              <EmptyState
                title="No status report yet"
                body="Refresh now asks the manager to write one from what it knows. Needs you and Alerts above are always live."
              />
            ) : body ? (
              <div onClick={onLinkClick}>
                <Markdown>{body}</Markdown>
              </div>
            ) : (
              <p className="text-sm text-fg-subtle">The report has nothing beyond Needs you and Alerts.</p>
            )}
          </div>
        </div>
      </Card>
    </section>
  );
}
