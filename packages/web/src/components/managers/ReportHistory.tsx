/**
 * ReportHistory (Managers M12): every dated report of one type — the date list
 * and a viewer — at `…/reports/:type[/:date]`. Reached from Home's status card
 * ("History"); there is no tab for it.
 *
 * A dated report is shown exactly as it was written, including the Needs you
 * and Alerts the server rendered THEN. That is the point of history, so the
 * viewer says so; the live versions are on Home.
 *
 * Without a date the newest one is shown. On a phone the date list becomes a
 * select above the viewer rather than a column beside it.
 */
import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ApiError, api } from "../../lib/api";
import type { ReportDoc } from "../../lib/types";
import { homeUrl, reportsUrl } from "../../routes/ProjectView/urls";
import { Markdown } from "../Markdown";
import { Card, EmptyState, Select, cx } from "../ui";
import { ClockIcon } from "../icons";
import { ListSkeleton, PaneError, PaneScroll, dayLabel, errorText, useInternalLinks } from "./shared";

function typeLabel(type: string): string {
  return type.charAt(0).toUpperCase() + type.slice(1).replace(/-/g, " ");
}

export function ReportHistory({
  slug,
  base,
  type,
  date,
}: {
  slug: string;
  base: string;
  type: string;
  /** `YYYY-MM-DD`; absent = the newest. */
  date?: string;
}) {
  const [dates, setDates] = useState<string[] | null>(null);
  const [listError, setListError] = useState<{ message: string; notFound: boolean } | null>(null);
  const [doc, setDoc] = useState<ReportDoc | null>(null);
  const [docError, setDocError] = useState<{ message: string; notFound: boolean } | null>(null);
  const navigate = useNavigate();
  const onLinkClick = useInternalLinks();

  const loadList = useCallback(async () => {
    setListError(null);
    try {
      const r = await api.managersReport(slug, type);
      setDates(r.dates);
    } catch (e) {
      setListError({ message: errorText(e, "unknown error"), notFound: e instanceof ApiError && e.status === 404 });
    }
  }, [slug, type]);

  useEffect(() => {
    setDates(null);
    void loadList();
  }, [loadList]);

  const shown = date ?? dates?.[0];

  const loadDoc = useCallback(async () => {
    if (!shown) return;
    setDocError(null);
    setDoc(null);
    try {
      setDoc(await api.managersDatedReport(slug, type, shown));
    } catch (e) {
      setDocError({ message: errorText(e, "unknown error"), notFound: e instanceof ApiError && e.status === 404 });
    }
  }, [slug, type, shown]);

  useEffect(() => {
    void loadDoc();
  }, [loadDoc]);

  const title = `${typeLabel(type)} reports`;
  const back = (
    <Link to={homeUrl(base)} className="text-xs text-fg-muted underline-offset-2 can-hover:hover:text-fg can-hover:hover:underline">
      ← Back to Home
    </Link>
  );

  return (
    <PaneScroll testId="report-history">
      <div className="mb-4">
        {back}
        <h2 className="mt-1 text-lg font-semibold tracking-tight text-fg">{title}</h2>
      </div>

      {listError ? (
        listError.notFound ? (
          <EmptyState
            variant="panel"
            title={`No “${type}” reports here`}
            body="This workspace has no report of that type."
            action={back}
          />
        ) : (
          <PaneError what="the report history" message={listError.message} onRetry={() => void loadList()} />
        )
      ) : dates === null ? (
        <ListSkeleton rows={2} testId="report-history-loading" />
      ) : dates.length === 0 ? (
        <EmptyState
          variant="panel"
          icon={<ClockIcon width={22} height={22} />}
          title={`No ${type} reports yet`}
          body="Each report the manager writes is kept here by date. Use Refresh now on Home to write the first."
          action={back}
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-[11rem_1fr]">
          {/* Dates: a column on wide screens, a select on a phone. */}
          <nav aria-label="Report dates" className="hidden md:block">
            <ul className="space-y-0.5" data-testid="report-dates">
              {dates.map((d) => (
                <li key={d}>
                  <Link
                    to={reportsUrl(base, type, d)}
                    aria-current={d === shown ? "page" : undefined}
                    className={cx(
                      "block rounded-lg px-2.5 py-1.5 text-sm tabular transition-colors focus-visible:focus-ring",
                      d === shown ? "bg-surface-selected font-medium text-fg" : "text-fg-muted can-hover:hover:bg-surface-hover can-hover:hover:text-fg",
                    )}
                  >
                    {dayLabel(d)}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
          <div className="md:hidden">
            <Select
              aria-label="Report date"
              value={shown}
              onChange={(e) => navigate(reportsUrl(base, type, e.target.value))}
            >
              {!dates.includes(shown ?? "") && shown && <option value={shown}>{dayLabel(shown)}</option>}
              {dates.map((d) => (
                <option key={d} value={d}>
                  {dayLabel(d)}
                </option>
              ))}
            </Select>
          </div>

          <div className="min-w-0">
            {docError ? (
              docError.notFound ? (
                <EmptyState
                  variant="panel"
                  title="No report for that date"
                  body={shown ? `There is no ${type} report dated ${shown}.` : undefined}
                  action={
                    <Link to={reportsUrl(base, type)} className="text-sm text-accent underline-offset-2 hover:underline">
                      Show the newest
                    </Link>
                  }
                />
              ) : (
                <PaneError what="the report" message={docError.message} onRetry={() => void loadDoc()} />
              )
            ) : !doc ? (
              <ListSkeleton rows={1} />
            ) : (
              <Card data-testid="report-viewer">
                <p className="mb-3 text-2xs text-fg-subtle">
                  As written on {dayLabel(doc.date ?? shown ?? "")}. Needs you and Alerts are as they were then; Home shows
                  them live.
                </p>
                {doc.parseError && (
                  <p className="mb-2 text-xs text-warn">This report’s frontmatter would not parse; it is shown as plain text.</p>
                )}
                <div onClick={onLinkClick}>
                  <Markdown>{doc.body}</Markdown>
                </div>
              </Card>
            )}
          </div>
        </div>
      )}
    </PaneScroll>
  );
}
