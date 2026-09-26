/**
 * store-util — the pieces every Managers read store shares.
 *
 * {@link FileCache} is the mtime-keyed parse cache. There are no file watchers:
 * each read `stat`s the file and re-parses only when its inode, mtime, ctime or
 * size moved (the inode catches an atomic temp-file-and-rename rewrite), so an
 * edit made by git, a human or another process is picked up on the
 * very next request without a restart.
 */
import { promises as fs } from "node:fs";

/** One file the store skipped because it would not parse or validate. */
export interface ParseError {
  /** Workspace-relative path (POSIX separators). */
  file: string;
  /** 1-based line, for a malformed block inside a multi-entry file. */
  line?: number;
  error: string;
}

/** A cached parse result: either the value or why the file was rejected. */
export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

interface Entry<T> {
  ino: number;
  mtimeMs: number;
  ctimeMs: number;
  size: number;
  value: Parsed<T>;
}

export class FileCache<T> {
  private readonly entries = new Map<string, Entry<T>>();

  constructor(private readonly parse: (text: string, file: string) => Parsed<T>) {}

  /**
   * The parse of `file`, re-read only if it changed since the last call.
   * Resolves `null` when the file does not exist.
   */
  async get(file: string): Promise<Parsed<T> | null> {
    let st: import("node:fs").Stats;
    try {
      st = await fs.stat(file);
    } catch (err) {
      if (isMissing(err)) {
        this.entries.delete(file);
        return null;
      }
      throw err;
    }
    if (!st.isFile()) return null;
    const hit = this.entries.get(file);
    if (hit && hit.ino === st.ino && hit.mtimeMs === st.mtimeMs && hit.ctimeMs === st.ctimeMs && hit.size === st.size) {
      return hit.value;
    }
    let value: Parsed<T>;
    try {
      value = this.parse(await fs.readFile(file, "utf8"), file);
    } catch (err) {
      if (isMissing(err)) {
        this.entries.delete(file);
        return null;
      }
      value = { ok: false, error: (err as Error).message };
    }
    this.entries.set(file, { ino: st.ino, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, size: st.size, value });
    return value;
  }

  /** How many files are cached (tests). */
  get size(): number {
    return this.entries.size;
  }
}

export function isMissing(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** Directory entries, or `[]` when the directory does not exist. */
export async function readdirSafe(dir: string): Promise<import("node:fs").Dirent[]> {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (isMissing(err)) return [];
    throw err;
  }
}

/** File names in `dir` ending in `ext` (without the extension), sorted. */
export async function listNames(dir: string, ext: string): Promise<string[]> {
  return (await readdirSafe(dir))
    .filter((e) => e.isFile() && e.name.endsWith(ext) && !e.name.startsWith("."))
    .map((e) => e.name.slice(0, -ext.length))
    .sort();
}

/** Sub-directory names in `dir` matching `re`, newest (lexically greatest) first. */
export async function listDirsDesc(dir: string, re: RegExp): Promise<string[]> {
  return (await readdirSafe(dir))
    .filter((e) => e.isDirectory() && re.test(e.name))
    .map((e) => e.name)
    .sort()
    .reverse();
}

/**
 * Split a Markdown body on its `## ` headings. Text before the first heading is
 * the preamble. Headings inside fenced code blocks are not split on.
 */
export function splitSections(body: string): {
  preamble: string;
  sections: { heading: string; body: string }[];
} {
  const lines = body.split("\n");
  const sections: { heading: string; body: string[] }[] = [];
  const pre: string[] = [];
  let fence = false;
  for (const line of lines) {
    if (/^(```|~~~)/.test(line)) fence = !fence;
    const m = !fence && /^## +(.+?)\s*$/.exec(line);
    if (m) {
      sections.push({ heading: m[1]!, body: [] });
      continue;
    }
    (sections.length ? sections[sections.length - 1]!.body : pre).push(line);
  }
  const trim = (ls: string[]) => ls.join("\n").replace(/^\n+|\s+$/g, "");
  return {
    preamble: trim(pre),
    sections: sections.map((s) => ({ heading: s.heading, body: trim(s.body) })),
  };
}

/** A single-file read that found the file but could not parse it. */
export interface ParseFailure<E extends ParseError = ParseError> {
  parseError: E;
}

/**
 * Narrow a store's single-file result. (`"parseError" in x` does not narrow: the
 * read DTOs are loose zod objects with an index signature.)
 */
export function isParseFailure<E extends ParseError>(x: unknown): x is ParseFailure<E> {
  // Stores return a failure as an object whose ONLY key is `parseError`.
  return !!x && typeof x === "object" && Object.keys(x).length === 1 && "parseError" in x;
}
