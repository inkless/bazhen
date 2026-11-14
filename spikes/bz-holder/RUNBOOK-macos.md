# Holder spike on macOS: runbook

Linux results are final. These steps cover what only a Mac or a real agent CLI can answer.
Each step names its pass condition and what to paste back. Nothing here runs tmux, and
everything lives under a temporary `/tmp/bzh-*` home, which each script deletes on exit.

## 0. Build once

```sh
cd spikes/bz-holder
cargo build --release
(cd driver && pnpm install --ignore-workspace)
node driver/smoke.ts          # expect: echo seen: true, snapshot vs stream: identical, left alive: []
```

If a run is interrupted, close whatever it left: `node driver/cleanup.ts /tmp/bzh-<name>-XXXX`.

## 1. Reruns of the Linux questions (paste each script's JSON output)

| Step | Command | Pass |
|---|---|---|
| Q1 survival | `node driver/q1-survival.ts 50` | `"result":"PASS"`, `leftAlive: []` |
| Q2 seam | `node driver/q2-seam.ts 1000` | `"result":"PASS"`: 0 seamDiffs, missing, duplicated, gaps |
| Q3 queries | `node driver/q3-queries.ts` | every query `20/20` with max under 50,000 µs; lone Esc under 10,000 µs |
| Q4 memory | `node driver/q4-memory.ts` | report only: RSS per terminal at 0, 2,000 and 10,000 lines, and 25 at once |
| Q5 CPU | `node driver/q5-cpu.ts` | report only: holders' CPU %, echo p99. Close other heavy apps first |
| Q6 parity | `node driver/q6-parity.ts` then `--replay` | every scenario `PASS` |
| Q8 fds | `sh -c 'ulimit -S -n 256; node driver/q8-fds.ts'` | `"result":"PASS"`, `childFds` lists only stdio |

macOS defaults to a soft fd limit of 256, so Q8 is closer to real life there than on Linux.

## 2. Q7: holders outlive the terminal app that started them

Do this once in each of **Terminal.app**, **iTerm2** and **Ghostty**:

1. In a window of the app under test: `node driver/q7.ts start`. Note the printed home
   (`started: /tmp/bzh-q7-XXXX`). This launches a stand-in daemon in its own session, as
   `bazhen start` will (`setsid`, stdio to files), and it spawns three holders.
2. **Close the window** (⌘W, confirm). From another terminal app: `node driver/q7.ts check <home>`.
3. Run `start` again in the app under test, then **quit the app** (⌘Q). From another app:
   `check <home>`.
4. From the app under test, start a second terminal app (`open -a Ghostty`, or any other). In
   that second app run `start`, then **force-quit** the second app (⌥⌘⎋). From a third app:
   `check <home>`.
5. After each `check`: `node driver/q7.ts stop <home>`.

**Pass:** every `check` prints `"result":"PASS"`: all holders and children alive, `hups: []`,
`tccExit: "0"`. `daemonAlive` is reported too; `bazhen start` needs it true. If macOS shows a
"would like to access files in your Desktop/Documents folder" prompt, note which app and step
showed it, and whether `tccDenied` was true. That is herdr-core #123/#269's case.

**If any check fails,** keep the home directory, paste `<home>/daemon.out` and the
`<home>/run/holders/*.log` files. The design treats a Q7 failure as "the spawn path needs a
launchd or other macOS-specific fix before any migration PR".

## 3. Real agents (owner, by hand)

1. **Codex starts with no daemon running** (Q3's last item). Create a holder running `codex`
   and nothing attached to it:
   ```sh
   H=$(mktemp -d /tmp/bzh-codex-XXXX); mkdir -p $H/run/holders
   printf '{"id":"codex","argv":["codex"],"cols":120,"rows":40,"socket":"%s/run/holders/codex.sock"}' $H \
     | target/release/bz-holder spawn
   ```
   Wait 10 seconds, then look at it: `node driver/look.ts $H/run/holders/codex.sock`
   (prints the snapshot's text). **Pass:** Codex's UI is drawn, not stuck waiting on a cursor
   position report. Close it with `node driver/cleanup.ts $H`.
2. **Recordings for Q6.** Run `node driver/record.ts claude` and then `node driver/record.ts codex`.
   Each opens the agent in a holder, mirrored in your terminal (type normally, use it for a
   minute), and saves `programs/recordings/<name>.bin` when you press Ctrl-] . Then run
   `node driver/q6-parity.ts --replay claude codex`. **Pass:** both `PASS`. Don't commit the
   recordings: they hold your prompts and paths.
