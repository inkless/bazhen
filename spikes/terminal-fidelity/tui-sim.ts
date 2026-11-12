// Minimal alt-screen "TUI": on start and on every SIGWINCH clears and redraws rows that end at the
// current width. Row content comes from argv[2]: "ascii" or "emoji" or "combining".
const kind = process.argv[2] ?? "ascii";
const body = { ascii: "plain ascii text here", emoji: "emoji 🙂 here", combining: "comb é̃ here", cjk: "cjk 日本語 here" }[kind]!;
function draw() {
  const cols = process.stdout.columns;
  let out = "\x1b[?1049h\x1b[H\x1b[2J";
  for (let r = 0; r < 10; r++) {
    const line = `${r} ${body} `;
    out += `\x1b[${r + 1};1H${line}${"x".repeat(Math.max(0, cols - [...line].length - 4))}END`;
  }
  process.stdout.write(out);
}
process.stdout.on("resize", draw);
draw();
setInterval(() => {}, 1 << 30);
