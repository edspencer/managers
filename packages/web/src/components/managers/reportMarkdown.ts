/**
 * Report Markdown helpers (M12).
 *
 * A stored `status` report (M10) is `# <Type>: <project>, <date>`, then the
 * server-rendered `## Needs you` and `## Alerts`, then the model's body. Home's
 * status card re-renders Needs you and Alerts LIVE from the tasks and alerts
 * routes, so it shows only the rest of the stored text: {@link reportBody}
 * removes the title and those two sections (and would remove a hand-written
 * copy of them too), leaving every other section untouched.
 *
 * Fence-aware: a `## Alerts` line inside a ``` block is content, not a heading.
 */

/** The two sections the server owns (M10). */
const SERVER_SECTIONS = new Set(["needs you", "alerts"]);

/** `## Needs You:` → "needs you". */
function norm(heading: string): string {
  return heading
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** The stored report with its `# ` title and the server's sections removed. */
export function reportBody(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let fence: string | null = null;
  let skipping = false;
  let started = false;
  for (const line of lines) {
    const first = !started && line.trim() !== "";
    if (first) started = true;
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (f) {
      if (fence === null) fence = f[1]![0]!;
      else if (f[1]![0] === fence) fence = null;
      if (!skipping) out.push(line);
      continue;
    }
    if (fence === null) {
      const h1 = /^#\s+/.test(line);
      const h2 = /^##\s+(.*)$/.exec(line);
      if (h1 && first) continue; // the report's own title
      if (h1 || h2) {
        skipping = h2 ? SERVER_SECTIONS.has(norm(h2[1]!)) : false;
        if (skipping) continue;
      }
    }
    if (!skipping) out.push(line);
  }
  return out.join("\n").replace(/^\s*\n/, "").trim();
}

/** The report's `generated` time: the M10 field, else the frontmatter/file `updated`. */
export function reportGenerated(doc: { generated?: string | null; updated: string; frontmatter?: Record<string, unknown> }): string {
  const fm = doc.frontmatter?.generated;
  return doc.generated ?? (typeof fm === "string" && fm ? fm : doc.updated);
}

/** Older than this, a status report is flagged as out of date. */
export const REPORT_STALE_MS = 48 * 60 * 60 * 1000;

export function isReportStale(generated: string, now = Date.now()): boolean {
  const t = Date.parse(generated);
  return Number.isFinite(t) && now - t > REPORT_STALE_MS;
}
