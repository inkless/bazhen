// A program that asks its terminal for the background colour at its first instruction, as a TUI
// does to pick its palette.

/**
 * Asks for the background as it starts, in raw mode first as a TUI is, and writes the reply to
 * `out`, or nothing after 2 s. Raw mode after the query would flush a reply that came back quickly.
 */
export const oscProbe = (out: string): [string, ...string[]] => [
  "python3",
  "-c",
  `import os, select, sys, time, tty
tty.setraw(0)
os.write(1, b"\\x1b]11;?\\x1b\\\\")
got, end = b"", time.time() + 2
while time.time() < end and not got.endswith(b"\\x1b\\\\"):
    if select.select([0], [], [], max(0, end - time.time()))[0]:
        got += os.read(0, 256)
open(sys.argv[1], "wb").write(got)`,
  out,
];
