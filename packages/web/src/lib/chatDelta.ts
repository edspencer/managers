// Mirrors the server's `<managers-delta>` prompt wrapper (server
// managers/chat-delta.ts): on a later turn of an open chat the server prepends a
// "Changed since your last turn" block to the user's message. It is for the
// manager, not for Ed, so a reloaded user bubble drops it and shows only what
// was typed.

export const DELTA_OPEN = "<managers-delta>";
const REQUEST_MARKER = "</managers-delta>\n\n";

/** The user's message without a leading delta block; anything else is returned unchanged. */
export function stripChatDelta(content: string): string {
  if (!content.startsWith(DELTA_OPEN)) return content;
  const i = content.indexOf(REQUEST_MARKER);
  return i === -1 ? content : content.slice(i + REQUEST_MARKER.length);
}
