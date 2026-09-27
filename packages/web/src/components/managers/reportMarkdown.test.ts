import { describe, it, expect } from "vitest";
import { isReportStale, reportBody, reportGenerated } from "./reportMarkdown";

const STORED = [
  "# Status: Acme Site, 2026-09-26",
  "",
  "## Needs you",
  "- [Pick the title](/projects/acme-site/tasks#t-1) — Which title?",
  "",
  "## Alerts",
  "- warning stale:publish-check — no met run",
  "",
  "## In flight",
  "- Pricing rewrite.",
  "",
  "## Notes",
  "- Quiet week.",
].join("\n");

describe("reportBody (M12)", () => {
  it("drops the title and the server's Needs you and Alerts, keeping the rest in order", () => {
    expect(reportBody(STORED)).toBe("## In flight\n- Pricing rewrite.\n\n## Notes\n- Quiet week.");
  });

  it("matches the headings loosely (case, punctuation) and keeps a lookalike inside a fence", () => {
    const md = "## NEEDS YOU:\n- x\n## Notes\n```\n## Alerts\nnot a heading\n```\nend";
    expect(reportBody(md)).toBe("## Notes\n```\n## Alerts\nnot a heading\n```\nend");
  });

  it("keeps a body with neither section, and a later H1 ends a skipped section", () => {
    expect(reportBody("Just prose.")).toBe("Just prose.");
    expect(reportBody("## Alerts\n- a\n# Appendix\ntext")).toBe("# Appendix\ntext");
  });
});

describe("report age (M12)", () => {
  it("prefers generated, then updated", () => {
    expect(reportGenerated({ generated: "2026-09-26T07:00:00Z", updated: "x" })).toBe("2026-09-26T07:00:00Z");
    expect(reportGenerated({ generated: null, updated: "2026-09-25T07:00:00Z" })).toBe("2026-09-25T07:00:00Z");
    expect(reportGenerated({ updated: "u", frontmatter: { generated: "g" } })).toBe("g");
  });

  it("flags a report older than 48h as out of date", () => {
    const now = Date.parse("2026-09-27T12:00:00Z");
    expect(isReportStale("2026-09-27T07:00:00Z", now)).toBe(false);
    expect(isReportStale("2026-09-25T07:00:00Z", now)).toBe(true);
    expect(isReportStale("not a date", now)).toBe(false);
  });
});
