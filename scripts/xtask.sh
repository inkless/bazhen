#!/bin/sh
# `cargo xtask "$@"`, built where no cargo config can reach it, and run with no runner in the way.
# A runner set for the host's triple, in the environment or a parent directory's cargo config,
# outranks the one the alias names, so `cargo xtask` could start something else and pass with no
# gate run. And a config's linker, [env], `paths` or source replacement could build another xtask
# before any check ran. cargo reads configs from the directory it runs in and those above it, and
# from its home. So this builds xtask from a fresh directory, refusing if one above it has a cargo
# config, with a cargo home of its own that has none, and with no variable from the caller but the
# few that `env -i` below keeps. It then runs the binary cargo names, naming the root.
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
scratch=$(mktemp -d) || exit 1
trap 'rm -rf -- "$scratch"' EXIT
mkdir -- "$scratch/cwd" || exit 1
# Fail closed: a directory this can't search could hide a config.
dir=$scratch/cwd
while :; do
  [ -d "$dir" ] && [ -x "$dir" ] || refuse "can't search $dir for a cargo config."
  if [ -e "$dir/.cargo" ] || [ -L "$dir/.cargo" ]; then
    [ -d "$dir/.cargo" ] && [ -x "$dir/.cargo" ] ||
      refuse "can't search $dir/.cargo for a cargo config."
    for name in config config.toml; do
      if [ -e "$dir/.cargo/$name" ] || [ -L "$dir/.cargo/$name" ]; then
        refuse "cargo would read $dir/.cargo/$name while it builds xtask. Remove it."
      fi
    done
  fi
  [ "$dir" = / ] && break
  dir=$(dirname -- "$dir")
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
built=$(cd -- "$scratch/cwd" && env -i PATH="${PATH:-}" HOME="$home" RUSTUP_HOME="$rustup_home" \
  RUSTUP_TOOLCHAIN="$toolchain" CARGO_HOME="$own_home" CARGO_TARGET_DIR="$build" \
  cargo build --quiet --locked --manifest-path "$root/Cargo.toml" --package bazhen-xtask \
  --bin bazhen-xtask --message-format=json-render-diagnostics) ||
  refuse "cargo couldn't build xtask."
# The one executable the build made; a path JSON would escape isn't taken.
bin=$(printf '%s\n' "$built" | sed -n 's/.*"executable":"\([^"\\]*\)".*/\1/p' | tail -n 1)
if [ -z "$bin" ] || [ ! -x "$bin" ]; then
  refuse "cargo built bazhen-xtask but named no executable this can run."
fi
unset CARGO_MANIFEST_DIR
BAZHEN_XTASK_ROOT=$root
export BAZHEN_XTASK_ROOT
exec "$bin" "$@"
