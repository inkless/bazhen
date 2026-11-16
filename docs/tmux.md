# tmux versions

Bazhen runs on tmux 3.x. Two tmux defects shape what it does on older releases.

## A dead pane's focus crashes tmux before 3.5

Before tmux 3.5, a pane whose program has exited keeps its screen, but its output is already
freed. If that program had turned on focus reports, tmux tries to write one the next time the
pane gains or loses focus, and the whole server crashes. Every terminal on it ends.

A TUI asks for focus reports to learn when its terminal is in front, and agent TUIs commonly
do. A program that is killed, or crashes, never turns them off.

The focus changes when a view of the dead terminal opens or closes, or when the browser or
terminal showing it gains or loses focus. tmux 3.5 fixed this (tmux issue 3776). Ubuntu 24.04
ships 3.4, which has the defect.

On a tmux before 3.5, Bazhen resets each pane as it dies, which turns focus reports off. It
costs the dead terminal its screen. A dead terminal shows an empty screen, and its last output,
with tmux's "Pane is dead" line, is in its history, one scroll up. Respawning it works as
before.

The reset runs on the tmux server's pass after the death. A focus change handled in the same
pass as the death can still crash the server, and so can one in the moment between the
program's terminal closing and tmux learning that it exited. Both are a single pass of the
server's event loop, so they are rare, but not impossible. Upgrade to tmux 3.5 or later to be
rid of them. `bazhen doctor` warns while the installed tmux has the defect.

The reset hangs on tmux's `pane-died` hook, and a tmux built with utempter, as Debian's and
Ubuntu's are, can miss it before 3.6: it loses the pane's exit, so the pane is dead but
`pane-died` never fires (tmux issue 4559). Bazhen's own views reset a dead pane again just
before they attach to it and just before they leave it, so the web app is covered either way.
A terminal of your own, attached with the attach command Bazhen shows for each terminal,
relies on the hook alone: on such a tmux, opening or leaving a dead terminal there, or switching focus away from
it, can still crash the server.

On tmux 3.5 and later, Bazhen sets no reset, and a dead terminal keeps its last screen.

## `window-size manual`, set globally, crashes tmux before 3.8

Bazhen sets it on each window instead.
