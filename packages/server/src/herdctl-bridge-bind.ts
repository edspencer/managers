/**
 * Managers M14.5 (audit M9–M14 #2): bind herdctl's per-turn MCP HTTP bridge to
 * loopback.
 *
 * In `driveMode: batch`, herdctl's CLI runtime serves each turn's injected MCP
 * servers (Managers' `managers` state tools, `memory_op` included) through
 * `startMcpHttpBridge` (`@herdctl/core/dist/runner/runtime/mcp-http-bridge.js`),
 * which calls `server.listen(0, "0.0.0.0", …)` with no authentication, while the
 * CLI child is told to connect to `http://127.0.0.1:<port>/mcp`
 * (`cli-runtime.js`). So `0.0.0.0` buys nothing for the CLI runtime and exposes
 * every turn's tools to the LAN.
 *
 * herdctl 5.33 has no option for the bind host, and the function is an ES module
 * export (a read-only live binding), so it cannot be replaced from outside. The
 * narrowest seam is `http.Server.prototype.listen`: an OWN property on the
 * `http.Server` prototype (`net.Server`, `https`, `tls` are untouched) that
 * rewrites exactly `listen(0, "0.0.0.0", cb)` to `127.0.0.1` when, and only
 * when, the synchronous caller is herdctl's bridge module and NOT its Docker
 * container runner (a container must reach the host over the bridge network, so
 * that path keeps herdctl's bind). Every other `listen` call passes through
 * untouched.
 *
 * This does not add authentication: any local process that learns the port can
 * still call the tools. That is why batch mode also needs
 * `MANAGERS_ALLOW_BATCH_DRIVE=1` (boot-posture.ts). The upstream fix is drafted in
 * the Managers notes (`milestones/HERDCTL-BRIDGE-ISSUE-DRAFT.md`).
 */
import http from "node:http";

const PATCHED = Symbol.for("managers.herdctlBridgeLoopbackBind");

// `dist/…js`, or `src/…ts` when the stack is source-mapped (`--enable-source-maps`,
// vitest): the frame names herdctl's file either way.
const BRIDGE_FRAME = /@herdctl[\\/]core[\\/](?:dist|src)[\\/]runner[\\/]runtime[\\/]mcp-http-bridge\.[jt]s/;
const CONTAINER_FRAME = /@herdctl[\\/]core[\\/](?:dist|src)[\\/]runner[\\/]runtime[\\/]container-runner\.[jt]s/;

/** True when the current synchronous stack is herdctl's bridge, outside Docker. */
export function calledFromHerdctlBridge(stack: string): boolean {
  return BRIDGE_FRAME.test(stack) && !CONTAINER_FRAME.test(stack);
}

type ListenFn = (...args: unknown[]) => http.Server;

/** Install the loopback rewrite once per process (idempotent). */
export function installHerdctlBridgeLoopbackBind(): void {
  const proto = http.Server.prototype as unknown as Record<PropertyKey, unknown> & {
    listen: ListenFn;
  };
  if (proto[PATCHED]) return;
  const original = proto.listen;
  const patched: ListenFn = function (this: http.Server, ...args: unknown[]) {
    if (args[0] === 0 && args[1] === "0.0.0.0") {
      const prevLimit = Error.stackTraceLimit;
      Error.stackTraceLimit = 30;
      const stack = new Error().stack ?? "";
      Error.stackTraceLimit = prevLimit;
      if (calledFromHerdctlBridge(stack)) args[1] = "127.0.0.1";
    }
    return original.apply(this, args);
  };
  Object.defineProperty(proto, "listen", {
    value: patched,
    writable: true,
    configurable: true,
    enumerable: false,
  });
  Object.defineProperty(proto, PATCHED, { value: true });
}
