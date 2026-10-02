import { describe, it, expect } from "vitest";
import { historyToTurn } from "./turnModel";

/**
 * A later turn of an open chat carries the server's `<managers-delta>` block
 * ("Changed since your last turn") ahead of what Ed typed. On reload the user
 * bubble shows only his message; attachments nested inside still render.
 */
const delta = "<managers-delta>\n## Changed since your last turn\n- t-261002-abcd · answered by ed\n</managers-delta>\n\n";

describe("historyToTurn: the chat delta block", () => {
  it("drops it from the user bubble", () => {
    const turn = historyToTurn({ role: "user", content: `${delta}update the objective`, timestamp: "" }, "u1");
    expect(turn).toEqual({ kind: "user", id: "u1", content: "update the objective" });
  });

  it("still parses attachments the block wraps", () => {
    const content = `${delta}<paddock-attachments>\nAttached files:\nf1\timage\tshot.png\t/x/shot.png\n</paddock-attachments>\n\nlook at this`;
    const turn = historyToTurn({ role: "user", content, timestamp: "" }, "u2");
    expect(turn).toMatchObject({
      kind: "user",
      content: "look at this",
      attachments: [{ id: "f1", kind: "image", filename: "shot.png" }],
    });
  });

  it("control: a plain message is unchanged", () => {
    const turn = historyToTurn({ role: "user", content: "plain words", timestamp: "" }, "u3");
    expect(turn).toEqual({ kind: "user", id: "u3", content: "plain words" });
  });
});
