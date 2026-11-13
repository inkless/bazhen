import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { TmuxServer } from "@bazhen/host-guard";
import { atBottom, onAlternateScreen, screen, status, viewportTop } from "./page.ts";

// What a person runs in a shell terminal, end to end: the page, the daemon and real tmux, with
// each program as the distribution ships it. Full-screen programs draw on the alternate screen,
// where the wheel goes to a program that asked for mouse reports, and otherwise becomes arrow
// keys, as ordinary terminals do.

const WORK = String(process.env["BZ_E2E_WORK"]);
/** A line that ends at a shell's prompt: xterm pads the rest of the row with blanks. */
const PROMPT = /[$#%>][\s\u00a0]*$/m;

/** A standalone shell in the work directory, open in the centre and driven by this page. */
async function shell(page: Page): Promise<string> {
  await page.goto("/");
  const shellId = await page.evaluate(async (cwd) => {
    const res = await fetch("/v1/shells", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ idempotencyKey: crypto.randomUUID(), cwd }),
    });
    return String(Reflect.get(Object(await res.json()), "terminalId"));
  }, WORK);
  opened.push(shellId);
  await page.goto(`/#/shell/${shellId}`);
  const pane = page.getByRole("article", { name: /^shell / });
  await pane.locator(".xterm-screen").click();
  await expect(status(pane)).toHaveText("Driving");
  await expect.poll(() => screen(page, shellId), { timeout: 15_000 }).toMatch(PROMPT);
  return shellId;
}

async function run(page: Page, line: string): Promise<void> {
  await page.keyboard.type(line);
  await page.keyboard.press("Enter");
}

/**
 * The first line the terminal shows, trimmed: what a scroll moves. Read at the top of the view,
 * not the buffer's start: tmux's redraws can push earlier lines into the page's scrollback.
 */
const topLine = async (page: Page, shellId: string) => {
  const lines = (await screen(page, shellId)).split("\n");
  return lines[await viewportTop(page, shellId)]?.trim() ?? "";
};

/**
 * Waits until the program the shell ran has ended and the shell has its terminal back, as the
 * daemon sees the foreground: a key typed sooner can still reach the exiting program.
 */
async function idle(page: Page, shellId: string): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(async (id) => {
          const state: unknown = await (await fetch("/v1/state")).json();
          const listed: unknown = Reflect.get(Object(state), "shells");
          const found: unknown = Array.isArray(listed)
            ? listed.find((s: unknown) => Reflect.get(Object(s), "id") === id)
            : undefined;
          return Reflect.get(Object(found), "foreground") === null;
        }, shellId),
      { timeout: 15_000 },
    )
    .toBe(true);
  await expect.poll(() => screen(page, shellId)).toMatch(PROMPT);
}

/**
 * Waits until the page knows the program is on its alternate screen, which only the daemon can
 * tell it: the wheel becomes arrow keys there, and before that it scrolls the page's scrollback.
 */
async function alternate(page: Page, shellId: string): Promise<void> {
  await expect.poll(() => onAlternateScreen(page, shellId), { timeout: 15_000 }).toBe(true);
}

/** The lines the terminal shows now, top to bottom, without the page's scrollback above them. */
async function visible(page: Page, shellId: string): Promise<string[]> {
  const lines = (await screen(page, shellId)).split("\n");
  return lines.slice(await viewportTop(page, shellId));
}

/** The number the program shows on its top line, as `seq`'s output scrolls: NaN for anything else. */
const topNumber = async (page: Page, shellId: string) => Number(await topLine(page, shellId));

/**
 * Turns the wheel down and checks the program scrolled, not the page: its top line is a later
 * line of its text, and the view is still the terminal's live screen, not the page's scrollback.
 * The view's own position moves either way: tmux draws a program's scroll as lines pushed off
 * the top, which the page keeps as scrollback, so only being at the bottom tells the two apart.
 */
async function programScrolls(page: Page, shellId: string): Promise<void> {
  await wheelDown(page);
  await expect.poll(() => topNumber(page, shellId)).toBeGreaterThan(1);
  expect(await atBottom(page, shellId)).toBe(true);
}

/** How many rows tall tmux has the shell's pane: the size its program draws for. */
function paneHeight(shellId: string): number {
  const home = String(process.env["BZ_E2E_HOME"]);
  const out = TmuxServer.at(join(home, "run", "tmux.sock"), { root: home }).runSync([
    "list-panes",
    "-a",
    "-F",
    "#{@bazhen_terminal_id} #{pane_height}",
  ]);
  const line = out.split("\n").find((l) => l.startsWith(`${shellId} `));
  return Number(line?.split(" ")[1]);
}

/**
 * Waits for the page to show other than `rows` rows, for tmux to have the pane that many rows
 * tall, and for the program to have drawn its last line on the new last row. A screen left as it
 * was can keep its old last line at the bottom; it can't make the pane the page's new size.
 */
async function redrawsAtNewSize(page: Page, shellId: string, rows: number, last: RegExp) {
  await expect
    .poll(async () => {
      const shown = await visible(page, shellId);
      return [
        shown.length !== rows,
        paneHeight(shellId) === shown.length,
        last.test(shown.at(-1) ?? ""),
      ];
    })
    .toEqual([true, true, true]);
}

/** The wheel, turned down over the terminal, as a person scrolls. */
async function wheelDown(page: Page): Promise<void> {
  const box = await page.locator(".xterm-screen").boundingBox();
  if (box === null) throw new Error("no terminal on the page");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 400);
}

/** The shells this file opened, closed after each test so the run's other suites see their own. */
const opened: string[] = [];

test.afterEach(async ({ page }) => {
  await page.evaluate(async (ids) => {
    const state: unknown = await (await fetch("/v1/state")).json();
    const listed: unknown = Reflect.get(Object(state), "shells");
    for (const found of Array.isArray(listed) ? listed : []) {
      const id = String(Reflect.get(Object(found), "id"));
      if (!ids.includes(id)) continue;
      await fetch(`/v1/shells/${id}/close`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          idempotencyKey: crypto.randomUUID(),
          generation: Reflect.get(Object(found), "generation"),
          confirmBusy: true,
        }),
      });
    }
  }, opened.splice(0));
});

test("nvim with the mouse on gets the wheel, and takes Esc at once", async ({ page }) => {
  const id = await shell(page);
  await run(page, "seq 1 200 > lines.txt && nvim -u NONE -i NONE -c 'set mouse=a' lines.txt");
  await expect.poll(() => topLine(page, id), { timeout: 15_000 }).toBe("1");
  await alternate(page, id);
  await programScrolls(page, id);

  // Esc with no wait for a sequence it might start: the next keys are commands at once.
  await page.keyboard.type("Goadded");
  await page.keyboard.press("Escape");
  await run(page, ":wq");
  await idle(page, id);
  await run(page, "tail -n 1 lines.txt");
  await expect.poll(() => screen(page, id)).toMatch(/^added$/m);
});

test("less and man scroll with the wheel, as arrow keys", async ({ page }) => {
  const id = await shell(page);
  await run(page, "seq 1 200 > lines.txt && less lines.txt");
  await expect.poll(() => topLine(page, id), { timeout: 15_000 }).toBe("1");
  await alternate(page, id);
  await programScrolls(page, id);
  await page.keyboard.press("q");
  await idle(page, id);

  // No-fill, so each of the 200 lines is a line of the page, as many screens long.
  const page1 = String.raw`.TH PAGE 1\n.SH NAME\npage \\- a page to scroll\n.SH LINES\n.nf\n`;
  await run(page, `printf '${page1}' > page.1 && seq 1 200 >> page.1`);
  await run(page, "MANPAGER=less man ./page.1");
  await expect.poll(() => screen(page, id), { timeout: 15_000 }).toContain("a page to scroll");
  await alternate(page, id);
  await expect.poll(() => topLine(page, id)).toContain("PAGE(1)");
  await programScrolls(page, id);
  await page.keyboard.press("q");
});

test("htop and nvim redraw at a new size, and give the shell its screen back on exit", async ({
  page,
}) => {
  const id = await shell(page);
  await run(page, "echo before-htop");
  await run(page, "htop");
  await expect
    .poll(async () => (await visible(page, id)).join("\n"), { timeout: 15_000 })
    .toMatch(/Load average/);
  expect((await visible(page, id)).join("\n")).not.toContain("before-htop");
  const htopRows = (await visible(page, id)).length;
  await page.setViewportSize({ width: 900, height: 500 });
  // htop's key bar is on its last row; at a narrow size its end is cut, never its start.
  await redrawsAtNewSize(page, id, htopRows, /^F1\s*Help/);
  await page.keyboard.press("q");
  await expect.poll(async () => (await visible(page, id)).join("\n")).toContain("before-htop");
  await idle(page, id);

  // With no status line, nvim's ruler is on its last row.
  await run(page, "echo before-nvim && nvim -u NONE -i NONE -c 'set laststatus=0 ruler'");
  await expect.poll(async () => (await visible(page, id)).join("\n")).not.toContain("before-nvim");
  const nvimRows = (await visible(page, id)).length;
  await page.setViewportSize({ width: 1280, height: 800 });
  await redrawsAtNewSize(page, id, nvimRows, /\bAll\s*$/);
  await run(page, ":q");
  await expect.poll(async () => (await visible(page, id)).join("\n")).toContain("before-nvim");
});
