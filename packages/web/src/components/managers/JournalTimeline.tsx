/**
 * JournalTimeline (Managers M11): an objective's journal, newest first, grouped
 * by day.
 *
 * Each entry is one episode the manager (or Ed) recorded: its time, importance,
 * tags, text, the refs it names and links to the run and chat it came from.
 * Every entry is an anchor (`id="ep-…"`), so a fact's evidence (M12) or a
 * shared link can land on it. When the addressed entry is in an older month
 * than the page loaded, older months are loaded until it appears.
 *
 * The journal is paged by month file: "Load older" fetches the next one.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { api } from "../../lib/api";
import type { Episode, EpisodePage } from "../../lib/types";
import { chatUrl, tasksUrl } from "../../routes/ProjectView/urls";
import { Button, Chip, EmptyState, cx } from "../ui";
import { ChatIcon, PlayIcon } from "../icons";
import { dayLabel, errorText, timeLabel } from "./shared";

const TASK_REF = /^t-\d{6}-[a-z0-9]{4}$/;
const EPISODE_ID = /^ep-(\d{2})(\d{2})\d{2}-\d{4}-[a-z0-9]+$/;

/** `ep-260830-1000-aa` → `2026-08`, the month file it lives in. */
export function episodeMonth(id: string): string | null {
  const m = EPISODE_ID.exec(id);
  return m ? `20${m[1]}-${m[2]}` : null;
}

/** Newest-first entries → `[{ day, entries }]`, keeping order. */
export function groupByDay(entries: Episode[]): { day: string; entries: Episode[] }[] {
  const out: { day: string; entries: Episode[] }[] = [];
  for (const e of entries) {
    const day = e.at.slice(0, 10);
    const last = out[out.length - 1];
    if (last && last.day === day) last.entries.push(e);
    else out.push({ day, entries: [e] });
  }
  return out;
}

function importanceTone(imp: number) {
  return imp >= 7 ? "accent" : "neutral";
}

export function JournalTimeline({
  slug,
  base,
  objectiveId,
  initial,
  onError,
}: {
  slug: string;
  base: string;
  objectiveId: string;
  /** The first page, as it came with the objective. */
  initial: EpisodePage;
  /** A failed "Load older" or run lookup, for the page's toast. */
  onError: (message: string) => void;
}) {
  const [entries, setEntries] = useState<Episode[]>(initial.entries);
  const [nextBefore, setNextBefore] = useState<string | null>(initial.nextBefore);
  const [loading, setLoading] = useState(false);
  const [opening, setOpening] = useState<string | null>(null);
  const location = useLocation();
  const navigate = useNavigate();
  const target = location.hash.replace(/^#/, "");

  useEffect(() => {
    setEntries(initial.entries);
    setNextBefore(initial.nextBefore);
  }, [initial]);

  const loadOlder = useCallback(async () => {
    if (!nextBefore || loading) return;
    setLoading(true);
    try {
      const o = await api.managersObjective(slug, objectiveId, { before: nextBefore, months: 1 });
      setEntries((prev) => {
        const seen = new Set(prev.map((e) => e.id));
        return [...prev, ...o.journal.entries.filter((e) => !seen.has(e.id))];
      });
      setNextBefore(o.journal.nextBefore);
    } catch (e) {
      onError(`Couldn't load older entries: ${errorText(e, "unknown error")}`);
    } finally {
      setLoading(false);
    }
  }, [slug, objectiveId, nextBefore, loading, onError]);

  // A `#ep-…` from an older month: keep paging back until it is on screen (or
  // the journal runs out). Then scroll to it.
  const targetLoaded = entries.some((e) => e.id === target);
  useEffect(() => {
    if (!target || targetLoaded || loading || !nextBefore) return;
    const month = episodeMonth(target);
    if (month && month < nextBefore) void loadOlder();
  }, [target, targetLoaded, loading, nextBefore, loadOlder]);
  useEffect(() => {
    if (!target || !targetLoaded) return;
    document.getElementById(target)?.scrollIntoView({ block: "center" });
  }, [target, targetLoaded]);

  // The run link opens the run's chat. Runs record their session; resolve it.
  const openRun = async (runId: string) => {
    setOpening(runId);
    try {
      const d = await api.managersRunDetail(slug, runId);
      if (d.chat) navigate(chatUrl(d.chat.project, d.chat.sessionId));
      else onError(`Run ${runId} has no chat to open.`);
    } catch (e) {
      onError(`Couldn't open run ${runId}: ${errorText(e, "unknown error")}`);
    } finally {
      setOpening(null);
    }
  };

  const days = useMemo(() => groupByDay(entries), [entries]);

  if (entries.length === 0 && !nextBefore) {
    return (
      <EmptyState
        title="No journal entries yet"
        body="The manager records what it does toward this objective here, one entry per step."
      />
    );
  }

  return (
    <div data-testid="journal-timeline">
      {entries.length === 0 && (
        <EmptyState title="Nothing recorded recently" body="Older entries may be further back." />
      )}
      <ol className="space-y-5">
        {days.map((d) => (
          <li key={d.day} data-testid={`journal-day-${d.day}`}>
            <h4 className="mb-2 text-2xs font-semibold uppercase tracking-wide text-fg-subtle">{dayLabel(d.day)}</h4>
            <ol className="space-y-2 border-l border-edge pl-4">
              {d.entries.map((e) => (
                <li
                  key={e.id}
                  id={e.id}
                  data-testid="journal-entry"
                  className={cx(
                    "relative scroll-mt-24 rounded-xl px-3 py-2 motion-base transition-colors",
                    e.id === target ? "bg-accent-soft ring-1 ring-accent" : "bg-surface-raised",
                  )}
                >
                  <span
                    aria-hidden
                    className="absolute -left-[1.3rem] top-3.5 h-2 w-2 rounded-full border border-edge-strong bg-surface"
                  />
                  <div className="flex flex-wrap items-center gap-1.5 text-2xs text-fg-subtle">
                    <time dateTime={e.at} className="tabular" title={`${e.at.slice(0, 16).replace("T", " ")} UTC`}>
                      {timeLabel(e.at)} UTC
                    </time>
                    <Chip tone={importanceTone(e.importance)} size="sm" title={`Importance ${e.importance} of 10`}>
                      imp {e.importance}
                    </Chip>
                    {e.source === "ed" && (
                      <Chip tone="info" size="sm">
                        you
                      </Chip>
                    )}
                    {e.tags.map((t) => (
                      <Chip key={t} size="sm">
                        #{t}
                      </Chip>
                    ))}
                    <a href={`#${e.id}`} className="ml-auto font-mono text-3xs text-fg-subtle hover:text-accent" title="Link to this entry">
                      {e.id}
                    </a>
                  </div>
                  <p className="mt-1 whitespace-pre-wrap break-words text-sm text-fg">{e.text}</p>
                  {(e.refs.length > 0 || e.run || e.chat) && (
                    <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-fg-muted">
                      {e.refs.length > 0 && (
                        <span className="min-w-0 break-words">
                          refs:{" "}
                          {e.refs.map((r, i) => (
                            <span key={r}>
                              {i > 0 && ", "}
                              {TASK_REF.test(r) ? (
                                <Link to={tasksUrl(base, r)} className="font-mono text-accent hover:underline">
                                  {r}
                                </Link>
                              ) : (
                                <span className="font-mono">{r}</span>
                              )}
                            </span>
                          ))}
                        </span>
                      )}
                      {e.run && (
                        <button
                          type="button"
                          onClick={() => void openRun(e.run!)}
                          disabled={opening === e.run}
                          className="inline-flex items-center gap-1 rounded-sm text-accent hover:underline focus-visible:focus-ring disabled:opacity-50"
                          title="Open the chat of the run that recorded this"
                          data-testid="journal-run-link"
                        >
                          <PlayIcon width={10} height={10} />
                          {opening === e.run ? "Opening…" : `run ${e.run}`}
                        </button>
                      )}
                      {e.chat && (
                        <Link
                          to={chatUrl(slug, e.chat)}
                          className="inline-flex items-center gap-1 rounded-sm text-accent hover:underline focus-visible:focus-ring"
                        >
                          <ChatIcon width={10} height={10} />
                          chat
                        </Link>
                      )}
                    </div>
                  )}
                </li>
              ))}
            </ol>
          </li>
        ))}
      </ol>
      {nextBefore && (
        <div className="mt-4">
          <Button
            size="sm"
            variant="subtle"
            loading={loading}
            loadingLabel="Loading…"
            onClick={() => void loadOlder()}
            data-testid="journal-load-older"
          >
            Load older entries
          </Button>
        </div>
      )}
    </div>
  );
}
