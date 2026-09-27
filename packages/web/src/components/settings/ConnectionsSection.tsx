/**
 * The Connections settings card (Managers M9): this project's MCP connections.
 *
 * A connection is an outside system the manager may call (day one: the project's
 * Paddock `/mcp`). It is declared in THIS workspace's `project.yaml` `mcp:` block —
 * never inherited from Home, because a connection is a credential — with every
 * secret an `env:VAR` reference. This card only READS: it shows what resolved
 * (redacted url, header names, which env vars are set), and "Test connection"
 * runs `initialize` + `tools/list` against it. No value from the server's
 * environment ever reaches the browser.
 */
import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../../lib/api";
import type { ConnectionProbeResult, ManagersConnection } from "../../lib/types";
import { Button, Callout, Chip, EmptyState, Section } from "../ui";

export const CONNECTIONS_YAML_EXAMPLE = `mcp:
  paddock:
    url: https://paddock.example.com/mcp
    headers:
      Authorization: env:MANAGERS_MCP_PADDOCK_MY_PROJECT   # value: "Bearer pdk_…"
    tools: [list_projects, list_chats, read_chat, create_chat, send_message]
    description: This project's Paddock`;

function CopyButton({ text }: { text: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const flash = (next: "copied" | "failed") => {
    setState(next);
    setTimeout(() => setState("idle"), 1500);
  };
  return (
    <Button
      size="sm"
      variant="subtle"
      onClick={() => {
        // No clipboard (an insecure origin, a denied permission): say so rather than do nothing.
        if (!navigator.clipboard) return flash("failed");
        void navigator.clipboard.writeText(text).then(
          () => flash("copied"),
          () => flash("failed"),
        );
      }}
    >
      {state === "copied" ? "Copied" : state === "failed" ? "Copy failed: select the text" : "Copy snippet"}
    </Button>
  );
}

function ProbeOutcome({ r }: { r: ConnectionProbeResult }) {
  if (r.ok) {
    return (
      <Callout tone="success">
        <span data-testid={`probe-ok-${r.name}`}>
          Connected. {r.tools.length} {r.tools.length === 1 ? "tool" : "tools"}:{" "}
          <span className="font-mono">{r.tools.join(", ") || "(none)"}</span>
        </span>
      </Callout>
    );
  }
  return (
    <Callout tone="danger">
      <span data-testid={`probe-error-${r.name}`}>Test failed: {r.error ?? "unknown error"}</span>
    </Callout>
  );
}

function ConnectionRow({ slug, c }: { slug: string; c: ManagersConnection }) {
  const [probing, setProbing] = useState(false);
  const [result, setResult] = useState<ConnectionProbeResult | null>(null);

  const test = async () => {
    setProbing(true);
    setResult(null);
    try {
      setResult(await api.managersProbeConnection(slug, c.name));
    } catch (err) {
      setResult({
        name: c.name,
        ok: false,
        tools: [],
        error: err instanceof ApiError ? err.message : "the test request failed",
        ms: 0,
      });
    } finally {
      setProbing(false);
    }
  };

  return (
    <li className="px-4 py-3" data-testid={`connection-${c.name}`}>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-mono text-sm font-medium text-fg">{c.name}</span>
            {c.transport && <Chip size="sm">{c.transport}</Chip>}
            {!c.attached && (
              <Chip size="sm" tone="danger" title="The manager does not get this connection until the errors below are fixed">
                Not attached
              </Chip>
            )}
          </div>
          {c.description && <p className="mt-0.5 text-sm text-fg-muted">{c.description}</p>}
          {(c.url || c.command) && (
            <p className="mt-0.5 break-all font-mono text-xs text-fg-subtle" title="Query string and credentials are never shown">
              {c.url ?? c.command}
            </p>
          )}
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {c.envRefs.map((r) => (
              <Chip
                key={`${r.where}:${r.name}`}
                size="sm"
                tone={r.set ? "success" : "danger"}
                title={`${r.where} reads ${r.name} from the server's environment`}
              >
                env <span className="font-mono">{r.name}</span> {r.set ? "set" : "missing"}
              </Chip>
            ))}
            {c.headerKeys.length > 0 && (
              <Chip size="sm" title="Header names only; values are never shown">
                headers: {c.headerKeys.join(", ")}
              </Chip>
            )}
            <Chip size="sm" tone="info" title="The tools the manager may call on this connection">
              {c.tools ? `tools: ${c.tools.join(", ")}` : "every tool"}
            </Chip>
          </div>
          {c.errors.length > 0 && (
            <ul className="mt-1.5 space-y-0.5 text-xs text-danger">
              {c.errors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          )}
          {c.warnings.length > 0 && (
            <ul className="mt-1 space-y-0.5 text-xs text-warn">
              {c.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}
        </div>
        <div className="shrink-0 pt-0.5">
          <Button size="sm" variant="subtle" onClick={test} loading={probing}>
            Test connection
          </Button>
        </div>
      </div>
      {result && (
        <div className="mt-2">
          <ProbeOutcome r={result} />
        </div>
      )}
    </li>
  );
}

export function ConnectionsSection({ slug }: { slug: string }) {
  const isHome = slug === "";
  const [list, setList] = useState<ManagersConnection[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setList(await api.managersConnections(slug));
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : "Failed to load connections");
    }
  }, [slug]);

  useEffect(() => {
    setList(null);
    void load();
  }, [load]);

  return (
    <Section
      title="Connections"
      description="Outside systems this manager may call over MCP. Declared in project.yaml with secrets as env: references; never inherited from Home."
      flush
    >
      <div data-testid="connections-section">
        {loadError && (
          <div className="p-4">
            <Callout tone="danger">{loadError}</Callout>
          </div>
        )}
        {!list && !loadError && <p className="px-4 py-3 text-sm text-fg-subtle">Loading…</p>}
        {list && list.length === 0 && (
          <div className="px-3 py-2">
            <EmptyState
              title="No connections"
              body={`Add an mcp: block to ${isHome ? "Home's" : "this project's"} project.yaml. Put the token in the server's environment and reference it with env:, never inline.`}
              action={
                <div className="space-y-1.5">
                  <pre
                    className="overflow-x-auto rounded-md bg-surface-active px-2 py-1.5 font-mono text-2xs text-fg-muted"
                    data-testid="connections-yaml-snippet"
                  >
                    {CONNECTIONS_YAML_EXAMPLE}
                  </pre>
                  <CopyButton text={CONNECTIONS_YAML_EXAMPLE} />
                </div>
              }
            />
          </div>
        )}
        {list && list.length > 0 && (
          <ul className="divide-y divide-edge">
            {list.map((c) => (
              <ConnectionRow key={c.name} slug={slug} c={c} />
            ))}
          </ul>
        )}
      </div>
    </Section>
  );
}
