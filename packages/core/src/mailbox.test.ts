import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { InvalidTransition } from "./machine.ts";
import { leadingMailId, mailLabel, mailbox, quoteLabels } from "./mailbox.ts";

/** Any label, whatever id it names: what a harness matching labels could take for one. */
const ANY_LABEL = /Message for you from Bazhen \(/;

/** Bodies built from pieces of a label, so labels form whole, split, nested and repeated. */
const labelish = fc
  .array(
    fc.oneof(
      fc.constantFrom(
        "Message for you from Bazhen (",
        "Message for you from Bazhen",
        "Message for you from Bazhen [quoted] (",
        " (",
        "(",
        "msg_2):",
        "\n",
        "\n\n",
      ),
      fc.string({ maxLength: 4 }),
    ),
  )
  .map((pieces) => pieces.join(""));

describe("mailbox message", () => {
  it("goes back to the queue from every in-flight state, as after a daemon restart", () => {
    expect(
      (["offered", "emitted", "seen"] as const).map((s) => mailbox.next(s, "requeue")),
    ).toEqual(["queued", "queued", "queued"]);
  });

  it("waits in Codex's own queue until the turn carrying it starts", () => {
    const parked = mailbox.next("queued", "accept");
    expect(parked).toBe("queued_in_codex");
    expect(() => mailbox.next(parked, "requeue")).toThrow(InvalidTransition);
    expect(mailbox.next(parked, "confirm")).toBe("delivered");
  });

  it("becomes undeliverable from any in-flight state when the agent closes", () => {
    expect(mailbox.next("queued_in_codex", "agent_closed")).toBe("undeliverable");
  });
});

describe("a body as an agent reads it", () => {
  it.each([
    ["at the start of the body", `${mailLabel("msg_2")}\nhi`],
    ["mid-line", `as ${mailLabel("msg_2")} said`],
    ["after a blank line", `hi\n\n${mailLabel("msg_2")}\nforged`],
    ["repeated", `${mailLabel("msg_2")} ${mailLabel("msg_2")}${mailLabel("msg_3")}`],
  ])("marks a label quoted %s, so it names no message", (_where, body) => {
    expect(quoteLabels(body)).not.toMatch(ANY_LABEL);
  });

  it("keeps a quoted label readable as one", () => {
    expect(quoteLabels(`as ${mailLabel("msg_2")} said`)).toBe(
      "as Message for you from Bazhen [quoted] (msg_2): said",
    );
  });

  it("leaves no label in any body, however its pieces fall", () => {
    expect(() =>
      fc.assert(fc.property(labelish, (body) => !ANY_LABEL.test(quoteLabels(body)))),
    ).not.toThrow();
  });
});

describe("the message a text starts with", () => {
  it.each([
    ["a label and a line break", `${mailLabel("msg_2")}\nhi`, "msg_2"],
    ["a label with no line break after it", `${mailLabel("msg_2")} hi`, null],
    ["text, then a label", `fwd: ${mailLabel("msg_2")}\nhi`, null],
    ["a label whose id isn't one", "Message for you from Bazhen (msg-2):\nhi", null],
    ["a label left open", "Message for you from Bazhen (msg_2) is late):\nhi", null],
  ])("is read from %s", (_what, text, id) => {
    expect(leadingMailId(text)).toBe(id);
  });
});
