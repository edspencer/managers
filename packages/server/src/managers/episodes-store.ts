/**
 * episodes-store — the episodic log (plan §4): append-only Markdown blocks in
 * `objectives/<slug>/journal/YYYY-MM.md` (episodes tied to an objective) and
 * `log/YYYY-MM.md` (project-level episodes). One block per entry:
 *
 * ```markdown
 * ## 2026-09-26 07:04Z · ep-260926-0704-c7 · imp 6 · run r-260926-0700-k3 · #dispatch #issues
 * Dispatched keeper chat for widget-lib#412 (templated triage). Awaiting result.
 * refs: widget-lib#412, t-260926-7k3f
 * ```
 *
 * The header is `date time · id · imp N`, then optional ` · `-separated
 * segments in any order: `run <id>`, `chat <session>`, `source <who>`, and one
 * segment of `#tags`. A trailing `refs:` line lists references. Anything before
 * the first `## ` line (a file title) is ignored; a `## ` line that does not
 * match the header grammar is reported as a `parseError` and its block skipped.
 *
 * Reads only in M4 (M5 appends through the write queue using
 * {@link formatEpisode}).
 */
import path from "node:path";
import type { WorkspaceLayout } from "./layout.js";
import { MONTH_RE, isName } from "./layout.js";
import type { EpisodeWrite } from "./schemas.js";
import { FileCache, listNames, readdirSafe, type ParseError, type Parsed } from "./store-util.js";

/** The header grammar. Groups: date, HH, MM, id, importance, rest-of-line. */
export const EPISODE_HEADER_RE =
  /^## (\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2})Z\s+·\s+(ep-[a-z0-9-]+)\s+·\s+imp (\d{1,2})((?:\s+·\s+.*)?)$/;

export interface Episode {
  id: string;
  /** `YYYY-MM-DDTHH:MM:00Z`. */
  at: string;
  importance: number;
  run: string | null;
  chat: string | null;
  source: string | null;
  tags: string[];
  text: string;
  refs: string[];
  /** The objective whose journal holds it; `null` for the project log. */
  objective: string | null;
  /** Workspace-relative file. */
  file: string;
  /** 1-based line of the header. */
  line: number;
}

type ParsedEntry = Omit<Episode, "objective" | "file">;

export interface ParsedEpisodeFile {
  entries: ParsedEntry[];
  errors: { line: number; error: string }[];
}

/** Parse one journal/log file's text. Never throws. */
export function parseEpisodeFile(text: string): ParsedEpisodeFile {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const entries: ParsedEntry[] = [];
  const errors: { line: number; error: string }[] = [];
  let cur: { head: ParsedEntry; body: string[] } | null = null;
  let skipping = false;
  const flush = () => {
    if (!cur) return;
    const body = [...cur.body];
    while (body.length && body[body.length - 1]!.trim() === "") body.pop();
    let refs: string[] = [];
    const last = body[body.length - 1];
    if (last !== undefined && /^refs:\s*/i.test(last)) {
      refs = last
        .replace(/^refs:\s*/i, "")
        .split(/[,\s]+/)
        .map((r) => r.trim())
        .filter(Boolean);
      body.pop();
    }
    while (body.length && body[0]!.trim() === "") body.shift();
    const text = body.join("\n").trimEnd();
    if (!text) errors.push({ line: cur.head.line, error: `episode ${cur.head.id} has no text` });
    else entries.push({ ...cur.head, text, refs });
    cur = null;
  };
  lines.forEach((line, i) => {
    if (line.startsWith("## ")) {
      flush();
      const head = parseEpisodeHeader(line, i + 1);
      if (typeof head === "string") {
        errors.push({ line: i + 1, error: head });
        skipping = true;
      } else {
        cur = { head, body: [] };
        skipping = false;
      }
      return;
    }
    if (cur && !skipping) (cur as { body: string[] }).body.push(line);
  });
  flush();
  return { entries, errors };
}

/** Parse one header line, or return why it is not a valid header. */
export function parseEpisodeHeader(line: string, lineNo = 1): ParsedEntry | string {
  const m = EPISODE_HEADER_RE.exec(line.trimEnd());
  if (!m) return `not an episode header: ${JSON.stringify(line.slice(0, 80))}`;
  const [, date, hh, mm, id, imp, rest] = m;
  const importance = Number(imp);
  if (importance < 1 || importance > 10) return `importance ${imp} is outside 1–10`;
  if (Number(hh) > 23 || Number(mm) > 59) return `bad time ${hh}:${mm}`;
  const at = `${date}T${hh}:${mm}:00Z`;
  if (Number.isNaN(Date.parse(at))) return `bad date ${date}`;
  const out: ParsedEntry = {
    id: id!,
    at,
    importance,
    run: null,
    chat: null,
    source: null,
    tags: [],
    text: "",
    refs: [],
    line: lineNo,
  };
  for (const seg of (rest ?? "").split(/\s+·\s+/).map((s) => s.trim()).filter(Boolean)) {
    const kv = /^(run|chat|source)\s+(\S+)$/.exec(seg);
    if (kv) {
      out[kv[1] as "run" | "chat" | "source"] = kv[2]!;
    } else if (seg.startsWith("#")) {
      out.tags.push(
        ...seg
          .split(/\s+/)
          .filter((t) => t.startsWith("#") && t.length > 1)
          .map((t) => t.slice(1)),
      );
    }
    // Unknown segments are tolerated (lenient read) and dropped.
  }
  return out;
}

/** Render one episode block (header, text, optional refs line), newline-terminated. */
export function formatEpisode(e: EpisodeWrite): string {
  const d = new Date(e.at);
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}Z`;
  const segs = [stamp, e.id, `imp ${e.importance}`];
  if (e.run) segs.push(`run ${e.run}`);
  if (e.chat) segs.push(`chat ${e.chat}`);
  if (e.source) segs.push(`source ${e.source}`);
  if (e.tags.length) segs.push(e.tags.map((t) => `#${t}`).join(" "));
  const lines = [`## ${segs.join(" · ")}`, e.text.trim()];
  if (e.refs.length) lines.push(`refs: ${e.refs.join(", ")}`);
  return `${lines.join("\n")}\n`;
}

export interface EpisodePage {
  /** Newest first. */
  entries: Episode[];
  /** The month files this page covers, newest first. */
  months: string[];
  /** Pass as `before` for the next (older) page; `null` when there is none. */
  nextBefore: string | null;
  parseErrors: ParseError[];
}

export interface PageOpts {
  /** Only months strictly before this `YYYY-MM`. */
  before?: string;
  /** How many month files per page (default 3). */
  months?: number;
}

export const DEFAULT_PAGE_MONTHS = 3;
export const MAX_PAGE_MONTHS = 24;

/** Choose the page's months from a newest-first list. Shared with runs-store. */
export function pickMonths(all: string[], opts: PageOpts): { months: string[]; nextBefore: string | null } {
  const n = Math.min(Math.max(1, opts.months ?? DEFAULT_PAGE_MONTHS), MAX_PAGE_MONTHS);
  const eligible = opts.before ? all.filter((m) => m < opts.before!) : all;
  const months = eligible.slice(0, n);
  return { months, nextBefore: eligible.length > n ? months[months.length - 1]! : null };
}

const byNewest = (a: Episode, b: Episode) =>
  a.at < b.at ? 1 : a.at > b.at ? -1 : a.file === b.file ? b.line - a.line : a.file < b.file ? 1 : -1;

export class EpisodesStore {
  private readonly cache = new FileCache<ParsedEpisodeFile>((text) => ({
    ok: true,
    value: parseEpisodeFile(text),
  }));

  /** Month files (newest first) for an objective's journal, or the log when `objective` is null. */
  async months(layout: WorkspaceLayout, objective: string | null): Promise<string[]> {
    const dir = objective === null ? layout.logDir : layout.journalDir(objective);
    return (await listNames(dir, ".md")).filter((m) => MONTH_RE.test(m)).sort().reverse();
  }

  /** Every episode in one month file, with its parse errors. */
  async readMonth(
    layout: WorkspaceLayout,
    objective: string | null,
    month: string,
  ): Promise<{ entries: Episode[]; parseErrors: ParseError[] }> {
    const abs = objective === null ? layout.logFile(month) : layout.journalFile(objective, month);
    const got = await this.cache.get(abs);
    if (!got) return { entries: [], parseErrors: [] };
    return this.decorate(layout, abs, objective, got);
  }

  /** One page of an objective's journal (or the project log), paged by month. */
  async page(layout: WorkspaceLayout, objective: string | null, opts: PageOpts = {}): Promise<EpisodePage> {
    const { months, nextBefore } = pickMonths(await this.months(layout, objective), opts);
    const entries: Episode[] = [];
    const parseErrors: ParseError[] = [];
    for (const m of months) {
      const r = await this.readMonth(layout, objective, m);
      entries.push(...r.entries);
      parseErrors.push(...r.parseErrors);
    }
    entries.sort(byNewest);
    return { entries, months, nextBefore, parseErrors };
  }

  /**
   * The `id → {file, line}` index over every journal and log file in the
   * workspace. Each file's parse is mtime-cached, so rebuilding the index after
   * one file changes re-reads only that file.
   */
  async index(layout: WorkspaceLayout): Promise<Map<string, { file: string; line: number; anchor: string }>> {
    const idx = new Map<string, { file: string; line: number; anchor: string }>();
    for (const { abs } of await this.allFiles(layout)) {
      const got = await this.cache.get(abs);
      if (!got?.ok) continue;
      for (const e of got.value.entries) {
        if (!idx.has(e.id)) idx.set(e.id, { file: layout.rel(abs), line: e.line, anchor: e.id });
      }
    }
    return idx;
  }

  /** Look one episode up by id. */
  async get(layout: WorkspaceLayout, id: string): Promise<Episode | null> {
    for (const { abs, objective } of await this.allFiles(layout)) {
      const got = await this.cache.get(abs);
      if (!got?.ok) continue;
      const hit = got.value.entries.find((e) => e.id === id);
      if (hit) return { ...hit, objective, file: layout.rel(abs) };
    }
    return null;
  }

  /**
   * M14: every episode in the workspace (the log and every journal) at or after
   * `sinceMs`, newest first. Only month files from `sinceMs`'s month on are read.
   */
  async since(layout: WorkspaceLayout, sinceMs: number): Promise<Episode[]> {
    const from = new Date(Number.isFinite(sinceMs) ? sinceMs : 0).toISOString().slice(0, 7);
    const out: Episode[] = [];
    for (const { abs, objective } of await this.allFiles(layout)) {
      const month = path.basename(abs, ".md");
      if (month < from) continue;
      const got = await this.cache.get(abs);
      if (!got) continue;
      for (const e of this.decorate(layout, abs, objective, got).entries) {
        if (Date.parse(e.at) >= sinceMs) out.push(e);
      }
    }
    return out.sort(byNewest);
  }

  private async allFiles(layout: WorkspaceLayout): Promise<{ abs: string; objective: string | null }[]> {
    const out: { abs: string; objective: string | null }[] = [];
    for (const m of await this.months(layout, null)) out.push({ abs: layout.logFile(m), objective: null });
    for (const d of await readdirSafe(layout.objectivesDir)) {
      if (!d.isDirectory() || !isName(d.name)) continue;
      for (const m of await this.months(layout, d.name)) {
        out.push({ abs: layout.journalFile(d.name, m), objective: d.name });
      }
    }
    return out;
  }

  private decorate(
    layout: WorkspaceLayout,
    abs: string,
    objective: string | null,
    got: Parsed<ParsedEpisodeFile>,
  ): { entries: Episode[]; parseErrors: ParseError[] } {
    const file = layout.rel(abs);
    if (!got.ok) return { entries: [], parseErrors: [{ file, error: got.error }] };
    return {
      entries: got.value.entries.map((e) => ({ ...e, objective, file })),
      parseErrors: got.value.errors.map((e) => ({ file, line: e.line, error: e.error })),
    };
  }
}
