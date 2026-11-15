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

## What it sends, and what it doesn't

Before each line runs, the shell starts `bazhen-hook shell-report` in the background and passes
it the line on its stdin. The client sends the line to the daemon over its Unix socket, and exits
within a second whatever the daemon does, so a slow or stopped daemon never holds up your prompt.
The line is never a process argument, so `ps` never shows it.

- **A line that starts with a space is never sent**, the same habit that keeps a line out of your
  history (`HIST_IGNORE_SPACE`, `HISTCONTROL=ignorespace`). In bash, a line history doesn't keep
  isn't sent either.
- **Only a line that is safe to type back is kept**: at most 2048 bytes, with no newline, tab,
  escape or other control character, and no bidirectional override. A newer line that isn't safe
  to keep clears the old one, so Bazhen never offers a command older than your last.
- **One line per shell.** Each new line replaces the last.

## Where it is kept, and for how long

The line is kept in one place: the shell's row in Bazhen's database, in `state/bazhen.db` under
your Bazhen home. That file can only be read by you, and the directory it is in can only be
opened by you. The line is never written to an event, so it never reaches the event stream, a
dashboard, a paired device or a log, and it isn't in `GET /v1/state`. It is deleted when the
shell closes, exits or fails to open. A lost shell keeps it for its restart.

SQLite overwrites the deleted line with zeros where it was stored. Until its write-ahead log is
checkpointed (automatically, and when the daemon stops), an earlier copy of the page can still be
in `bazhen.db-wal`.

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
