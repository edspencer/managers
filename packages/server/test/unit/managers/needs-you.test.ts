import { describe, it, expect } from "vitest";
import {
  STATUS_STALE_MS,
  describeError,
  orderGroups,
  statusOf,
  type NeedsYouEntry,
  type NeedsYouGroup,
} from "../../../src/managers/needs-you.js";

const group = (slug: string, over: Partial<NeedsYouGroup> = {}): NeedsYouGroup => ({
  slug,
  name: slug.toUpperCase() || "Home",
  needsYou: [],
  alerts: [],
  status: { generated: null, stale: false },
  parseErrors: [],
  ...over,
});
const ask = (updated: string | null, created: string | null = null) =>
  ({ id: "t", updated, created }) as unknown as NeedsYouGroup["needsYou"][number];
const alert = (severity: "error" | "warning" | "info") =>
  ({ id: severity, severity }) as unknown as NeedsYouGroup["alerts"][number];

describe("needs-you: orderGroups", () => {
  it("asks (longest-waiting first) → errors → alert-only (worst first) → quiet, ties by name", () => {
    const entries: NeedsYouEntry[] = [
      group("quiet-b"),
      group("info-only", { alerts: [alert("info")] }),
      { slug: "broken", name: "Broken", error: "x" },
      group("newer-ask", { needsYou: [ask("2026-09-26T00:00:00Z")] }),
      group("error-alert", { alerts: [alert("warning"), alert("error")] }),
      group("quiet-a"),
      group("older-ask", { needsYou: [ask("2026-09-27T00:00:00Z"), ask(null, "2026-09-01T00:00:00Z")] }),
      group("parse-only", { parseErrors: [{ file: "f", error: "e" }] }),
    ];
    expect(orderGroups(entries).map((e) => e.slug)).toEqual([
      "older-ask",
      "newer-ask",
      "broken",
      "error-alert",
      "info-only",
      "parse-only",
      "quiet-a",
      "quiet-b",
    ]);
  });
});

describe("needs-you: statusOf", () => {
  const now = new Date("2026-09-27T12:00:00Z");
  it("is stale only past the threshold, and never without a report", () => {
    expect(statusOf(null, now)).toEqual({ generated: null, stale: false });
    expect(statusOf(new Date(now.getTime() - STATUS_STALE_MS + 1000).toISOString(), now).stale).toBe(false);
    expect(statusOf(new Date(now.getTime() - STATUS_STALE_MS - 1000).toISOString(), now).stale).toBe(true);
    expect(statusOf("not a date", now).stale).toBe(false);
  });
});

describe("needs-you: describeError", () => {
  it("rewrites fs paths relative to the workspace and hides outside paths", () => {
    const e = Object.assign(new Error("ENOTDIR: not a directory, scandir '/srv/data/p/tasks/open'"), {
      code: "ENOTDIR",
      path: "/srv/data/p/tasks/open",
    });
    expect(describeError(e, "/srv/data/p")).toBe("ENOTDIR: cannot read tasks/open");
    const out = Object.assign(new Error("x"), { code: "EACCES", path: "/etc/secret" });
    expect(describeError(out, "/srv/data/p")).toBe("EACCES: cannot read (outside the project)");
    expect(describeError(new Error("bad thing in /srv/data/p/runs/x.yaml"), "/srv/data/p")).toBe("bad thing in runs/x.yaml");
  });
});
