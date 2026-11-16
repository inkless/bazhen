# What closing a terminal ends

Each terminal runs in a holder process, `bazhen-holder`, which starts the terminal's program as
the leader of a session of its own. Everything the program starts is in that session unless it
leaves it on purpose: background jobs, `nohup` jobs and their children. Closing the terminal ends
that whole session, and so does respawning it, for what the old program left behind.

## How a close ends the session

1. Every process in the session is sent `SIGHUP` and then `SIGCONT`, as a terminal hangup would,
   so a stopped job wakes up to act on it.
2. Two seconds later, whatever still runs is sent `SIGKILL`, and again every 50 ms, until two
   passes in a row find nothing left. A job that keeps starting new ones is caught by the next
   pass. If the program and everything it started exit on the hangup, the close ends then,
   without waiting the two seconds.
3. The holder then exits. After ten `SIGKILL` passes it stops, and logs the pids of what is left.
   A program that still hasn't exited, as one stuck in the kernel can't, holds the holder for at
   most seven seconds from the close, after which it exits without it.

A respawn ends the old program's session in the same way while the new program starts.

A process that left the session with `setsid`, as a daemon does, isn't the terminal's any more,
and a close leaves it running. To keep a job running after its terminal closes, start it that
way: `setsid -f <command>` on Linux. `nohup` isn't enough, since a `nohup` job stays in the
session and the close kills it.

## `sudo` in a terminal

A `sudo` command runs as root, in the same session. The holder runs as you, so it isn't allowed
to signal it. A close leaves it running, without its terminal, so it gets an error the next time
it reads or writes the terminal. The holder's log names its pid
("a process of the session is another user's, which a close can't end"). End it yourself, with
`sudo kill <pid>`, if it doesn't stop by itself.

## The `<defunct>` process under a holder

When a terminal's program exits and the terminal isn't closed yet, `ps` shows the program as
`<defunct>` under its holder. That is deliberate. The holder doesn't collect the exited program
until the terminal closes, because while it holds it, the program's process id, which is also
the session's id, can't be given to any other process. That is what lets a close find the
session's processes without ever reaching another program's. There is at most one per exited
terminal, and it goes away when the terminal is closed. A respawned terminal's old program is
collected the same way, once what it left running has been ended, within about three seconds.

## What the holder needs

On Linux, the holder needs kernel 5.3 or later, for `pidfd_open`. That lets it signal a process
without the risk that its id has meanwhile been given to another. It also needs a `/proc` of its
own PID namespace, since it finds a terminal's processes there. Without either, as on an older
kernel or under a seccomp profile that refuses `pidfd_open`, the holder refuses to start, with
exit code 8 and a message saying which.

macOS has no equivalent. There, the holder watches each process for its exit just before it
signals it, which leaves a window of microseconds in which a process could exit and its id be
reused. macOS hands out ids in increasing order, so that would need the whole id range to come
round within that window.
