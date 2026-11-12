#!/bin/sh
# A stand-in for the user's login shell, for `agents.shell = "login"`: it records how it was
# started, exports what an rc file would, then runs its command string with the arguments it was
# handed, as a real shell's -c does. Whatever that string leaves running is the pane's process.
BZ_LOGIN_SHELL_ARGS="$1 $2 $3"
FROM_RC=1
export BZ_LOGIN_SHELL_ARGS FROM_RC
shift 3
script=$1
shift
exec /bin/sh -c "$script" "$@"
