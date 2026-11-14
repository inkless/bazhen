# The only place the real-tmux suites run besides CI: a Linux host that exists to be thrown away.
# Nothing of the host is mounted, so no tmux command, signal or agent in here can reach the
# host's own servers or processes. Built by `pnpm test:real` (scripts/test-real.ts), which passes
# the pins below from the repository.

ARG NODE_VERSION
# Exact, so a tmux upgrade is a change someone makes and the defect pins are re-run against.
ARG TMUX_VERSION=3.6b
ARG TMUX_SHA256=390759d25fdba016887ec982b808927e637070fd7d03a8021f8ef3102b9ae3c7

# Debian ships tmux 3.5a, not the 3.6b that developers' machines run, so the suites would test a
# version nobody uses. tmux is built here from the release tarball, and only the installed tree
# reaches the image: no compiler comes with it.
FROM node:${NODE_VERSION}-trixie AS tmux-build
ARG TMUX_VERSION
ARG TMUX_SHA256
RUN apt-get update \
  && apt-get install -y --no-install-recommends build-essential bison pkg-config libevent-dev \
    libncurses-dev \
  && rm -rf /var/lib/apt/lists/*
ADD https://github.com/tmux/tmux/releases/download/${TMUX_VERSION}/tmux-${TMUX_VERSION}.tar.gz /tmp/tmux.tar.gz
RUN echo "${TMUX_SHA256}  /tmp/tmux.tar.gz" | sha256sum -c - \
  && mkdir /tmp/tmux-src \
  && tar -xzf /tmp/tmux.tar.gz -C /tmp/tmux-src --strip-components=1 \
  && cd /tmp/tmux-src \
  && ./configure --prefix=/usr/local \
  && make -j"$(nproc)" \
  && make install DESTDIR=/tmux-root

FROM node:${NODE_VERSION}-trixie

ARG PNPM_VERSION
ARG PLAYWRIGHT_VERSION
ARG TMUX_VERSION
# What the shell-terminal suite runs in a shell, pinned as tmux is.
ARG NEOVIM_VERSION=0.10.4-8
ARG LESS_VERSION=668-1
ARG MAN_DB_VERSION=2.13.1-1
ARG HTOP_VERSION=3.4.1-5
# rustup, not Debian's cargo, which is older and ignores rust-toolchain.toml; rustup installs the
# toolchain that file pins.
ARG RUSTUP_VERSION=1.27.1-3+b1
# Without a UTF-8 locale, tmux prints a tab in a -F format as `_`, which merges every column
# the runtime reads back. CI runners and login sessions set one.
ENV HUSKY=0 CI=1 LANG=C.UTF-8

# fish and zsh are login shells agents.shell = "login" is tested against; neovim, less, man-db and
# htop are what the shell-terminal suite runs in a shell, as a person would.
# man-db would rebuild its index on install, which nothing here reads.
RUN echo "man-db man-db/auto-update boolean false" | debconf-set-selections \
  && apt-get update \
  && apt-get install -y --no-install-recommends libevent-core-2.1-7t64 fish zsh \
    "neovim=${NEOVIM_VERSION}" "less=${LESS_VERSION}" "man-db=${MAN_DB_VERSION}" \
    "htop=${HTOP_VERSION}" "rustup=${RUSTUP_VERSION}" \
  && npx -y "playwright@${PLAYWRIGHT_VERSION}" install-deps chromium \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g "pnpm@${PNPM_VERSION}" \
  && touch /etc/bazhen-disposable-host

COPY --from=tmux-build /tmux-root/usr/local /usr/local
# The build proves it carries the pinned tmux, not another that something else pulled in.
RUN test "$(tmux -V)" = "tmux ${TMUX_VERSION}"

USER node
WORKDIR /home/node/bazhen

RUN npx -y "playwright@${PLAYWRIGHT_VERSION}" install chromium

# The store from the lockfile alone, so a source change reuses it.
COPY --chown=node pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm fetch

# The suites build the hook client (crates/bazhen-hook) with cargo, in containers with no network,
# so the pinned toolchain is installed here, and the crates fetched, before the rest of the tree,
# which changes on every run. rustup keeps the toolchain in ~/.rustup, where it looks by default:
# the suites start processes with only an allowlisted environment, which has no RUSTUP_HOME.
COPY --chown=node rust-toolchain.toml ./
RUN rustup show && cargo --version
COPY --chown=node Cargo.toml Cargo.lock ./
COPY --chown=node crates crates
RUN cargo fetch --locked
COPY --chown=node . .
RUN pnpm install --offline --frozen-lockfile
