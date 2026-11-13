# The only place the real-tmux suites run besides CI: a Linux host that exists to be thrown away.
# Nothing of the host is mounted, so no tmux command, signal or agent in here can reach the
# host's own servers or processes. Built by `pnpm test:real` (scripts/test-real.ts), which passes
# the pins below from the repository.

ARG NODE_VERSION
FROM node:${NODE_VERSION}-trixie

ARG PNPM_VERSION
ARG PLAYWRIGHT_VERSION
# Exact, so a tmux upgrade is a change someone makes and the defect pins are re-run against.
ARG TMUX_VERSION=3.5a-3
# Without a UTF-8 locale, tmux prints a tab in a -F format as `_`, which merges every column
# the runtime reads back. CI runners and login sessions set one.
ENV HUSKY=0 CI=1 LANG=C.UTF-8

# cargo builds the hook client (apps/hook, std only, so offline) before the suites run it; fish
# and zsh are login shells agents.shell = "login" is tested against.
RUN apt-get update \
  && apt-get install -y --no-install-recommends "tmux=${TMUX_VERSION}" cargo fish zsh \
  && npx -y "playwright@${PLAYWRIGHT_VERSION}" install-deps chromium \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g "pnpm@${PNPM_VERSION}" \
  && touch /etc/bazhen-disposable-host

USER node
WORKDIR /home/node/bazhen
RUN npx -y "playwright@${PLAYWRIGHT_VERSION}" install chromium

# The store from the lockfile alone, so a source change reuses it.
COPY --chown=node pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm fetch
COPY --chown=node . .
RUN pnpm install --offline --frozen-lockfile
