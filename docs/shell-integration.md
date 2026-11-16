# Shell integration: the last command line

After a reboot or a crash of Bazhen's tmux server, every shell shows as lost, and a restart opens
a new one in the same directory. Whatever ran there (`pnpm dev`, `cargo watch -x test`) is gone.
With the shell integration on, Bazhen keeps the last line you ran in each shell, exactly as you
typed it, so it can be typed back at the new shell's prompt.

It is off by default, because a command line can hold a secret: `export TOKEN=…`,
`mysql -p…`, a URL with a password in it.

## Turning it on

1. In `config.toml`:

   ```toml
   [shells]
   retype_last_command = true
   ```

2. Restart the daemon. Shells opened from then on get the integration; shells already open don't.

3. Add the line for your shell to its rc file. Outside a Bazhen shell with the integration on, the
   line does nothing, and it stays silent if the file isn't there.

   zsh, in `~/.zshrc`:

   ```zsh
   [[ -n $BAZHEN_SHELL_INTEGRATION && -r $BAZHEN_SHELL_INTEGRATION/zsh ]] && source "$BAZHEN_SHELL_INTEGRATION/zsh"
   ```

   bash 4.4 or later, in `~/.bashrc`:

   ```bash
   [[ -n $BAZHEN_SHELL_INTEGRATION && -r $BAZHEN_SHELL_INTEGRATION/bash ]] && . "$BAZHEN_SHELL_INTEGRATION/bash"
   ```

   fish, in `~/.config/fish/config.fish`:

   ```fish
   test -n "$BAZHEN_SHELL_INTEGRATION"; and test -r "$BAZHEN_SHELL_INTEGRATION/fish"; and source "$BAZHEN_SHELL_INTEGRATION/fish"
   ```

The integration needs the `bazhen-hook` client (`pnpm build:hook`). Without it, the daemon says
so at start and shells report nothing.

## Restarting with the last command

A lost shell whose last line was kept offers **Restart and retype last command** beside
**Restart**. The new shell opens in the same directory and, once it shows its first prompt, the
line appears there as the old shell reported it, `$VARIABLES` unexpanded: zsh and fish report
the line you typed, and bash the line as its history recorded it. What the line editor does with
a paste can still change it as it lands, as zsh's `url-quote-magic` quotes a URL, or fish escapes
a pasted quote inside quotes. Enter is never pressed: you read the line, edit it if you like, and
run it yourself. It is typed only when the shell's line editor is reading at its prompt with
nothing typed ahead of it, checked in the same step as the paste: keys you typed while the shell
started, as `vim notes` and Enter, or a program that holds the terminal, as a password prompt,
would take the line as their own input. Then it waits until the shell is back at its prompt,
for a few seconds, or else is dropped, and the daemon logs that it wasn't retyped. A program your prompt runs, as `git status`, holds the terminal for a moment,
and the line waits a few seconds for the shell to have it again.

Bazhen types it as a paste, marked with the bracketed-paste sequences, so the line editor inserts
it as text rather than taking it as keys, however long your prompt takes to draw. That holds
wherever the editor takes those sequences as a paste: fish 3.7 and 4.0, which are the versions
tested; zsh unless you unbound them; and bash when `enable-bracketed-paste` is on, as it is by
default from bash 5.1. Elsewhere (other fish versions, bash 4.4 and 5.0, or bracketed paste
turned off), Bazhen marks the paste only if the editor has asked for bracketed paste by the time
it types it, and otherwise the line arrives as keys: a key you bound to something else, as
`magic-space`, does that instead. A line that may arrive as keys is typed back only if it is
printable ASCII, since a byte beyond it is a meta key to an editor reading 8-bit input, as bash
does in a C locale. Either way the line holds no newline, escape or other control character, so
it is never Enter and can't end the paste early.

The new shell must load the integration too, since it tells Bazhen when its line editor is
reading. A prompt that takes more than 10 seconds to draw gets no line typed back. If no prompt is
reported within 30 seconds, the line is dropped and the daemon logs that it wasn't retyped,
naming the shell but not the line. Until then it is held only in the daemon's memory, so
a daemon restart in between loses it.

## What it sends, and what it doesn't

Before each line runs, the shell starts `bazhen-hook shell-report` and passes it the line on its
stdin; the client hands it to a copy of itself in the background and returns at once, so your `$!`
stays yours. The client sends the line to the daemon over its Unix socket, and exits
within a second whatever the daemon does, so a slow or stopped daemon never holds up your prompt.
The line is never a process argument, so `ps` never shows it.

- **A line that starts with a space is never sent**, the same habit that keeps a line out of your
  history (`HIST_IGNORE_SPACE`, `HISTCONTROL=ignorespace`). In bash, a line history doesn't keep
  isn't sent either.
- **Only a line that is safe to type back is kept**: at most 2048 bytes, with no newline, tab,
  escape or other control character, no bidirectional override, and no character that draws as
  nothing (a zero-width space or joiner, a directional mark, a line separator), which could hide
  part of the line typed back. A newer line that isn't safe to keep clears the old one, so Bazhen
  never offers a command older than your last.
- **Newest wins.** zsh and bash say when each line started (`$EPOCHREALTIME`); fish can't
  without starting a process, so the client stamps it as it starts, just after fish begins the
  line. A report that arrives after a later one changes nothing. A time more than a minute ahead
  of the daemon's clock counts as a minute ahead, so a wrong clock can't stop later lines from
  counting for longer than that.
- **One line per shell.** Each new line replaces the last.
- **At the first prompt, the shell says so**, once, with `bazhen-hook shell-prompt`. It carries
  the shell's token, and whether the shell's editor takes the bracketed-paste sequences as a paste.
  Its copy waits in the background until the line editor has taken the terminal, up to 10 seconds
  and no longer than the shell lives, so a line is never typed back while the terminal would echo
  it twice.

## Where it is kept, and for how long

The line is kept in one place: the shell's row in Bazhen's database, `bazhen.db` in its data
directory (`~/.local/share/bazhen`, or `data/` under `BAZHEN_HOME`). The database and its
journals can only be read by you. The line is never written to an event, so it never reaches the
event stream or a log, and it isn't in `GET /v1/state`: a dashboard or paired device only learns
that a lost shell has one. The one way it leaves the database is a restart that retypes it, which
anyone who can restart the shell can ask for, from the browser, the CLI or a paired device: the
line is then typed into the new shell, where whoever views that terminal sees it. It is deleted
when the shell closes, exits or fails to open. A lost shell keeps it for its restart, and loses it once
its replacement runs, retyped or not.

When a shell closes, SQLite overwrites its line with zeros in the page that held it, and Bazhen
then writes the write-ahead log into the database and truncates it, so `bazhen.db-wal` keeps no
earlier copy either. Two limits remain: SQLite doesn't zero a page it frees whole, which keeps
what it held until the page is reused; and while a shell lives, the lines it ran before its last
can stay in the write-ahead log until SQLite next checkpoints it.

Turning the setting off forgets every kept line, at the next daemon start.

## Who can set a shell's last line

Each shell gets a token of its own in its environment (`BAZHEN_SHELL_TOKEN`), and the daemon
accepts a line only with that shell's token. It keeps only the token's hash. An agent can't set a
shell's line, and neither can another shell or text printed to the terminal: Bazhen doesn't read
the line from the terminal's output.

**Every program you run in the shell inherits the token**, as it inherits the rest of the shell's
environment. Any of them could report a line of its own, which the restart would then type at the
prompt instead of yours. It is still checked as above, and it is never run until you press Enter.
This is the same limit as the rest of Bazhen: it can't defend you against a hostile program
running as your own user.

On Linux, while Bazhen asks tmux to start the shell, the token is briefly in that tmux command's
arguments, which other users can read in `/proc`. It gives them nothing: a report goes only over
Bazhen's socket, which only you can open.
