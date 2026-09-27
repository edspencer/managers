import type { WhatsNewEntry } from "./types";
// The live What's New list: the twelve most recent entries from the website's
// What's New page, in the same order, newest first.
//
// Two constraints govern the writing here, both from #865/#866:
//
//  1. **Read in isolation, out of order.** The Home card shows exactly ONE
//     entry, chosen at random, with nothing around it. No entry may refer to
//     another, imply a position in a list, or assume the reader has seen the
//     one above it.
//  2. **Still true today.** An entry describes a release *as it shipped*, and
//     some are later superseded on the website, which carries forward-links for
//     them. The one line kept here is deliberately the part that is still true
//     in the current version — the website entry has the full history for anyone
//     who follows the link.
//
// Screenshots and videos stay on the website. The card has no room for them.
//
// Capped at 12 by `whats-new.test.ts`, which fails the build at 13. Adding an
// entry means bumping the oldest out of `whats-new.mdx` into
// `whats-new-archive.mdx` and deleting it from here. See #866.

// The sibling PR for #865 lands `./types.js` with these exact interfaces and
// will consolidate this declaration; it did not exist on main when this file
// was written.

/** Maximum live entries. Adding a thirteenth is a build failure — see #866. */
export const WHATS_NEW_MAX = 12;

/**
 * Managers M9.5 (audit #10): EMPTY. The twelve entries inherited from the fork
 * were upstream Paddock's release notes (v0.69–v0.72), linking to
 * paddock.edspencer.net — a different product's changelog, one of which promoted
 * Discover after M3 demoted it. Managers has no releases yet. `EntryCard`
 * renders nothing for an empty list and Home drops to the Tips card alone.
 */
export const WHATS_NEW: WhatsNewEntry[] = [];
