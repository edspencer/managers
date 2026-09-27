/**
 * memory-index — the generated half of `memory/MEMORY.md` (M14, plan §5 M14).
 *
 * `MEMORY.md` is Ed's preamble, the marker `<!-- managers:index -->`, then an
 * index of the workspace's facts the server regenerates after every `memory_op`
 * write. Everything above the marker is Ed's and is kept byte for byte; a file
 * without the marker is all preamble, and gains the marker at its end.
 *
 * The index is DETERMINISTIC (facts in, text out, `today` injected):
 *
 *   ## <type>            one section per fact type, in FACT_TYPES order,
 *   - [[name]]: …        active facts only, by name
 *   ## Superseded        facts whose `until` has passed, newest `until` first
 *
 * It is budgeted — at most {@link INDEX_MAX_LINES} lines below the marker and
 * {@link MEMORY_FILE_MAX_BYTES} for the whole file — because the briefing loads
 * the file whole into every wake. Over budget, entries are dropped in a fixed
 * order (superseded before active, then lowest confidence, then oldest `since`,
 * then name) and a note says how many are not listed. The facts themselves are
 * never touched: the index is only a table of contents.
 */
import { MEMORY_INDEX_MARKER } from "./layout.js";
import { FACT_TYPES, type FactFrontmatter } from "./schemas.js";

export const INDEX_MAX_LINES = 150;
export const MEMORY_FILE_MAX_BYTES = 20 * 1024;

export const DEFAULT_MEMORY_PREAMBLE =
  "# Memory\n\nWhat this manager has learned. Write your own notes above the marker below; the list under it is generated from `memory/facts/`.";

type IndexFact = Pick<FactFrontmatter, "name" | "description" | "type" | "since" | "until" | "confidence">;

const day = (s: string | null | undefined): string => (s ? s.slice(0, 10) : "");

/** Superseded = an `until` that is today or earlier (the Memory tab's rule). */
export function isSupersededFact(f: Pick<IndexFact, "until">, today: string): boolean {
  return !!f.until && day(f.until) <= today;
}

const CONFIDENCE_RANK: Record<string, number> = { low: 0, medium: 1, high: 2 };

function oneLine(s: string, max = 240): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

function entry(f: IndexFact, superseded: boolean): string {
  const bits = [f.confidence ?? null, superseded ? (f.until ? `until ${day(f.until)}` : null) : f.since ? `since ${day(f.since)}` : null]
    .filter(Boolean)
    .join(", ");
  return `- [[${f.name}]]: ${oneLine(f.description ?? f.name)}${bits ? ` (${bits})` : ""}`;
}

/** Drop order: superseded first, then lowest confidence, oldest `since`, then name. Earlier = dropped sooner. */
function dropOrder(a: { f: IndexFact; sup: boolean }, b: { f: IndexFact; sup: boolean }): number {
  if (a.sup !== b.sup) return a.sup ? -1 : 1;
  const ca = CONFIDENCE_RANK[a.f.confidence ?? "medium"] ?? 1;
  const cb = CONFIDENCE_RANK[b.f.confidence ?? "medium"] ?? 1;
  if (ca !== cb) return ca - cb;
  const sa = day(a.sup ? a.f.until : a.f.since);
  const sb = day(b.sup ? b.f.until : b.f.since);
  if (sa !== sb) return sa < sb ? -1 : 1;
  return a.f.name.localeCompare(b.f.name);
}

function render(kept: { f: IndexFact; sup: boolean }[], dropped: number): string[] {
  // No extra comment line: the Files viewer renders HTML comments as text, and
  // the marker already says what follows it.
  const lines: string[] = [];
  const active = kept.filter((k) => !k.sup);
  for (const type of FACT_TYPES) {
    const group = active.filter((k) => k.f.type === type).sort((a, b) => a.f.name.localeCompare(b.f.name));
    if (group.length === 0) continue;
    lines.push("", `## ${type}`, ...group.map((k) => entry(k.f, false)));
  }
  if (active.length === 0) lines.push("", "(no active facts)");
  if (lines[0] === "") lines.shift();
  const sup = kept
    .filter((k) => k.sup)
    .sort((a, b) => (day(b.f.until) === day(a.f.until) ? a.f.name.localeCompare(b.f.name) : day(b.f.until) < day(a.f.until) ? -1 : 1));
  if (sup.length) lines.push("", "## Superseded", ...sup.map((k) => entry(k.f, true)));
  if (dropped > 0) {
    lines.push(
      "",
      `_${dropped} more fact${dropped === 1 ? " is" : "s are"} not listed, to keep this file small (lowest confidence and oldest first). See memory/facts/._`,
    );
  }
  return lines;
}

/** Split an existing `MEMORY.md` into Ed's preamble (kept verbatim) and the rest. */
export function memoryPreamble(existing: string | null): string {
  if (existing === null) return DEFAULT_MEMORY_PREAMBLE;
  const src = existing.replace(/\r\n?/g, "\n");
  const at = src.indexOf(MEMORY_INDEX_MARKER);
  return (at === -1 ? src : src.slice(0, at)).trimEnd();
}

/**
 * The whole regenerated `MEMORY.md`: `preamble`, the marker, the budgeted index.
 * `today` is `YYYY-MM-DD`.
 */
export function renderMemoryFile(preamble: string, facts: IndexFact[], today: string): string {
  const all = facts.map((f) => ({ f, sup: isSupersededFact(f, today) }));
  const order = [...all].sort(dropOrder);
  const compose = (lines: string[]) => `${preamble ? `${preamble}\n\n` : ""}${MEMORY_INDEX_MARKER}\n${lines.join("\n")}\n`;
  let dropped = 0;
  for (;;) {
    const gone = new Set(order.slice(0, dropped));
    const kept = all.filter((x) => !gone.has(x));
    const lines = render(kept, dropped);
    const text = compose(lines);
    const fits = lines.length <= INDEX_MAX_LINES && Buffer.byteLength(text, "utf8") <= MEMORY_FILE_MAX_BYTES;
    if (fits || dropped >= all.length) return text;
    dropped++;
  }
}
