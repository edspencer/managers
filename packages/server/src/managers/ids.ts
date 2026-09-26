/**
 * ids — minting Managers ids (plan §2.7).
 *
 *   task     t-YYMMDD-xxxx
 *   episode  ep-YYMMDD-HHMM-xx
 *   run      r-YYMMDD-HHMM-xx
 *
 * The date/time stamp is UTC. The suffix is crypto-random base32 (RFC 4648
 * alphabet, lowercased). There is no counter file: uniqueness is checked by the
 * caller under the per-project write lock (M5) via {@link mintUnique}, which
 * regenerates on collision.
 */
import { randomBytes } from "node:crypto";

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/** `n` crypto-random base32 characters. */
export function base32Suffix(n: number): string {
  const bytes = randomBytes(n);
  let out = "";
  for (let i = 0; i < n; i++) out += BASE32[bytes[i]! & 31];
  return out;
}

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${pad(d.getUTCFullYear() % 100)}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
const hm = (d: Date) => `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`;

export function newTaskId(now: Date = new Date()): string {
  return `t-${ymd(now)}-${base32Suffix(4)}`;
}

export function newEpisodeId(now: Date = new Date()): string {
  return `ep-${ymd(now)}-${hm(now)}-${base32Suffix(2)}`;
}

export function newRunId(now: Date = new Date()): string {
  return `r-${ymd(now)}-${hm(now)}-${base32Suffix(2)}`;
}

/**
 * Mint an id that `taken` reports as free, retrying on collision. A two-char
 * suffix gives 1024 ids per minute per project, so a handful of retries is
 * plenty; running out means something is wrong and it throws rather than spin.
 */
export async function mintUnique(
  mint: () => string,
  taken: (id: string) => boolean | Promise<boolean>,
  attempts = 32,
): Promise<string> {
  for (let i = 0; i < attempts; i++) {
    const id = mint();
    if (!(await taken(id))) return id;
  }
  throw new Error(`could not mint a unique id after ${attempts} attempts`);
}
