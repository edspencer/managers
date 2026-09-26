/**
 * reports-store — `reports/<type>/current.md` plus `reports/<type>/YYYY-MM-DD.md`
 * (plan §4). The last write of a day wins its dated file; git keeps the
 * intraday history. Reads only in M4 (`write_report` lands in M5, its
 * post-processing in M10).
 *
 * Report frontmatter is optional and free-form until M10 defines the `status`
 * type, so it is returned as-is; a report whose frontmatter will not parse is
 * still served, with the whole text as its body and a `parseError`.
 */
import { promises as fs } from "node:fs";
import { DATE_RE, isName, type WorkspaceLayout } from "./layout.js";
import { parseFrontmatter } from "./frontmatter.js";
import { FileCache, listNames, readdirSafe, type ParseError, type Parsed } from "./store-util.js";

export interface ReportDoc {
  type: string;
  /** The dated file's date; `null` for `current.md`. */
  date: string | null;
  file: string;
  frontmatter: Record<string, unknown>;
  /** First `# ` heading of the body, if any. */
  title: string | null;
  body: string;
  /** Frontmatter `updated`/`generated` if present, else the file's mtime (ISO). */
  updated: string;
  parseError: ParseError | null;
}

export interface ReportTypeSummary {
  type: string;
  /** `current.md`, without its body. */
  current: Omit<ReportDoc, "body"> | null;
  /** Dated reports on disk, newest first. */
  dates: string[];
}

interface ParsedReport {
  frontmatter: Record<string, unknown>;
  body: string;
  error: string | null;
}

function parseReport(text: string): Parsed<ParsedReport> {
  try {
    const doc = parseFrontmatter(text);
    return { ok: true, value: { frontmatter: doc.data, body: doc.body, error: null } };
  } catch (err) {
    return { ok: true, value: { frontmatter: {}, body: text, error: (err as Error).message } };
  }
}

export class ReportsStore {
  private readonly cache = new FileCache<ParsedReport>(parseReport);

  async types(layout: WorkspaceLayout): Promise<string[]> {
    return (await readdirSafe(layout.reportsDir))
      .filter((e) => e.isDirectory() && isName(e.name))
      .map((e) => e.name)
      .sort();
  }

  async dates(layout: WorkspaceLayout, type: string): Promise<string[]> {
    return (await listNames(layout.reportTypeDir(type), ".md")).filter((d) => DATE_RE.test(d)).sort().reverse();
  }

  async list(layout: WorkspaceLayout): Promise<{ reports: ReportTypeSummary[] }> {
    const reports: ReportTypeSummary[] = [];
    for (const type of await this.types(layout)) {
      const cur = await this.read(layout, type, null);
      let current: ReportTypeSummary["current"] = null;
      if (cur) {
        const { body: _body, ...rest } = cur;
        current = rest;
      }
      reports.push({ type, current, dates: await this.dates(layout, type) });
    }
    return { reports };
  }

  /** Whether a type directory exists. */
  async hasType(layout: WorkspaceLayout, type: string): Promise<boolean> {
    return (await this.types(layout)).includes(type);
  }

  /** `current.md` when `date` is null, else the dated file. `null` when absent. */
  async read(layout: WorkspaceLayout, type: string, date: string | null): Promise<ReportDoc | null> {
    const abs = date === null ? layout.reportCurrentFile(type) : layout.reportDatedFile(type, date);
    const got = await this.cache.get(abs);
    if (!got || !got.ok) return null;
    const { frontmatter, body, error } = got.value;
    const h = /^#\s+(.+)$/m.exec(body);
    const fmUpdated = frontmatter.updated ?? frontmatter.generated;
    let updated = typeof fmUpdated === "string" && fmUpdated ? fmUpdated : null;
    if (!updated) {
      const st = await fs.stat(abs).catch(() => null);
      updated = st ? st.mtime.toISOString() : new Date(0).toISOString();
    }
    const file = layout.rel(abs);
    return {
      type,
      date,
      file,
      frontmatter,
      title: h ? h[1]!.trim() : null,
      body,
      updated,
      parseError: error ? { file, error } : null,
    };
  }
}

