import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HISTORY_LINES } from "@bazhen/protocol";
import { Daemon, waitUntil, type View } from "./daemon.ts";
import { captured, replay } from "./fixtures/browser.ts";

const size = { cols: 100, rows: 30 };

let daemon: Daemon;
beforeAll(async () => {
  daemon = await Daemon.start();
});
afterAll(async () => {
  await daemon?.stop();
});

/** A view that has received its snapshot and so shows the terminal as it stood. */
async function opened(
  terminalId: string,
  mode: "observe" | "interactive",
  at = size,
): Promise<View> {
  const view = await daemon.view(terminalId, mode, undefined, at);
  await view.attached();
  return view;
}

/**
 * Waits until `view` shows what the terminal has on screen: a view that opens before the program
 * has drawn gets the screen as it stood, still empty.
 */
async function drawn(view: View, agentId: string, at = size): Promise<void> {
  await expect
    .poll(async () => (await replay(view.received(), at)).screen)
    .toEqual(captured(await daemon.screen(agentId)));
}

/** The numbers of every `n <number>` line a view shows. */
async function numbers(view: View): Promise<number[]> {
  const { lines } = await replay(view.received(), size);
  return lines.flatMap((line) => {
    const match = /^n (\d+)$/.exec(line);
    return match === null ? [] : [Number(match[1])];
  });
}

describe("what a view shows when it opens", () => {
  it.each([
    ["a full region", ""],
    ["a partial region", "\\033[2;4r"],
  ])("restores %s after a taller interactive view sizes an existing stream", async (_, region) => {
    const { agentId, terminalId } = await daemon.program([
      "sh",
      "-c",
      `while [ "$(stty size)" != "5 40" ]; do sleep 0.05; done; stty -echo; seq 20; printf '${region}\\033[5;1Hready'; read -r line; printf '\\033[1A\\rredraw\\033[2B\\r\\ninput\\033[4;1H\\r\\nfinished'; sleep 600`,
    ]);
    const first = await opened(terminalId, "interactive", { cols: 40, rows: 5 });
    await expect.poll(() => daemon.screen(agentId)).toContain("ready");
    const taller = { cols: 40, rows: 10 };
    const driver = await opened(terminalId, "interactive", taller);
    await driver.drive();
    driver.type("\r");
    await expect.poll(() => driver.output()).toContain("finished");
    const shown = await replay(driver.received(), taller);
    expect([shown.screen, shown.cursor]).toEqual([
      captured(await daemon.screen(agentId)),
      await daemon.cursor(agentId),
    ]);
    first.close();
    driver.close();
  });

  it("shows all the history the terminal holds above the screen, with the cursor where it is", async () => {
    const { agentId, terminalId } = await daemon.program([
      "sh",
      "-c",
      `seq -f "line %.0f" 1 ${HISTORY_LINES + 1000}; printf "prompt> "; sleep 600`,
    ]);
    await waitUntil(
      async () => (await daemon.screen(agentId)).includes("prompt>"),
      "the program's output",
    );
    const first = await opened(terminalId, "interactive");
    await drawn(first, agentId);
    const late = await opened(terminalId, "observe");
    const shown = await replay(late.snapshot(), size);
    expect([shown.lines, shown.cursor]).toEqual([
      captured(await daemon.screen(agentId, HISTORY_LINES)),
      await daemon.cursor(agentId),
    ]);
    // The whole history, not a part: the terminal holds HISTORY_LINES, less any lines it moved back
    // onto the screen as the view made it taller.
    expect(shown.lines.length - shown.screen.length).toBeGreaterThan(HISTORY_LINES - size.rows);
    first.close();
    late.close();
  });

  it("puts the cursor where a view open all along has it, after a full line", async () => {
    const { agentId, terminalId } = await daemon.program([
      "sh",
      "-c",
      `sleep 2; printf '%0${size.cols}d' 0; sleep 600`,
    ]);
    // Open before the program draws, so it reads the line as it is written, not from a snapshot.
    const first = await opened(terminalId, "interactive");
    await waitUntil(
      async () => (await daemon.screen(agentId)).includes("0".repeat(size.cols)),
      "the line",
    );
    await drawn(first, agentId);
    const late = await opened(terminalId, "observe");
    // The line filled the row, so the cursor waits to wrap: one past the last column, as tmux
    // reports it too, until the next character lands on the row below.
    expect([
      (await replay(late.snapshot(), size)).cursor,
      (await replay(first.received(), size)).cursor,
    ]).toEqual([
      [size.cols, 0],
      [size.cols, 0],
    ]);
    first.close();
    late.close();
  });

  it("lays out rows holding emoji and wide characters exactly as the terminal does", async () => {
    const { agentId, terminalId } = await daemon.program([
      "sh",
      "-c",
      "sleep 2; printf 'a😀b  c\\n日本語x\\nflag 🇯🇵 end\\n\\033[4;10Hmoved'; sleep 600",
    ]);
    // Open before the program draws: what it shows is the output itself, read as a browser reads
    // it, which the terminal's screen and a later view's snapshot must both match.
    const first = await opened(terminalId, "interactive");
    await waitUntil(async () => (await daemon.screen(agentId)).includes("moved"), "the output");
    await drawn(first, agentId);
    const late = await opened(terminalId, "observe");
    expect((await replay(late.snapshot(), size)).screen).toEqual(
      (await replay(first.received(), size)).screen,
    );
    first.close();
    late.close();
  });

  it("shows a view that opens on a busy terminal everything the first view shows, once", async () => {
    const { agentId, terminalId } = await daemon.program([
      "sh",
      "-c",
      'i=0; while [ $i -lt 1500 ]; do i=$((i+1)); echo "n $i"; sleep 0.002; done; echo done; sleep 600',
    ]);
    const first = await opened(terminalId, "interactive");
    // The history, not the screen: at 2 ms a line, "n 300" is on screen for less than a poll.
    await waitUntil(
      async () => (await daemon.screen(agentId, 2000)).includes("n 300\n"),
      "the program to be busy",
    );
    const late = await opened(terminalId, "observe");
    await waitUntil(
      async () => (await daemon.screen(agentId)).includes("done"),
      "the program to finish",
    );
    await expect.poll(async () => (await replay(late.received(), size)).screen).toContain("done");
    const [early, joined] = [await numbers(first), await numbers(late)];
    expect([joined, new Set(joined).size]).toEqual([early, joined.length]);
    first.close();
    late.close();
  });

  it("keeps the mouse protocol the program set for a view that opens later", async () => {
    const { agentId, terminalId } = await daemon.program([
      "sh",
      "-c",
      "printf '\\033[?1000h\\033[?1006hmouse on'; sleep 600",
    ]);
    await waitUntil(async () => (await daemon.screen(agentId)).includes("mouse on"), "the program");
    const first = await opened(terminalId, "interactive");
    await drawn(first, agentId);
    await expect.poll(() => first.output()).toContain("\x1b[?1006h");
    const late = await opened(terminalId, "observe");
    expect(late.snapshot().toString("latin1")).toContain("\x1b[?1006h");
    first.close();
    late.close();
  });

  it("shows the screen at the driver's size after the driver resizes it", async () => {
    const { agentId, terminalId } = await daemon.program([
      "sh",
      "-c",
      [
        'draw() { set -- $(stty size); printf "\\033[2J\\033[$1;70Hbottom of $1 rows"; }',
        "trap draw WINCH; draw; while :; do sleep 1; done",
      ].join("; "),
    ]);
    const phone = await opened(terminalId, "interactive", { cols: 60, rows: 20 });
    const laptop = await opened(terminalId, "interactive");
    await laptop.drive();
    await waitUntil(
      async () => (await daemon.screen(agentId)).includes("bottom of 30 rows"),
      "the redraw",
    );
    await drawn(laptop, agentId);
    const late = await opened(terminalId, "observe");
    expect((await replay(late.snapshot(), size)).screen).toEqual(
      captured(await daemon.screen(agentId)),
    );
    phone.close();
    laptop.close();
    late.close();
  });
});
