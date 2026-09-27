/**
 * The shell's "Needs you" counts: how many asks each workspace's manager is
 * waiting on, for the sidebar pills and the fleet strip.
 *
 * One read of `GET /api/managers/needs-you` — the same endpoint Home's
 * NeedsYouPanel renders — so the pill beside a project and the group on Home
 * are the same number. Re-read on navigation (answering an ask usually means
 * moving between Home and a project), on window focus, when an ask is answered
 * anywhere in the app ({@link NEEDS_YOU_CHANGED_EVENT}), and once a minute.
 *
 * A failed read keeps the last good counts rather than zeroing them: a pill
 * that vanishes on a network blip would claim nothing needs you.
 */
import { useCallback, useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { api } from "./api";
import type { NeedsYouResponse } from "./types";

/** Fired (on `window`) after an ask is answered, so the counts re-read at once. */
export const NEEDS_YOU_CHANGED_EVENT = "managers:needs-you-changed";

export function notifyNeedsYouChanged(): void {
  window.dispatchEvent(new Event(NEEDS_YOU_CHANGED_EVENT));
}

export interface NeedsYouCounts {
  /** Workspace key (`""` is Home) -> open asks. Absent means zero. */
  bySlug: ReadonlyMap<string, number>;
  /** Every open ask across the fleet. */
  total: number;
  /** False until the first read lands (render no pill rather than a guessed 0). */
  loaded: boolean;
}

const EMPTY: NeedsYouCounts = { bySlug: new Map(), total: 0, loaded: false };
const POLL_MS = 60_000;

export function countsFrom(res: NeedsYouResponse): NeedsYouCounts {
  const bySlug = new Map<string, number>();
  for (const p of res.projects) {
    if ("error" in p) continue;
    if (p.needsYou.length > 0) bySlug.set(p.slug, p.needsYou.length);
  }
  return { bySlug, total: res.totals.needsYou, loaded: true };
}

export function useNeedsYouCounts(): NeedsYouCounts {
  const [counts, setCounts] = useState<NeedsYouCounts>(EMPTY);
  const { pathname } = useLocation();

  const load = useCallback(async () => {
    try {
      setCounts(countsFrom(await api.managersNeedsYou()));
    } catch {
      /* keep the last good counts — see the note at the top */
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, pathname]);

  useEffect(() => {
    const onChange = () => void load();
    window.addEventListener(NEEDS_YOU_CHANGED_EVENT, onChange);
    window.addEventListener("focus", onChange);
    const timer = window.setInterval(onChange, POLL_MS);
    return () => {
      window.removeEventListener(NEEDS_YOU_CHANGED_EVENT, onChange);
      window.removeEventListener("focus", onChange);
      window.clearInterval(timer);
    };
  }, [load]);

  return counts;
}
