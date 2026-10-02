import { describe, it, expect } from "vitest";
import { stripChatDelta } from "./chatDelta";

describe("stripChatDelta", () => {
  it("drops a leading delta block, keeping the message", () => {
    const wrapped = "<managers-delta>\n## Changed since your last turn\n- t-1 · now open\n</managers-delta>\n\nWhat now?";
    expect(stripChatDelta(wrapped)).toBe("What now?");
  });

  it("leaves a message without one, or one that only mentions the tag, alone", () => {
    expect(stripChatDelta("plain")).toBe("plain");
    expect(stripChatDelta("about <managers-delta> tags")).toBe("about <managers-delta> tags");
    expect(stripChatDelta("<managers-delta>\ntruncated")).toBe("<managers-delta>\ntruncated");
  });
});
