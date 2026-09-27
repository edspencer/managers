/**
 * The Behaviours settings card (Managers M8): Ed's autonomy switches.
 *
 * Each behaviour is binary. OFF (the default for everything) means it does not
 * happen at all, not even as a proposal: its triggers are not armed and refuse to
 * run, its tools are denied. ON means the manager may act on it. A switch here is
 * the ONLY sanctioned way to change that: it writes `project.yaml`, re-arms the
 * agents, logs an `#autonomy` episode and commits. No agent tool can do it.
 *
 * It saves on its own (one PATCH per switch), outside the Settings form's Save
 * bar, like `RepoBackingSection`.
 */
import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../../lib/api";
import type { Behaviour, BehaviourList } from "../../lib/types";
import { Button, Callout, Chip, EmptyState, Section, Toggle } from "../ui";
import { Toast } from "../Toast";

const YAML_EXAMPLE = `behaviours:
  triage-external-prs:
    description: Triage PRs from outside contributors.
    triggers: [triage-prs]
    tools: [mcp__paddock__create_chat]
    instructions: Name the PR by number only.`;

function originBadge(b: Behaviour, isHome: boolean) {
  if (b.origin === "builtin") return <Chip size="sm" tone="lineage">Built in</Chip>;
  if (b.origin === "home" && !isHome) return <Chip size="sm" tone="lineage">Inherited from Home</Chip>;
  return null;
}

function BehaviourRow({
  b,
  isHome,
  busy,
  onToggle,
}: {
  b: Behaviour;
  isHome: boolean;
  busy: boolean;
  onToggle: (b: Behaviour, next: boolean) => void;
}) {
  return (
    <li className="flex items-start gap-3 px-4 py-3" data-testid={`behaviour-${b.name}`}>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="font-mono text-sm font-medium text-fg">{b.name}</span>
          {originBadge(b, isHome)}
          {b.overridden && (
            <Chip size="sm" title="This project changes the inherited definition">
              Overridden here
            </Chip>
          )}
        </div>
        {b.description && <p className="mt-0.5 text-sm text-fg-muted">{b.description}</p>}
        {(b.boundTriggers.length > 0 || b.tools.length > 0) && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {b.boundTriggers.map((t) => (
              <Chip
                key={`t:${t.name}`}
                size="sm"
                tone={t.exists ? "info" : "warn"}
                title={t.exists ? `Trigger ${t.name}${t.enabled ? "" : " (disabled)"}` : `No trigger named ${t.name} here`}
              >
                trigger {t.name}
                {t.exists ? "" : " · missing"}
              </Chip>
            ))}
            {b.tools.map((tool) => (
              <Chip key={`x:${tool}`} size="sm" title="A tool this behaviour gates">
                <span className="font-mono">{tool}</span>
              </Chip>
            ))}
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2 pt-0.5">
        <span className={b.enabled ? "text-xs font-medium text-success" : "text-xs text-fg-subtle"}>
          {b.enabled ? "On" : "Off"}
        </span>
        <Toggle
          checked={b.enabled}
          disabled={busy}
          label={`${b.enabled ? "Turn off" : "Turn on"} ${b.name}`}
          onChange={(next) => onToggle(b, next)}
        />
      </div>
    </li>
  );
}

export function BehavioursSection({ slug }: { slug: string }) {
  const isHome = slug === "";
  const [data, setData] = useState<BehaviourList | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<{ message: string; tone: "success" | "error" } | null>(null);
  const dismiss = useCallback(() => setToast(null), []);

  const load = useCallback(async () => {
    try {
      setData(await api.managersBehaviours(slug));
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : "Failed to load behaviours");
    }
  }, [slug]);

  useEffect(() => {
    setData(null);
    void load();
  }, [load]);

  const onToggle = async (b: Behaviour, next: boolean) => {
    setBusy(b.name);
    try {
      const r = await api.managersSetBehaviour(slug, b.name, next);
      setData((prev) =>
        prev
          ? { ...prev, behaviours: prev.behaviours.map((x) => (x.name === b.name ? r.behaviour : x)) }
          : prev,
      );
      setToast({
        tone: "success",
        message: next ? `${b.name} is on: the manager may act on it.` : `${b.name} is off: it will not happen.`,
      });
      // A switch re-records the known-good state, so any out-of-UI notice clears.
      void load();
    } catch (err) {
      setToast({ tone: "error", message: err instanceof ApiError ? err.message : `Failed to switch ${b.name}` });
    } finally {
      setBusy(null);
    }
  };

  const acknowledge = async () => {
    setBusy("__ack");
    try {
      await api.managersAcknowledgeBehaviours(slug);
      await load();
      setToast({ tone: "success", message: "Acknowledged: the current behaviours are now the known-good state." });
    } catch (err) {
      setToast({ tone: "error", message: err instanceof ApiError ? err.message : "Failed to acknowledge" });
    } finally {
      setBusy(null);
    }
  };

  // M12: Memory's "Consolidation: off" links to `settings#behaviours`. Scroll
  // here once the list has rendered (the tab's content height is known then).
  const loaded = data !== null;
  useEffect(() => {
    if (loaded && typeof window !== "undefined" && window.location.hash === "#behaviours") {
      document.getElementById("behaviours")?.scrollIntoView?.({ block: "start" });
    }
  }, [loaded]);

  const list = data?.behaviours ?? [];
  // "Own" = defined in this workspace's project.yaml (for Home, its own definitions too).
  const own = list.filter((b) => b.origin === "project" || (isHome && b.origin === "home"));
  const inherited = list.filter((b) => !own.includes(b));

  return (
    <Section
      id="behaviours"
      title="Behaviours"
      description="What this manager may do on its own. Everything is off until you switch it on here. Off means it doesn't happen at all, not even as a proposal."
      flush
    >
      <div data-testid="behaviours-section">
        {loadError && (
          <div className="p-4">
            <Callout tone="danger">{loadError}</Callout>
          </div>
        )}
        {data?.changedOutsideUi && (
          <div className="border-b border-edge p-4">
            <Callout tone="warn">
              <div className="flex flex-wrap items-center gap-2">
                <span className="min-w-0 flex-1">
                  Behaviours changed outside Settings
                  {data.changedSince ? ` since ${new Date(data.changedSince).toLocaleString()}` : ""}. Check
                  project.yaml's history in Changes.
                </span>
                <Button size="sm" variant="subtle" onClick={acknowledge} loading={busy === "__ack"}>
                  Acknowledge
                </Button>
              </div>
            </Callout>
          </div>
        )}
        {!data && !loadError && <p className="px-4 py-3 text-sm text-fg-subtle">Loading…</p>}
        {data && own.length === 0 && (
          <div className="border-b border-edge px-3 py-2">
            <EmptyState
              title={isHome ? "No behaviours defined" : "No behaviours defined in this project"}
              body={
                <>
                  Add one under <code className="font-mono">behaviours:</code> in{" "}
                  {isHome ? "Home's" : "this project's"} project.yaml (it starts off
                  {isHome ? "; every project inherits Home's definitions" : ""}):
                  <pre className="mt-1.5 overflow-x-auto rounded-md bg-surface-active px-2 py-1.5 font-mono text-2xs text-fg-muted">
                    {YAML_EXAMPLE}
                  </pre>
                </>
              }
            />
          </div>
        )}
        {own.length > 0 && (
          <ul className="divide-y divide-edge">
            {own.map((b) => (
              <BehaviourRow key={b.name} b={b} isHome={isHome} busy={busy !== null} onToggle={onToggle} />
            ))}
          </ul>
        )}
        {inherited.length > 0 && (
          <>
            <p className="border-t border-edge px-4 pb-1 pt-3 text-2xs font-semibold uppercase tracking-wide text-fg-subtle">
              {isHome ? "Built in" : "Inherited"}
            </p>
            <ul className="divide-y divide-edge">
              {inherited.map((b) => (
                <BehaviourRow key={b.name} b={b} isHome={isHome} busy={busy !== null} onToggle={onToggle} />
              ))}
            </ul>
          </>
        )}
      </div>
      <Toast message={toast?.message ?? null} tone={toast?.tone} onDismiss={dismiss} />
    </Section>
  );
}
