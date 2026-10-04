/**
 * chat-turns — when each chat's previous human turn ran, per workspace.
 *
 * A chat that stays open does not see what changed in the store after its
 * briefing (an answer Ed gave on Home, a task another run moved). `ws.ts`
 * records each human turn's start and end here, and the NEXT turn of the same
 * chat is sent the delta since then (`chat-delta.ts`).
 *
 * One file per workspace, `.managers/state/chat-turns.json` (gitignored by the
 * data-repo skeleton): `{ "<sessionId>": { start, end } }`, kept to the
 * {@link CHAT_TURNS_CAP} most recently ended chats. Writes are serialised per
 * file and atomic (temp file + rename); an unreadable file reads as empty, so
 * the worst case is one turn without a delta.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

export const CHAT_TURNS_FILE = path.join(".managers", "state", "chat-turns.json");
/** How many chats a workspace remembers; the oldest by `end` are dropped. */
export const CHAT_TURNS_CAP = 500;

export interface ChatTurn {
  /** ISO timestamp the turn started (ms precision). */
  start: string;
  /** ISO timestamp the turn's foreground drive settled. */
  end: string;
  /**
   * Records already in the store at the turn's boundaries (`chat-delta.ts`
   * `seenAtStart`/`seenAtEnd`). Timestamps on disk are second- or
   * minute-precise, so the next delta opens its windows at the boundary's
   * second or minute and leaves these out rather than repeat them.
   */
  seen?: string[];
}

/** At most this many keys are kept in {@link ChatTurn.seen}. */
export const CHAT_TURN_SEEN_CAP = 400;

type TurnMap = Record<string, ChatTurn>;

function isTurn(v: unknown): v is ChatTurn {
  const t = v as Partial<ChatTurn> | null;
  return (
    !!t &&
    typeof t.start === "string" &&
    typeof t.end === "string" &&
    Number.isFinite(Date.parse(t.start)) &&
    Number.isFinite(Date.parse(t.end))
  );
}

export class ChatTurnStore {
  private chains = new Map<string, Promise<unknown>>();

  private fileOf(dir: string): string {
    return path.join(dir, CHAT_TURNS_FILE);
  }

  private async readAll(dir: string): Promise<TurnMap> {
    try {
      const raw = JSON.parse(await fs.readFile(this.fileOf(dir), "utf8")) as unknown;
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
      const out: TurnMap = {};
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        if (!isTurn(v)) continue;
        const seen = Array.isArray(v.seen) ? v.seen.filter((e): e is string => typeof e === "string") : [];
        out[k] = { start: v.start, end: v.end, ...(seen.length ? { seen } : {}) };
      }
      return out;
    } catch {
      return {};
    }
  }

  /** The chat's previous recorded turn, or null (a new chat, or one from before this existed). */
  async get(dir: string, sessionId: string): Promise<ChatTurn | null> {
    const all = await this.readAll(dir);
    return Object.prototype.hasOwnProperty.call(all, sessionId) ? all[sessionId]! : null;
  }

  /** Record a finished turn of `sessionId` (replacing its previous one). */
  record(dir: string, sessionId: string, turn: ChatTurn): Promise<void> {
    const file = this.fileOf(dir);
    const prev = this.chains.get(file) ?? Promise.resolve();
    const next = prev
      .catch(() => undefined)
      .then(async () => {
        const all = await this.readAll(dir);
        const seen = (turn.seen ?? []).slice(0, CHAT_TURN_SEEN_CAP);
        all[sessionId] = { start: turn.start, end: turn.end, ...(seen.length ? { seen } : {}) };
        const kept = Object.entries(all)
          .sort((a, b) => b[1].end.localeCompare(a[1].end) || a[0].localeCompare(b[0]))
          .slice(0, CHAT_TURNS_CAP);
        await fs.mkdir(path.dirname(file), { recursive: true });
        const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
        await fs.writeFile(tmp, `${JSON.stringify(Object.fromEntries(kept), null, 2)}\n`, "utf8");
        await fs.rename(tmp, file);
      });
    this.chains.set(file, next);
    void next.finally(() => {
      if (this.chains.get(file) === next) this.chains.delete(file);
    }).catch(() => undefined);
    return next;
  }
}
