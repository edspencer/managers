/**
 * RunDrawer (Managers M12): one Managers run, opened from Home's runs list or an
 * alert. A side drawer (`Dialog placement="side"`), so the list it came from
 * stays in view on a wide screen.
 *
 * It answers "what happened on this run": status, trigger, timing, whether the
 * run produced what its trigger expects, the error, the alerts naming it, what
 * it wrote (episodes, tasks, reports, artifacts), which connections it called,
 * a link to the run's chat, and "What the manager saw" — the exact briefing the
 * run was woken with (`.managers/briefings/<run>.md`, M7), collapsed by default
 * because it is long.
 */
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../lib/api";
import { formatTokens } from "../../lib/format";
import type { RunDetail } from "../../lib/types";
import { chatUrl, objectivesUrl, reportsUrl, tasksUrl } from "../../routes/ProjectView/urls";
import { Button, Callout, Chip, Dialog } from "../ui";
import { AlertIcon, CheckIcon, ChevronRightIcon, XIcon } from "../icons";
import { AlertsList } from "./AlertsList";
import { PaneError, RUN_STATUS_LABEL, RUN_STATUS_TONE, durationLabel, errorText } from "./shared";

function when(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** The expect result as a word and a glyph. */
export function ExpectBadge({ result }: { result: RunDetail["run"]["expectResult"] }) {
  if (result === "met") {
    return (
      <Chip tone="success" icon={<CheckIcon width={11} height={11} />} title="The run produced what its trigger expects">
        Expectation met
      </Chip>
    );
  }
  if (result === "missing") {
    return (
      <Chip tone="danger" icon={<XIcon width={11} height={11} />} title="The run did not produce what its trigger expects">
        Expectation missed
      </Chip>
    );
  }
  return <Chip tone="neutral">No expectation</Chip>;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[7rem_1fr] gap-2 py-1.5 text-sm">
      <dt className="text-fg-muted">{label}</dt>
      <dd className="min-w-0 break-words text-fg">{children}</dd>
    </div>
  );
}

function calls(map: Record<string, Record<string, number>> | undefined): string[] {
  const out: string[] = [];
  for (const [server, tools] of Object.entries(map ?? {})) {
    for (const [tool, n] of Object.entries(tools)) out.push(`${server}.${tool}${n > 1 ? ` ×${n}` : ""}`);
  }
  return out;
}

export function RunDrawer({
  slug,
  base,
  runId,
  onClose,
}: {
  slug: string;
  base: string;
  /** The run to show; null = closed. */
  runId: string | null;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showBriefing, setShowBriefing] = useState(false);

  const load = useCallback(async () => {
    if (!runId) return;
    setError(null);
    try {
      setDetail(await api.managersRunDetail(slug, runId));
    } catch (e) {
      setError(errorText(e, "unknown error"));
    }
  }, [slug, runId]);

  useEffect(() => {
    setDetail(null);
    setShowBriefing(false);
    void load();
  }, [load]);

  const run = detail?.run;
  const mcp = calls(run?.mcpCalls);
  const mcpErr = calls(run?.mcpErrors);

  return (
    <Dialog
      open={runId !== null}
      onClose={onClose}
      placement="side"
      size="lg"
      title={run ? `Run ${run.id}` : "Run"}
      footer={
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
      }
    >
      <div data-testid="run-drawer" className="pt-2">
        {error ? (
          <PaneError what="the run" message={error} onRetry={() => void load()} />
        ) : !run || !detail ? (
          <div className="space-y-2" aria-busy="true" aria-label="Loading">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-6 animate-pulse rounded-md bg-surface-active" />
            ))}
          </div>
        ) : (
          <>
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <Chip tone={RUN_STATUS_TONE[run.status]} shape="pill" dot>
                {RUN_STATUS_LABEL[run.status]}
              </Chip>
              {run.expect && <ExpectBadge result={run.expectResult} />}
              <Chip tone="neutral">{run.kind}</Chip>
            </div>

            {run.error && (
              <Callout tone="danger" icon={<AlertIcon width={14} height={14} />} className="mb-3">
                <span className="break-words">{run.error}</span>
              </Callout>
            )}

            <dl className="divide-y divide-edge-subtle">
              <Row label="Trigger">
                <span className="font-mono">{run.trigger ?? "—"}</span>
              </Row>
              {run.objective && (
                <Row label="Objective">
                  <Link className="text-accent underline-offset-2 hover:underline" to={objectivesUrl(base, run.objective)} onClick={onClose}>
                    {run.objective}
                  </Link>
                </Row>
              )}
              <Row label="Started">{when(run.started)}</Row>
              <Row label="Finished">{run.status === "running" ? "Still running" : when(run.finished)}</Row>
              <Row label="Duration">
                <span className="tabular">{durationLabel(detail.durationSeconds) || "—"}</span>
              </Row>
              {run.expect && (
                <Row label="Expected">
                  {run.expect.kind === "report"
                    ? `a ${run.expect.report ?? ""} report`
                    : run.expect.kind === "none"
                      ? "nothing"
                      : `an ${run.expect.kind}`}
                  {run.expect.within ? ` within ${run.expect.within}` : ""}
                </Row>
              )}
              {run.model && <Row label="Model">{run.model}</Row>}
              {run.usage && (
                <Row label="Tokens">
                  <span className="tabular">
                    {formatTokens(run.usage.inputTokens + run.usage.cacheReadTokens + run.usage.cacheCreationTokens)} in ·{" "}
                    {formatTokens(run.usage.outputTokens)} out
                  </span>
                </Row>
              )}
              <Row label="Chat">
                {detail.chat ? (
                  <Link
                    className="text-accent underline-offset-2 hover:underline"
                    to={chatUrl(detail.chat.project, detail.chat.sessionId)}
                    onClick={onClose}
                  >
                    Open the run’s chat
                  </Link>
                ) : (
                  <span className="text-fg-subtle">This run has no chat.</span>
                )}
              </Row>
            </dl>

            {(run.episodes.length > 0 || run.tasksTouched.length > 0 || run.reports.length > 0 || run.artifacts.length > 0) && (
              <section className="mt-4">
                <h3 className="mb-1.5 text-2xs font-semibold uppercase tracking-wide text-fg-muted">What it wrote</h3>
                <ul className="space-y-1 text-sm">
                  {run.episodes.map((e) => (
                    <li key={e} className="font-mono text-xs text-fg-muted">
                      episode {e}
                    </li>
                  ))}
                  {run.tasksTouched.map((t) => (
                    <li key={t}>
                      <Link className="font-mono text-xs text-accent hover:underline" to={`${tasksUrl(base)}#${t}`} onClick={onClose}>
                        task {t}
                      </Link>
                    </li>
                  ))}
                  {run.reports.map((r) => (
                    <li key={r}>
                      <Link className="text-xs text-accent hover:underline" to={reportsUrl(base, r)} onClick={onClose}>
                        {r} report
                      </Link>
                    </li>
                  ))}
                  {run.artifacts.map((a, i) => (
                    <li key={i} className="text-xs text-fg-muted">
                      {a.kind ?? "artifact"}: <span className="font-mono">{a.ref}</span>
                      {a.note ? ` — ${a.note}` : ""}
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {(mcp.length > 0 || mcpErr.length > 0) && (
              <section className="mt-4">
                <h3 className="mb-1.5 text-2xs font-semibold uppercase tracking-wide text-fg-muted">Connection calls</h3>
                <div className="flex flex-wrap gap-1.5">
                  {mcp.map((c) => (
                    <Chip key={c} tone="neutral" className="font-mono">
                      {c}
                    </Chip>
                  ))}
                  {mcpErr.map((c) => (
                    <Chip key={`e:${c}`} tone="danger" className="font-mono" title="These calls returned an error">
                      {c} failed
                    </Chip>
                  ))}
                </div>
              </section>
            )}

            {detail.alerts.length > 0 && (
              <section className="mt-4">
                <h3 className="mb-1.5 text-2xs font-semibold uppercase tracking-wide text-fg-muted">Alerts on this run</h3>
                <AlertsList alerts={detail.alerts} />
              </section>
            )}

            <section className="mt-4">
              <button
                type="button"
                aria-expanded={showBriefing}
                onClick={() => setShowBriefing((v) => !v)}
                disabled={!detail.briefingText}
                className="-ml-1 flex w-full items-center gap-1.5 rounded-lg px-1 py-1 text-left transition-colors can-hover:hover:bg-surface-hover focus-visible:focus-ring disabled:cursor-default"
              >
                <ChevronRightIcon
                  width={14}
                  height={14}
                  className={`shrink-0 text-fg-subtle transition-transform ${showBriefing ? "rotate-90" : ""}`}
                />
                <h3 className="text-2xs font-semibold uppercase tracking-wide text-fg-muted">What the manager saw</h3>
              </button>
              {!detail.briefingText ? (
                <p className="mt-1 text-sm text-fg-subtle">No briefing was recorded for this run.</p>
              ) : (
                showBriefing && (
                  <pre
                    data-testid="run-briefing"
                    className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-surface-sunken p-3 font-mono text-xs text-fg"
                  >
                    {detail.briefingText}
                  </pre>
                )
              )}
            </section>
          </>
        )}
      </div>
    </Dialog>
  );
}
