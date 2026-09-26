/**
 * frontmatter — `---\n<yaml>\n---\n<body>` documents, via the existing `yaml`
 * dependency.
 *
 * `parseFrontmatter` is lenient about the envelope (CRLF, a BOM, no frontmatter
 * at all) but throws {@link FrontmatterError} for YAML that does not parse or
 * is not a mapping — callers turn that into a `parseError` entry. Validation of
 * the mapping's CONTENT is `schemas.ts`'s job.
 */
import YAML from "yaml";

export class FrontmatterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FrontmatterError";
  }
}

export interface ParsedDocument {
  /** The frontmatter mapping; `{}` when the document has none. */
  data: Record<string, unknown>;
  /** Everything after the closing `---` (or the whole text when none). */
  body: string;
  /** Whether a frontmatter block was present at all. */
  hasFrontmatter: boolean;
}

const OPEN_RE = /^---[ \t]*\n/;
const CLOSE_RE = /^---[ \t]*$/m;

/** Strip a BOM and normalise CRLF so every other rule can assume `\n`. */
function normalise(text: string): string {
  return (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).replace(/\r\n?/g, "\n");
}

/**
 * Deep-convert YAML-produced `Date`s to ISO strings. The core schema we parse
 * with does not produce them, but a `!!timestamp` tag would; DTOs are JSON.
 */
function plain(v: unknown): unknown {
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map(plain);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]));
  }
  return v;
}

export function parseFrontmatter(text: string): ParsedDocument {
  const src = normalise(text);
  if (!OPEN_RE.test(src)) return { data: {}, body: src, hasFrontmatter: false };
  const afterOpen = src.replace(OPEN_RE, "");
  const close = CLOSE_RE.exec(afterOpen);
  if (!close) throw new FrontmatterError("frontmatter is not closed (no second `---` line)");
  const yamlText = afterOpen.slice(0, close.index);
  let body = afterOpen.slice(close.index + close[0].length);
  if (body.startsWith("\n")) body = body.slice(1);
  let data: unknown;
  try {
    data = YAML.parse(yamlText, { schema: "core" });
  } catch (err) {
    throw new FrontmatterError(`frontmatter YAML: ${(err as Error).message.split("\n")[0]}`);
  }
  if (data === null || data === undefined) data = {};
  if (typeof data !== "object" || Array.isArray(data)) {
    throw new FrontmatterError("frontmatter is not a YAML mapping");
  }
  return { data: plain(data) as Record<string, unknown>, body, hasFrontmatter: true };
}

/**
 * Serialise `data` + `body` back to a document. Keys keep their insertion order;
 * `undefined` values are dropped (YAML has no spelling for them). The body is
 * written verbatim, and the document always ends with a newline.
 */
export function stringifyFrontmatter(data: Record<string, unknown>, body: string): string {
  const clean = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined));
  const yamlText = YAML.stringify(clean, { lineWidth: 0 }).replace(/\n$/, "");
  const b = body.length === 0 || body.endsWith("\n") ? body : `${body}\n`;
  return `---\n${yamlText}\n---\n${b}`;
}
