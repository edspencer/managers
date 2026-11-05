/**
 * `managers doctor` (CLI contract SPEC §1): the spec's eight checks, then
 * Managers' own `config` and `security` (/api/security's checks folded in).
 * Every source is injected, so nothing here asks a registry, a service manager
 * or a socket.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error — the runner's plain-JS schema validator, shipped in its dist.
import { loadSchema, validate } from "@edspencer/cli-conformance/dist/src/schema.js";
import { diagnose, doctorCode, renderChecks, type DoctorInput } from "../../src/cli/doctor.js";
import type { StatusReport } from "../../src/cli/service/index.js";

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "managers-doctor-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const notInstalled = (): StatusReport => ({
  installed: false,
  running: false,
  answering: false,
  installedVersion: null,
  runningVersion: null,
  port: null,
  host: null,
  url: null,
  pid: null,
  args: [],
  unit: "/home/ed/.config/systemd/user/managers.service",
  manager: "systemd",
  log: null,
  dataDir: null,
  node: null,
  cli: null,
  linger: null,
  warnings: [],
});

/** A registry answering `latest: <version>` for the package, and nothing else. */
function registryFetch(latest: string, extra: Record<string, Response> = {}): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    for (const [suffix, res] of Object.entries(extra)) if (url.endsWith(suffix)) return res.clone();
    if (url.includes("/-/package/") && url.endsWith("/dist-tags")) {
      return new Response(JSON.stringify({ latest }), { status: 200 });
    }
    if (url.includes("@edspencer")) {
      return new Response(JSON.stringify({ name: "@edspencer/managers", version: latest, engines: { node: ">=22" } }), {
        status: 200,
      });
    }
    return new Response("nope", { status: 404 });
  }) as typeof fetch;
}

function input(over: Partial<DoctorInput> = {}): DoctorInput {
  return {
    ctx: { platform: "linux", nodePath: "/usr/bin/node", scriptPath: "/x/cli.js", packageRoot: "/x", homeDir: tmp },
    version: "0.3.1",
    dataDir: path.join(tmp, ".managers"),
    entry: path.join(tmp, "nowhere", "managers.js"),
    env: { USER: "ed" },
    nodeVersion: "22.12.0",
    engines: ">=22",
    npmGlobalRoot: () => undefined,
    registry: "http://registry.test",
    fetch: registryFetch("0.3.1"),
    isListening: async () => false,
    linger: async () => true,
    status: async () => notInstalled(),
    configProblem: async () => undefined,
    localPosture: async () => ({ kind: "answer", warnings: [] }),
    ...over,
  };
}

const ids = (checks: { id: string }[]) => checks.map((c) => c.id);

describe("managers doctor", () => {
  it("runs the spec's eight checks in order, then config and security", async () => {
    const { checks } = await diagnose(input());
    expect(ids(checks)).toEqual([
      "node-engines",
      "install-method",
      "unit",
      "running-version",
      "port",
      "linger",
      "data-home",
      "update",
      "config",
      "security",
    ]);
    expect(doctorCode(checks)).toBe(0);
  });

  it("matches the contract's doctor schema, and every failure carries a fix", async () => {
    const { checks } = await diagnose(
      input({
        nodeVersion: "20.0.0",
        isListening: async () => true, // and nothing answers health: a foreign server
        configProblem: async () => "MANAGERS_DRIVE_MODE: not a drive mode",
      }),
    );
    const doc = { ok: doctorCode(checks) === 0, version: "0.3.1", checks };
    const errors = validate(loadSchema("doctor"), doc) as unknown[];
    expect(errors).toEqual([]);
    expect(doctorCode(checks)).toBe(1);
    for (const c of checks.filter((c) => c.status === "fail")) expect(c.fix).toBeTruthy();
    expect(checks.find((c) => c.id === "node-engines")?.status).toBe("fail");
    expect(checks.find((c) => c.id === "port")?.status).toBe("fail");
    expect(checks.find((c) => c.id === "config")?.status).toBe("fail");
    // With no loadable config there's no posture to compute: skipped, not guessed.
    expect(checks.find((c) => c.id === "security")?.status).toBe("skip");
  });

  it("--offline skips the update check and asks nothing", async () => {
    const asked: string[] = [];
    const { checks } = await diagnose(
      input({
        offline: true,
        fetch: (async (u: string | URL) => {
          asked.push(String(u));
          return new Response("{}");
        }) as typeof fetch,
      }),
    );
    expect(checks.find((c) => c.id === "update")?.status).toBe("skip");
    expect(asked).toEqual([]);
  });

  it("a newer version is a warning with the command, a notice for stderr, and the shared cache", async () => {
    fs.mkdirSync(path.join(tmp, ".managers"));
    const { checks, notice } = await diagnose(input({ fetch: registryFetch("0.4.0") }));
    const update = checks.find((c) => c.id === "update")!;
    expect(update.status).toBe("warn");
    expect(update.message).toContain("0.4.0 is available");
    expect(notice).toContain("Managers 0.4.0 is available (you have 0.3.1)");
    const cache = JSON.parse(fs.readFileSync(path.join(tmp, ".managers", "update-check.json"), "utf8"));
    expect(cache).toMatchObject({ name: "managers", current: "0.3.1", target: "0.4.0", updateAvailable: true });
    expect(doctorCode(checks)).toBe(0); // warnings don't change the exit code
  });

  it("never creates the data dir to write that cache", async () => {
    await diagnose(input({ fetch: registryFetch("0.4.0") }));
    expect(fs.existsSync(path.join(tmp, ".managers"))).toBe(false);
  });

  it("an unreachable registry is a warning, not a failure", async () => {
    const { checks } = await diagnose(
      input({
        fetch: (async () => {
          throw new Error("ECONNREFUSED");
        }) as typeof fetch,
      }),
    );
    const update = checks.find((c) => c.id === "update")!;
    expect(update.status).toBe("warn");
    expect(update.fix).toContain("--offline");
    expect(doctorCode(checks)).toBe(0);
  });

  it("a unit whose Node has gone fails, with the reinstall as the fix; linger off on a service warns", async () => {
    const { checks } = await diagnose(
      input({
        linger: async () => false,
        status: async () => ({
          ...notInstalled(),
          installed: true,
          dataDir: path.join(tmp, ".managers"),
          port: 7234,
          warnings: [
            "The unit runs /home/ed/.fnm/node, which is not there any more. Re-run `managers service install`.",
            "Lingering is off, so this service stops when you log out",
          ],
        }),
      }),
    );
    const unit = checks.filter((c) => c.id === "unit");
    expect(unit).toHaveLength(1); // the linger warning has its own check
    expect(unit[0]).toMatchObject({ status: "fail" });
    expect(unit[0]!.fix).toContain("managers service install");
    expect(checks.find((c) => c.id === "linger")).toMatchObject({ status: "warn", fix: "sudo loginctl enable-linger ed" });
  });

  it("a service running an older version than the one installed fails, with a restart as the fix", async () => {
    const { checks } = await diagnose(
      input({
        isListening: async () => true,
        fetch: registryFetch("0.3.1", {
          "/api/health": new Response(JSON.stringify({ ok: true, version: "0.3.0" })),
          "/api/security": new Response(JSON.stringify({ warnings: [] })),
        }),
        status: async () => ({
          ...notInstalled(),
          installed: true,
          running: true,
          answering: true,
          url: "http://127.0.0.1:7234",
          port: 7234,
          installedVersion: "0.3.1",
          runningVersion: "0.3.0",
          dataDir: path.join(tmp, ".managers"),
        }),
      }),
    );
    expect(checks.find((c) => c.id === "running-version")).toMatchObject({
      status: "fail",
      fix: "`managers service restart`",
    });
    expect(checks.find((c) => c.id === "port")?.status).toBe("pass");
  });

  describe("security (/api/security's checks)", () => {
    const answering = (security: Response): Partial<DoctorInput> => ({
      isListening: async () => true,
      fetch: registryFetch("0.3.1", {
        "/api/health": new Response(JSON.stringify({ ok: true, version: "0.3.1" })),
        "/api/security": security,
      }),
      status: async () => ({
        ...notInstalled(),
        installed: true,
        running: true,
        answering: true,
        url: "http://127.0.0.1:7234",
        port: 7234,
        installedVersion: "0.3.1",
        runningVersion: "0.3.1",
        dataDir: path.join(tmp, ".managers"),
      }),
      // Must NOT be consulted while an instance answers: its answer is the truth.
      localPosture: async () => {
        throw new Error("asked the local config while an instance was answering");
      },
    });

    it("asks the running instance, one warning per dangerous setting", async () => {
      const { checks } = await diagnose(
        input(
          answering(
            new Response(
              JSON.stringify({
                authMode: "none",
                warnings: [
                  { code: "no-auth", title: "No authentication", detail: "agents can act as you" },
                  { code: "batch-drive", title: "Batch drive mode", detail: "turn tools are reachable" },
                ],
              }),
            ),
          ),
        ),
      );
      const sec = checks.filter((c) => c.id === "security");
      expect(sec.map((c) => c.status)).toEqual(["warn", "warn"]);
      expect(sec[0]!.message).toContain("http://127.0.0.1:7234 runs with No authentication");
      expect(sec[1]!.fix).toContain("MANAGERS_ALLOW_BATCH_DRIVE");
      expect(doctorCode(checks)).toBe(0);
    });

    it("an instance that wants authentication for it is reported as such", async () => {
      const { checks } = await diagnose(input(answering(new Response("", { status: 401 }))));
      expect(checks.find((c) => c.id === "security")).toMatchObject({ status: "pass" });
      expect(checks.find((c) => c.id === "security")!.message).toContain("requires authentication");
    });

    it("with nothing running, a configuration the server would refuse is a failure", async () => {
      const { checks } = await diagnose(
        input({ localPosture: async () => ({ kind: "refused", message: "refusing to start: MANAGERS_AUTH_MODE=none." }) }),
      );
      const sec = checks.find((c) => c.id === "security")!;
      expect(sec.status).toBe("fail");
      expect(sec.fix).toContain("MANAGERS_AUTH_MODE=jwt");
      expect(doctorCode(checks)).toBe(1);
    });

    it("with nothing running and a safe configuration, it passes", async () => {
      const { checks } = await diagnose(input());
      expect(checks.find((c) => c.id === "security")).toMatchObject({ status: "pass" });
    });
  });

  it("renders ✓ ! ✗ - with a fix line only under warnings and failures", async () => {
    const out = renderChecks([
      { id: "a", status: "pass", message: "fine", fix: "never shown" },
      { id: "b", status: "warn", message: "hmm", fix: "do x" },
      { id: "c", status: "fail", message: "bad", fix: "do y" },
      { id: "d", status: "skip", message: "n/a" },
    ]);
    expect(out).toBe("✓ fine\n! hmm\n    fix: do x\n✗ bad\n    fix: do y\n- n/a\n");
  });
});
