/**
 * evidence-links — a memory fact's `evidence: [ep-…]` resolved to where each
 * episode actually lives (M12), so the Memory UI can deep-link a chip to the
 * journal entry that justified the fact.
 *
 * Resolution goes through `EpisodesStore.index` (the mtime-cached id → file/line
 * map over every journal and log file of a workspace), never a scan per fact.
 *
 * WHERE to look: a fact's evidence is episodes of the workspace whose memory it
 * is. A project fact looks in that project. A ROOT (shared) fact looks in Home
 * first, then — when it is being viewed from a project — in that project, which
 * is where a cross-project consolidation would have found it. The first hit
 * wins; an id found nowhere is returned with `found: false` rather than dropped,
 * so the UI can say "not found" instead of silently showing fewer chips.
 *
 * The `href` is the web app's URL for the entry (the server already knows these
 * paths: M10's report links tasks the same way):
 *   - an objective journal entry → `<base>/objectives/<objective>#<ep>` (the
 *     objective page pages back to older months until the anchor is loaded);
 *   - a project-log entry → `<base>/files/log/<YYYY-MM>.md`, the log file in the
 *     Files tab (there is no log view with anchors in v1).
 * `<base>` is `/projects/<slug>`, or `""` for Home.
 */
import type { EpisodesStore } from "./episodes-store.js";
import type { WorkspaceLayout } from "./layout.js";

export interface EvidenceLink {
  /** The `ep-…` id as the fact lists it. */
  episode: string;
  found: boolean;
  /** The workspace key that holds it (`""` = Home), or null when not found. */
  workspace: string | null;
  /** The objective whose journal holds it; null for the project log (or not found). */
  objective: string | null;
  /** Workspace-relative file, e.g. `objectives/grow/journal/2026-09.md`. */
  file: string | null;
  line: number | null;
  /** The web app's URL for the entry; null when not found. */
  href: string | null;
}

export interface EvidenceWorkspace {
  /** Workspace key: `""` for Home, else the project slug. */
  key: string;
  layout: WorkspaceLayout;
}

type EpisodeIndex = Map<string, { file: string; line: number; anchor: string }>;

/** The web URL prefix for a workspace (mirrors the web's `viewBase`). */
export function viewBaseOf(key: string): string {
  return key === "" ? "" : `/projects/${key.split("/").map(encodeURIComponent).join("/")}`;
}

/** `objectives/<id>/journal/…` → `<id>`; anything else (the log) → null. */
export function objectiveOfFile(file: string): string | null {
  const m = /^objectives\/([^/]+)\/journal\//.exec(file);
  return m ? m[1]! : null;
}

/** The web URL of one episode given where it was found. */
export function episodeHref(workspaceKey: string, file: string, episode: string): string {
  const base = viewBaseOf(workspaceKey);
  const objective = objectiveOfFile(file);
  if (objective) return `${base}/objectives/${encodeURIComponent(objective)}#${episode}`;
  return `${base}/files/${file.split("/").map(encodeURIComponent).join("/")}`;
}

/**
 * Resolves evidence ids for many facts with one index per workspace (built lazily
 * and reused across facts in the same request).
 */
export class EvidenceResolver {
  private readonly indexes = new Map<string, Promise<EpisodeIndex>>();

  constructor(
    private readonly episodes: EpisodesStore,
    /** The workspace being viewed; null when it is Home itself. */
    private readonly project: EvidenceWorkspace | null,
    private readonly root: EvidenceWorkspace,
  ) {}

  private index(ws: EvidenceWorkspace): Promise<EpisodeIndex> {
    let got = this.indexes.get(ws.layout.dir);
    if (!got) {
      got = this.episodes.index(ws.layout);
      this.indexes.set(ws.layout.dir, got);
    }
    return got;
  }

  /** Where to look, in order, for a fact of `scope`. */
  private searchOrder(scope: "project" | "root"): EvidenceWorkspace[] {
    if (scope === "project") return this.project ? [this.project] : [];
    return this.project ? [this.root, this.project] : [this.root];
  }

  async resolve(fact: { scope: "project" | "root"; evidence: string[] }): Promise<EvidenceLink[]> {
    const order = this.searchOrder(fact.scope);
    const out: EvidenceLink[] = [];
    for (const episode of fact.evidence) {
      let link: EvidenceLink = {
        episode,
        found: false,
        workspace: null,
        objective: null,
        file: null,
        line: null,
        href: null,
      };
      for (const ws of order) {
        const hit = (await this.index(ws)).get(episode);
        if (!hit) continue;
        link = {
          episode,
          found: true,
          workspace: ws.key,
          objective: objectiveOfFile(hit.file),
          file: hit.file,
          line: hit.line,
          href: episodeHref(ws.key, hit.file, episode),
        };
        break;
      }
      out.push(link);
    }
    return out;
  }
}
