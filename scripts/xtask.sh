#!/bin/sh
# `cargo xtask "$@"`, built where no cargo config can reach it, and run with no runner in the way.
# A runner set for the host's triple, in the environment or a parent directory's cargo config,
# outranks the one the alias names, so `cargo xtask` could start something else and pass with no
# gate run. And a config's linker, [env], `paths` or source replacement could build another xtask
# before any check ran. cargo reads configs from the directory it runs in and those above it, and
# from its home. So this builds xtask from `/`, refusing if it has a cargo config, with a cargo
# home of its own that has none, and with no variable from the caller but the few that `env -i`
# below keeps. It builds xtask's own crate afresh each run, so no binary forged earlier is taken
# for a built one, then runs the one binary cargo names, naming the root.
set -u
root=$(cd -- "$(dirname -- "$0")/.." && pwd -P) || exit 1
refuse() {
  echo "scripts/xtask.sh: $*" >&2
  exit 1
}
toolchain=$(sed -n 's/^channel = "\([0-9.]*\)"$/\1/p' "$root/rust-toolchain.toml")
[ -n "$toolchain" ] || refuse "rust-toolchain.toml names no channel this can read."
home=${HOME:-}
case $home in /*) ;; *) refuse "HOME names no full path." ;; esac
cargo_home=${CARGO_HOME:-$home/.cargo}
case $cargo_home in /*) ;; *) refuse "CARGO_HOME names no full path." ;; esac
rustup_home=${RUSTUP_HOME:-$home/.rustup}
build=$root/target/xtask
own_home=$build/cargo-home
for name in config config.toml; do
  if [ -e "/.cargo/$name" ] || [ -L "/.cargo/$name" ]; then
    refuse "cargo would read /.cargo/$name while it builds xtask. Remove it."
  fi
done
# The downloads of the caller's cargo home, and no config. It stays where it is between runs, so
# cargo finds the dependencies where it built them and doesn't build them again.
mkdir -p -- "$cargo_home/registry" "$cargo_home/git" "$own_home" || exit 1
for name in registry git; do
  ln -sfn -- "$cargo_home/$name" "$own_home/$name" || exit 1
done
for name in config config.toml; do
  if [ -e "$own_home/$name" ] || [ -L "$own_home/$name" ]; then
    refuse "the build's own cargo home has a $name."
  fi
done
# cargo, from `/`, with no variable from the caller but these.
isolated() {
  (cd / && env -i PATH="${PATH:-}" HOME="$home" RUSTUP_HOME="$rustup_home" \
    RUSTUP_TOOLCHAIN="$toolchain" CARGO_HOME="$own_home" CARGO_TARGET_DIR="$build" \
    cargo "$@" --quiet --manifest-path "$root/Cargo.toml" --package bazhen-xtask)
}
isolated clean || refuse "cargo couldn't remove the xtask it built before."
built=$(isolated build --locked --bin bazhen-xtask --message-format=json-render-diagnostics) ||
  refuse "cargo couldn't build xtask."
# The one executable the build made; a path JSON would escape isn't taken.
bins=$(printf '%s\n' "$built" | sed -n 's/.*"executable":"\([^"\\]*\)".*/\1/p')
[ "$(printf '%s\n' "$bins" | grep -c .)" = 1 ] ||
  refuse "cargo named no single executable for bazhen-xtask this can run."
bin=$bins
[ -x "$bin" ] || refuse "cargo named $bin for bazhen-xtask, which isn't an executable."
unset CARGO_MANIFEST_DIR
BAZHEN_XTASK_ROOT=$root
export BAZHEN_XTASK_ROOT
exec "$bin" "$@"
