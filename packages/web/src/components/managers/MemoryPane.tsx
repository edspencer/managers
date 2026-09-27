/**
 * MemoryPane (Managers M12): the Memory tab — what the manager has learned.
 *
 * Two sections at a project: **This project** (its own `memory/facts/`) and
 * **Shared** (Home's, which every manager reads). At Home there is only Shared.
 * Each fact is a row: its description, its name, a type chip, since/until,
 * confidence, and evidence chips — the journal entries that justify it,
 * resolved by the server (`evidenceLinks`) so a chip lands on the objective
 * page scrolled to that `#ep-…` (or on the log file). An id the server could
 * not find is shown struck through, never silently dropped.
 *
 * A filter switches between Active (no `until`, or an `until` still ahead),
 * Superseded (an `until` that has passed) and All. The header says whether
 * consolidation — the run that writes facts — is on, and links to where it is
 * switched (Settings → Behaviours). Facts are read-only in v1: edits go through
 * a chat with the manager, or the file.
 *
 * `…/memory/:fact` renders {@link FactDetailView} instead of the list.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ApiError, api } from "../../lib/api";
import type { Behaviour, EvidenceLink, FactDetail, FactSummary, MemoryScope, MemoryView } from "../../lib/types";
import { memoryUrl } from "../../routes/ProjectView/urls";
import { Markdown } from "../Markdown";
import { Button, Callout, Card, Chip, EmptyState, cx } from "../ui";
import { SparkIcon } from "../icons";
import { ListSkeleton, PaneError, PaneScroll, errorText, useInternalLinks } from "./shared";

export type FactFilter = "active" | "superseded" | "all";

/** The behaviour whose trigger writes facts (M14; defined since M8). */
export const CONSOLIDATION_BEHAVIOUR = "consolidate-memory";

/** Superseded = an `until` date that is today or earlier. */
export function isSuperseded(f: Pick<FactSummary, "until">, today = new Date().toISOString().slice(0, 10)): boolean {
  return !!f.until && f.until.slice(0, 10) <= today;
}

function filesUrl(base: string, file: string): string {
  return `${base}/files/${file.split("/").map(encodeURIComponent).join("/")}`;
}

/** A file in the fact's own workspace: the root's memory lives at the root. */
function factFileUrl(base: string, f: Pick<FactSummary, "scope" | "file">): string {
  return filesUrl(f.scope === "root" ? "" : base, f.file);
}

/** `ep-260824-1600-ah` → "24 Aug 16:00"; anything else as is. */
export function episodeLabel(id: string): string {
  const m = /^ep-(\d{2})(\d{2})(\d{2})-(\d{2})(\d{2})-/.exec(id);
  if (!m) return id;
  const d = new Date(Date.UTC(2000 + Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (Number.isNaN(d.getTime())) return id;
  const day = d.toLocaleDateString(undefined, { day: "numeric", month: "short", timeZone: "UTC" });
  return `${day} ${m[4]}:${m[5]}`;
}

export function EvidenceChips({ links, evidence }: { links?: EvidenceLink[]; evidence: string[] }) {
  const list: EvidenceLink[] =
    links ??
    evidence.map((episode) => ({ episode, found: false, workspace: null, objective: null, file: null, line: null, href: null }));
  if (list.length === 0) return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-1" data-testid="evidence-chips">
      {list.map((l) =>
        l.found && l.href ? (
          <Link
            key={l.episode}
            to={l.href}
            title={`${l.episode}${l.objective ? ` in ${l.objective}` : " in the project log"}`}
            className="rounded-md focus-visible:focus-ring"
            data-testid={`evidence-${l.episode}`}
          >
            <Chip tone="lineage" className="can-hover:hover:underline">
              {episodeLabel(l.episode)}
            </Chip>
          </Link>
        ) : (
          <Chip key={l.episode} tone="neutral" title={`${l.episode}: that journal entry was not found`} className="line-through">
            {episodeLabel(l.episode)}
          </Chip>
        ),
      )}
    </span>
  );
}

function FactMeta({ f }: { f: FactSummary }) {
  return (
    <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-2xs text-fg-subtle">
      <Chip tone="neutral">{f.type}</Chip>
      {f.since && <span>since {f.since.slice(0, 10)}</span>}
      {f.until && <span className={isSuperseded(f) ? "text-warn" : undefined}>until {f.until.slice(0, 10)}</span>}
      {f.confidence && <span>{f.confidence} confidence</span>}
      <EvidenceChips links={f.evidenceLinks} evidence={f.evidence} />
    </p>
  );
}

function FactRow({ base, f }: { base: string; f: FactSummary }) {
  return (
    <li className="px-4 py-3" data-testid={`fact-${f.scope}-${f.name}`}>
      <Link
        to={memoryUrl(base, f.name, f.scope === "root" ? "root" : undefined)}
        className="block rounded-md focus-visible:focus-ring"
      >
        <span className={cx("block break-words text-sm text-fg can-hover:hover:underline", isSuperseded(f) && "text-fg-muted line-through")}>
          {f.description ?? f.name}
        </span>
        <span className="font-mono text-2xs text-fg-subtle">{f.name}</span>
      </Link>
      <FactMeta f={f} />
    </li>
  );
}

function FactSection({
  title,
  description,
  facts,
  filter,
  base,
  empty,
  onShowAll,
  testId,
}: {
  title: string;
  description: string;
  facts: FactSummary[];
  filter: FactFilter;
  base: string;
  empty: { title: string; body: string };
  onShowAll: () => void;
  testId: string;
}) {
  const shown = facts.filter((f) => (filter === "all" ? true : filter === "superseded" ? isSuperseded(f) : !isSuperseded(f)));
  return (
    <section className="mb-8" data-testid={testId}>
      <h3 className="text-sm font-semibold uppercase tracking-wide text-fg-muted">
        {title}
        {shown.length > 0 && <span className="ml-1.5 text-fg-subtle">{shown.length}</span>}
      </h3>
      <p className="mb-2 mt-0.5 text-xs text-fg-muted">{description}</p>
      {facts.length === 0 ? (
        <EmptyState title={empty.title} body={empty.body} />
      ) : shown.length === 0 ? (
        <EmptyState
          title={filter === "superseded" ? "No superseded facts" : "No active facts"}
          action={
            <Button size="sm" variant="ghost" onClick={onShowAll}>
              Show all
            </Button>
          }
        />
      ) : (
        <Card flush>
          <ul className="divide-y divide-edge-subtle">
            {shown.map((f) => (
              <FactRow key={`${f.scope}:${f.name}`} base={base} f={f} />
            ))}
          </ul>
        </Card>
      )}
    </section>
  );
}

function ConsolidationState({ base, behaviour, failed }: { base: string; behaviour: Behaviour | null | undefined; failed: boolean }) {
  const label = failed ? "unknown" : behaviour === undefined ? "…" : behaviour?.enabled ? "on" : "off";
  return (
    <Link
      to={`${base}/settings#behaviours`}
      className="rounded-full focus-visible:focus-ring"
      title="Consolidation turns recent journal entries into facts. Switch it in Settings → Behaviours."
      data-testid="consolidation-state"
    >
      <Chip tone={behaviour?.enabled ? "success" : "neutral"} shape="pill" dot className="can-hover:hover:underline">
        Consolidation: {label}
      </Chip>
    </Link>
  );
}

const FILTERS: { id: FactFilter; label: string }[] = [
  { id: "active", label: "Active" },
  { id: "superseded", label: "Superseded" },
  { id: "all", label: "All" },
];

export function MemoryPane({
  slug,
  base,
  root,
  factName,
}: {
  slug: string;
  base: string;
  /** Home: only the shared section. */
  root: boolean;
  /** `…/memory/:fact`: that fact's page instead of the list. */
  factName?: string;
}) {
  const [view, setView] = useState<MemoryView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [consolidation, setConsolidation] = useState<Behaviour | null | undefined>(undefined);
  const [consolidationFailed, setConsolidationFailed] = useState(false);
  const [params, setParams] = useSearchParams();
  const filter: FactFilter = (FILTERS.find((f) => f.id === params.get("show"))?.id ?? "active") as FactFilter;
  const setFilter = (f: FactFilter) =>
    setParams(
      (p) => {
        const n = new URLSearchParams(p);
        if (f === "active") n.delete("show");
        else n.set("show", f);
        return n;
      },
      { replace: true },
    );

  const load = useCallback(async () => {
    setError(null);
    try {
      setView(await api.managersMemory(slug));
    } catch (e) {
      setError(errorText(e, "unknown error"));
    }
  }, [slug]);

  useEffect(() => {
    if (factName) return;
    void load();
    api
      .managersBehaviours(slug)
      .then((b) => setConsolidation(b.behaviours.find((x) => x.name === CONSOLIDATION_BEHAVIOUR) ?? null))
      .catch(() => setConsolidationFailed(true));
  }, [load, slug, factName]);

  const project = useMemo(() => view?.facts.filter((f) => f.scope === "project") ?? [], [view]);
  const shared = useMemo(() => view?.facts.filter((f) => f.scope === "root") ?? [], [view]);

  if (factName) {
    const scope = params.get("scope");
    return (
      <FactDetailView
        slug={slug}
        base={base}
        name={factName}
        scope={scope === "root" || scope === "project" ? scope : undefined}
      />
    );
  }

  return (
    <PaneScroll testId="memory-pane">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <h2 className="mr-auto text-lg font-semibold tracking-tight text-fg">Memory</h2>
        <ConsolidationState base={base} behaviour={consolidation} failed={consolidationFailed} />
      </div>
      <p className="mb-4 text-sm text-fg-muted">
        Facts the manager has learned, with the journal entries behind them. Change one by telling the manager in a chat.
      </p>

      <div role="group" aria-label="Which facts" className="mb-5 inline-flex rounded-lg bg-surface-active p-0.5">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            aria-pressed={filter === f.id}
            onClick={() => setFilter(f.id)}
            className={cx(
              "rounded-md px-2.5 py-1 text-xs font-medium transition-colors focus-visible:focus-ring",
              filter === f.id ? "bg-surface-raised text-fg shadow-xs" : "text-fg-muted can-hover:hover:text-fg",
            )}
          >
            {f.label}
          </button>
        ))}
      </div>

      {error ? (
        <PaneError what="memory" message={error} onRetry={() => void load()} />
      ) : view === null ? (
        <ListSkeleton rows={3} testId="memory-loading" />
      ) : (
        <>
          {view.parseErrors && view.parseErrors.length > 0 && (
            <Callout tone="warn" className="mb-4">
              <p>
                {view.parseErrors.length === 1 ? "One memory file" : `${view.parseErrors.length} memory files`} could not be
                read and {view.parseErrors.length === 1 ? "is" : "are"} not listed:
              </p>
              <ul className="mt-1 list-disc pl-5 text-xs">
                {view.parseErrors.map((p) => (
                  <li key={`${p.scope}:${p.file}`}>
                    <span className="font-mono">{p.file}</span>: {p.error}
                  </li>
                ))}
              </ul>
            </Callout>
          )}
          {!root && (
            <FactSection
              testId="memory-project"
              title="This project"
              description="What this project's manager has learned. Only it reads these."
              facts={project}
              filter={filter}
              base={base}
              onShowAll={() => setFilter("all")}
              empty={{
                title: "No project memory",
                body: "Facts appear here once consolidation turns journal entries into them.",
              }}
            />
          )}
          <FactSection
            testId="memory-shared"
            title={root ? "Shared memory" : "Shared"}
            description="Home's memory. Every project's manager reads these."
            facts={shared}
            filter={filter}
            base={base}
            onShowAll={() => setFilter("all")}
            empty={{ title: "No shared memory", body: "Facts Home's manager learns apply to every project." }}
          />
          {view.playbooks.length > 0 && (
            <section className="mb-8">
              <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-fg-muted">Playbooks</h3>
              <Card flush>
                <ul className="divide-y divide-edge-subtle">
                  {view.playbooks.map((p) => (
                    <li key={`${p.scope}:${p.name}`} className="flex items-center gap-2 px-4 py-2.5">
                      <Link to={factFileUrl(base, p)} className="min-w-0 flex-1 truncate text-sm text-fg can-hover:hover:underline">
                        {p.description ?? p.name}
                      </Link>
                      {p.scope === "root" && !root && <Chip tone="neutral">shared</Chip>}
                    </li>
                  ))}
                </ul>
              </Card>
            </section>
          )}
        </>
      )}
    </PaneScroll>
  );
}

export function FactDetailView({
  slug,
  base,
  name,
  scope,
}: {
  slug: string;
  base: string;
  name: string;
  scope?: MemoryScope;
}) {
  const [fact, setFact] = useState<FactDetail | null>(null);
  const [error, setError] = useState<{ message: string; notFound: boolean } | null>(null);
  const onLinkClick = useInternalLinks();

  const load = useCallback(async () => {
    setError(null);
    try {
      setFact(await api.managersFact(slug, name, scope));
    } catch (e) {
      setError({ message: errorText(e, "unknown error"), notFound: e instanceof ApiError && e.status === 404 });
    }
  }, [slug, name, scope]);

  useEffect(() => {
    setFact(null);
    void load();
  }, [load]);

  const back = (
    <Link to={memoryUrl(base)} className="text-xs text-fg-muted underline-offset-2 can-hover:hover:text-fg can-hover:hover:underline">
      ← All memory
    </Link>
  );

  return (
    <PaneScroll testId="fact-detail">
      <div className="mb-3">{back}</div>
      {error ? (
        error.notFound ? (
          <EmptyState
            variant="panel"
            icon={<SparkIcon width={22} height={22} />}
            title="Fact not found"
            body={`There is no fact called “${name}” here. It may have been renamed or removed.`}
            action={back}
          />
        ) : (
          <PaneError what="the fact" message={error.message} onRetry={() => void load()} />
        )
      ) : !fact ? (
        <ListSkeleton rows={2} />
      ) : (
        <>
          <h2 className="break-words text-lg font-semibold tracking-tight text-fg">{fact.description ?? fact.name}</h2>
          <p className="mt-0.5 flex flex-wrap items-center gap-2 text-2xs text-fg-subtle">
            <span className="font-mono">{fact.name}</span>
            <Chip tone="neutral">{fact.scope === "root" ? "shared" : "this project"}</Chip>
            <Link to={factFileUrl(base, fact)} className="underline-offset-2 can-hover:hover:text-fg can-hover:hover:underline">
              Edit in Files
            </Link>
          </p>
          <FactMeta f={fact} />
          {isSuperseded(fact) && (
            <Callout tone="warn" className="mt-3">
              Superseded on {fact.until?.slice(0, 10)}. The manager no longer relies on this.
            </Callout>
          )}
          <Card className="mt-4">
            {fact.body.trim() ? (
              <div onClick={onLinkClick}>
                <Markdown>{fact.body}</Markdown>
              </div>
            ) : (
              <p className="text-sm text-fg-subtle">No notes beyond the description.</p>
            )}
          </Card>
          {fact.history.length > 0 && (
            <section className="mt-5">
              <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-fg-muted">History</h3>
              <ul className="space-y-1 text-sm text-fg-muted">
                {fact.history.map((h, i) => (
                  <li key={i} className="break-words">
                    {h}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </PaneScroll>
  );
}
