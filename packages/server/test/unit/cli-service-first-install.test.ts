/**
 * A first install the service manager refuses leaves no unit behind; a refused
 * reinstall keeps the unit it had (edspencer/cli-contract#7). Ported from the
 * contract's `test/service.test.ts`, against Managers' copies of
 * `reference/service/{launchd,systemd}.ts`.
 */
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLaunchd } from "../../src/cli/service/launchd.js";
import { createSystemd } from "../../src/cli/service/systemd.js";
import type { RunResult, Runner, ServiceIdentity, ServiceSpec } from "../../src/cli/service/manager.js";

const ID: ServiceIdentity = {
  name: "Tool",
  tool: "tool",
  label: "net.example.tool",
  unit: "tool.service",
  description: "Tool, as a service",
};

const dirs: string[] = [];
function tempDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "managers-first-install-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function spec(home: string, over: Partial<ServiceSpec> = {}): ServiceSpec {
  return {
    nodePath: "/usr/bin/node",
    scriptPath: "/usr/lib/node_modules/tool/dist/cli.js",
    args: ["serve", "--port", "7000"],
    workingDirectory: path.join(home, "service"),
    logPath: path.join(home, "logs", "service.log"),
    pathEnv: "/usr/bin",
    ...over,
  };
}

function fake(script: (cmd: string, args: string[]) => Partial<RunResult> | undefined) {
  const calls: string[] = [];
  const run: Runner = (cmd, args) => {
    calls.push(`${cmd} ${args.join(" ")}`);
    return { status: 0, stdout: "", stderr: "", ...script(cmd, args) };
  };
  return { calls, run };
}

function fakeLaunchd(bootstrapFails: number[] = []) {
  let loaded = false;
  const failures = [...bootstrapFails];
  const f = fake((_cmd, args) => {
    if (args[0] === "bootout") {
      if (!loaded) return { status: 3, stderr: "Boot-out failed: 3: No such process" };
      loaded = false;
      return {};
    }
    // A fake launchd must say "not loaded" when nothing is (C1's trap).
    if (args[0] === "print") return loaded ? { stdout: "state = running\npid = 77\n" } : { status: 113 };
    if (args[0] === "bootstrap") {
      const code = failures.shift();
      if (code !== undefined && code !== 0) return { status: code, stderr: `Bootstrap failed: ${code}` };
      loaded = true;
    }
    return {};
  });
  const home = tempDir();
  return { ...f, home, m: createLaunchd(ID, { run: f.run, homeDir: home, uid: 501, sleep: () => {} }) };
}

function fakeSystemd(enableFails = false, home = tempDir()) {
  let active = false;
  const f = fake((cmd, args) => {
    if (cmd === "loginctl") return { stdout: "" };
    const verb = args[1];
    if (verb === "enable" && enableFails) return { status: 1, stderr: "Failed to enable unit" };
    if (verb === "is-active") return { status: active ? 0 : 3, stdout: active ? "active\n" : "inactive\n" };
    if (verb === "show") return { stdout: active ? "4242\n" : "0\n" };
    if (verb === "enable" || verb === "start" || verb === "restart") active = true;
    if (verb === "stop" || verb === "disable") active = false;
    return {};
  });
  return { ...f, home, m: createSystemd(ID, { run: f.run, homeDir: home, user: "ed" }) };
}

describe("managers service: a refused first install (cli-contract#7)", () => {
  it("launchd: a refused first install leaves no plist; a refused reinstall keeps its plist", () => {
    const l = fakeLaunchd([112]);
    expect(() => l.m.install(spec(l.home))).toThrow(/launchctl bootstrap failed \(exit 112\)/);
    expect(fs.existsSync(l.m.unitPath)).toBe(false);
    expect(l.m.status().registered).toBe(false);

    const again = fakeLaunchd([0, 112]);
    again.m.install(spec(again.home));
    expect(() => again.m.install(spec(again.home, { args: ["serve", "--port", "7001"] }))).toThrow(/exit 112/);
    expect(fs.existsSync(again.m.unitPath)).toBe(true);
  });

  it("systemd: a refused first install leaves no unit; a refused reinstall keeps its unit", () => {
    const s = fakeSystemd(true);
    expect(() => s.m.install(spec(s.home))).toThrow(/systemctl --user enable --now tool.service failed \(exit 1\)/);
    expect(fs.existsSync(s.m.unitPath)).toBe(false);
    expect(s.m.status().registered).toBe(false);
    expect(s.calls.slice(-2)).toEqual(["systemctl --user disable tool.service", "systemctl --user daemon-reload"]);

    const again = fakeSystemd(false);
    again.m.install(spec(again.home));
    const refusing = fakeSystemd(true, again.home);
    expect(() => refusing.m.install(spec(again.home))).toThrow(/exit 1/);
    expect(fs.existsSync(refusing.m.unitPath)).toBe(true);
  });
});
