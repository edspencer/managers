/**
 * write-queue — every Managers state write is serialised per workspace (plan §2.6).
 *
 * One promise chain per key (the workspace directory). A write waits for the
 * previous write to the same workspace to settle — success OR failure — before it
 * runs, so two agents (or an agent and the UI) appending to the same journal can
 * never interleave, and id uniqueness can be checked against what is on disk.
 * Writes to different workspaces run concurrently.
 *
 * The file primitives live here too, so every writer uses the same two shapes:
 *   • {@link writeFileAtomic} — whole-file rewrites (tasks, objectives, runs,
 *     reports): a temp file in the same directory, then `rename`, so a reader
 *     (or a crash) never sees half a file;
 *   • {@link appendText} — journals and logs: `appendFile`, block-separated.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

export class WriteQueue {
  private readonly tails = new Map<string, Promise<unknown>>();

  /** Run `fn` once every earlier write queued under `key` has settled. */
  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    // The stored tail never rejects, so one failed write can't poison the chain.
    const tail = next.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return next;
  }

  /** How many keys have a write in flight (tests). */
  get pending(): number {
    return this.tails.size;
  }
}

/** Write `text` to `file` via a same-directory temp file and `rename`. */
export async function writeFileAtomic(file: string, text: string): Promise<void> {
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${randomBytes(4).toString("hex")}.tmp`);
  try {
    await fs.writeFile(tmp, text, "utf8");
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

/**
 * Append one block to a journal/log file, separated from the previous block by a
 * blank line. Creates the file (and its directory) when absent.
 */
export async function appendText(file: string, block: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  let prefix = "";
  try {
    const st = await fs.stat(file);
    if (st.size > 0) {
      const fh = await fs.open(file, "r");
      try {
        const n = Math.min(2, st.size);
        const buf = Buffer.alloc(n);
        await fh.read(buf, 0, n, st.size - n);
        const tail = buf.toString("utf8");
        prefix = tail.endsWith("\n\n") ? "" : tail.endsWith("\n") ? "\n" : "\n\n";
      } finally {
        await fh.close();
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const body = block.endsWith("\n") ? block : `${block}\n`;
  await fs.appendFile(file, prefix + body, "utf8");
}
