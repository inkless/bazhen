# The repository's commands: `make <target>`, and `make help` lists the ones a person runs, from
# the `##` after each. A target's own command takes what `ARGS` holds as more words, which its
# shell reads as it would typed after the command, quotes included and nothing expanded by make:
# `make test-real ARGS=rust`, `make test-file ARGS='tests/x.test.ts -t "a name"'`.
#
# Written for GNU Make 3.81, the one macOS ships: no .ONESHELL, --output-sync or $(file ...).
# Every target is .PHONY, so each runs afresh: cargo and vitest keep caches of their own, and a
# target make took as up to date would check nothing. A target's deps run first, in its recipe, a
# `$(MAKE) <dep>` line each: in order under `make -j` too, given no ARGS, and only printed by
# `make -n`, which runs every line that names $(MAKE). Then its own command, on a line of its own.
# Only `dev` runs two at once, its servers, which never exit. A step that starts tests runs under
# scripts/capped.ts. scripts/check-standards.ts (makefileFailures) holds all of this, and the gates
# and `check` to their pinned commands. Nothing of node_modules is on a recipe's PATH, so a
# package's tool is named by its path.

# ARGS reaches the named target's own command alone: neither a dep's make nor one a script starts
# sees it, from the command line or the environment.
MAKEFLAGS += --no-print-directory
MAKEOVERRIDES :=
unexport ARGS

.PHONY: help
help: ## This menu
	@printf 'make <target> [ARGS="<its arguments>"]\n\n' && awk -F ':.*## ' '/^[a-z][a-z0-9-]*:.*## / { printf "  %-22s %s\n", $$1, $$2 }' Makefile

.PHONY: check
check: ## Every gate, in order: what CI runs and a pull request must pass
	$(MAKE) standards
	$(MAKE) schema-check
	$(MAKE) rust-schema-check
	$(MAKE) lint
	$(MAKE) format-check
	$(MAKE) typecheck
	$(MAKE) lint-rust
	$(MAKE) deny
	$(MAKE) test-rust
	$(MAKE) test
	$(MAKE) test-medium
	$(MAKE) test-bench

.PHONY: standards
standards:
	node --disable-warning=ExperimentalWarning scripts/check-standards.ts $(value ARGS)

.PHONY: schema-check
schema-check:
	node scripts/protocol-schema.ts --check $(value ARGS)

# The Rust protocol's published schema, its id and the web's zod first, then the fixtures.
.PHONY: schema
schema: ## Regenerate the protocol's schema and fixtures
	$(MAKE) rust-schema
	node scripts/protocol-schema.ts $(value ARGS)

.PHONY: rust-schema
rust-schema:
	scripts/xtask.sh schema $(value ARGS)

.PHONY: rust-schema-check
rust-schema-check:
	scripts/xtask.sh schema --check $(value ARGS)

.PHONY: dev
dev: ## The daemon and the web client's dev server, until Ctrl-C
	$(MAKE) -j2 daemon-dev web-dev

.PHONY: bazhen
bazhen: ## The CLI, built first: ARGS='<noun> <verb>'
	$(MAKE) build-cli
	$(MAKE) build-holder-release
	target/release/bazhen $(value ARGS)

.PHONY: build
build: ## The hook, CLI, holder, types and web client
	$(MAKE) build-hook
	$(MAKE) build-cli
	$(MAKE) build-holder-release
	$(MAKE) typecheck
	$(MAKE) web-build

.PHONY: typecheck
typecheck: ## Type-check sources, tests and scripts
	node_modules/.bin/tsc -b $(value ARGS)

.PHONY: lint
lint: ## oxlint, type-aware, its generated config checked first
	$(MAKE) lint-config-check
	node_modules/.bin/oxlint --type-aware --deny-warnings --report-unused-disable-directives-severity=error $(value ARGS)

.PHONY: lint-config-check
lint-config-check:
	node scripts/lint-config.ts --check $(value ARGS)

.PHONY: lint-config
lint-config: ## Regenerate .oxlintrc.json
	node scripts/lint-config.ts $(value ARGS)

.PHONY: lint-shell
lint-shell: ## shellcheck over every tracked shell script
	scripts/lint-shell.sh $(value ARGS)

.PHONY: format
format: ## Format everything, Rust included
	$(MAKE) format-rust
	node_modules/.bin/oxfmt $(value ARGS)

.PHONY: format-rust
format-rust:
	cargo fmt --all $(value ARGS)

.PHONY: format-check
format-check: ## Check the formatting, Rust included
	$(MAKE) gate-fmt
	node_modules/.bin/oxfmt --check $(value ARGS)

.PHONY: gate-fmt
gate-fmt:
	scripts/xtask.sh gate fmt $(value ARGS)

.PHONY: lint-rust
lint-rust: ## clippy's gate over the workspace and each crate alone
	scripts/xtask.sh gate lint $(value ARGS)

.PHONY: deny
deny: ## cargo-deny's gate
	scripts/xtask.sh gate deny $(value ARGS)

.PHONY: test-rust
test-rust: ## The Rust tests, less those that signal processes
	node scripts/capped.ts --memory 4G --time 30m -- scripts/xtask.sh gate test $(value ARGS)

.PHONY: test-rust-all
test-rust-all: ## The Rust tests, those that signal processes too: a sandbox only
	node scripts/capped.ts --memory 4G --time 30m -- scripts/xtask.sh gate test-all $(value ARGS)

.PHONY: test
test: ## The small tests
	node scripts/capped.ts --memory 4G --time 10m -- node_modules/.bin/vitest run --project unit $(value ARGS)

.PHONY: test-medium
test-medium: ## The medium tests and the CLI's, their binaries built first
	$(MAKE) build-hook
	$(MAKE) build-cli
	$(MAKE) build-engine
	$(MAKE) rust-schema-check
	node scripts/capped.ts --memory 8G --time 20m -- node_modules/.bin/vitest run --project medium --project cli $(value ARGS)

.PHONY: test-bench
test-bench: ## The benchmarks' tests
	$(MAKE) build-hook
	$(MAKE) build-cli
	node scripts/capped.ts --memory 4G --time 10m -- node_modules/.bin/vitest run --project bench $(value ARGS)

.PHONY: test-file
test-file: ## vitest on the files and filters in ARGS
	node scripts/capped.ts --memory 8G --time 20m -- node_modules/.bin/vitest run $(value ARGS)

.PHONY: test-integration
test-integration: ## The tmux runtime's suite: a sandbox only
	node scripts/capped.ts --memory 4G --time 20m -- node_modules/.bin/vitest run --project integration $(value ARGS)

.PHONY: test-holder
test-holder: ## The holder suite: a sandbox only
	$(MAKE) build-holder
	node scripts/capped.ts --memory 4G --time 20m -- node_modules/.bin/vitest run --project holder $(value ARGS)

.PHONY: test-containment
test-containment: ## Holders in real systemd scopes: CI's containment job
	$(MAKE) build-holder
	node scripts/capped.ts --memory 4G --time 20m -- node_modules/.bin/vitest run --project containment $(value ARGS)

.PHONY: test-api
test-api: ## The black-box suite: a sandbox only
	$(MAKE) build-hook
	$(MAKE) build-cli
	$(MAKE) build-holder-release
	node scripts/capped.ts --memory 4G --time 30m -- node_modules/.bin/vitest run --project api $(value ARGS)

.PHONY: test-api-rust
test-api-rust: ## The api files tests/rust-daemon.txt lists, on the Rust daemon: a sandbox only
	$(MAKE) build-hook
	$(MAKE) build-cli
	$(MAKE) build-holder-release
	$(MAKE) build-daemon
	node scripts/capped.ts --memory 4G --time 30m -- node scripts/rust-daemon.ts $(value ARGS)

.PHONY: test-soak
test-soak: ## The soak's own suite: a sandbox only
	$(MAKE) build-hook
	$(MAKE) build-cli
	$(MAKE) build-holder-release
	node scripts/capped.ts --memory 8G --time 60m -- node_modules/.bin/vitest run --project soak $(value ARGS)

.PHONY: test-real
test-real: ## The sandbox suites in a throwaway container: ARGS='[suite...] [--base <ref>]'
	node scripts/capped.ts --memory 16G --time 120m -- node scripts/test-real.ts $(value ARGS)

# Their 120m is the budget CI's falsify-half job timeout is derived from (.github/workflows/ci.yml):
# change them together.
.PHONY: test-falsify
test-falsify: ## Judge the branch's new tests against its base: ARGS='--base <ref>'
	node scripts/capped.ts --memory 8G --time 120m --memory-kills-counted -- node scripts/falsify.ts $(value ARGS)

.PHONY: test-falsify-base
test-falsify-base: ## Judge a branch that changes falsify with the base's falsify: a sandbox only
	node scripts/capped.ts --memory 8G --time 120m --memory-kills-counted -- node scripts/falsify-base.ts $(value ARGS)

.PHONY: test-mutants-holder
test-mutants-holder: ## Sweep the holder's mutants: ARGS='--group <g> [--shard k/n]', a sandbox only
	node scripts/capped.ts --memory 12G --time 115m --memory-kills-counted -- node scripts/holder-mutants.ts $(value ARGS)

.PHONY: soak
soak: ## The holder soak: ARGS='[--profile p] [--hours n] [--out dir]', a disposable host only
	$(MAKE) build-hook
	$(MAKE) build-cli
	$(MAKE) build-holder-release
	node scripts/soak.ts $(value ARGS)

.PHONY: soak-vm
soak-vm: ## The soak on a libvirt VM: ARGS='<command>', ARGS=help lists them
	scripts/soak-vm.sh $(value ARGS)

.PHONY: bench-engine
bench-engine: ## Replay recorded output through the holder's engine
	$(MAKE) build-engine
	node scripts/capped.ts --memory 4G --time 10m -- node scripts/engine-replay.ts $(value ARGS)

.PHONY: bench-hook
bench-hook: ## Time the hook client: ARGS='[client]'
	node scripts/capped.ts --memory 4G --time 10m -- node scripts/hook-bench.ts $(value ARGS)

.PHONY: capped
capped: ## Any command under a memory and time cap: ARGS='<command>'
	node scripts/capped.ts --memory 8G --time 120m -- $(value ARGS)

.PHONY: build-cli
build-cli: ## The CLI's release build
	cargo build --release --quiet --locked -p bazhen $(value ARGS)

# The hook client beside it, which the daemon installs for agents and shells to run.
.PHONY: build-daemon
build-daemon: ## The Rust daemon's release build
	cargo build --release --quiet --locked -p bazhen-daemon -p bazhen-hook $(value ARGS)

.PHONY: build-engine
build-engine: ## The holder engine's release build
	cargo build --release --quiet --locked -p bazhen-holder-engine $(value ARGS)

.PHONY: build-hook
build-hook: ## The hook client and the peer reader's release builds
	cargo build --release --quiet --locked -p bazhen-hook -p bazhen-peer $(value ARGS)

.PHONY: build-holder
build-holder: ## The holder's and its engine's debug builds
	cargo build --quiet --locked -p bazhen-holder -p bazhen-holder-engine $(value ARGS)

.PHONY: build-holder-release
build-holder-release: ## The holder's release build, which unwinds on a panic
	cargo build --profile release-holder --quiet --locked -p bazhen-holder $(value ARGS)

.PHONY: build-bins
build-bins: ## Every binary's debug build
	cargo build --quiet --locked $(value ARGS)

.PHONY: build-notify
build-notify: ## Bazhen.app, the macOS notifier: ARGS='[<dir>]'
	node scripts/build-notify-mac.ts $(value ARGS)

.PHONY: font-terminal
font-terminal: ## Regenerate the web terminal's bundled font
	node scripts/terminal-font.ts $(value ARGS)

# The daemon's own, run in its folder.
.PHONY: daemon-dev
daemon-dev: ## The daemon, restarted on each change
	$(MAKE) build-hook
	$(MAKE) build-cli
	$(MAKE) build-holder-release
	cd apps/daemon && BAZHEN_WEB_PORT=$${BAZHEN_WEB_PORT:-7901} node --watch --watch-preserve-output src/main.ts < /dev/null

.PHONY: daemon-start
daemon-start: ## The daemon, as it is
	cd apps/daemon && node src/main.ts $(value ARGS)

# The web client's own, run in its folder. On no terminal's input: vite would read keys from it, as
# shortcuts that stop or restart the server.
.PHONY: web-dev
web-dev: ## The web client's dev server
	cd apps/web && node --no-turbo-fast-api-calls node_modules/vite/bin/vite.js < /dev/null

# The daemon serves a build no one but its owner may write, whatever the umask made it.
.PHONY: web-build
web-build: ## The web client's build
	cd apps/web && node_modules/.bin/vite build && chmod -R g-w,o-w dist

.PHONY: web-preview
web-preview: ## Serve the web client's build
	cd apps/web && node_modules/.bin/vite preview $(value ARGS)

# The browser suite, run in its folder, where playwright.config.ts is.
.PHONY: test-e2e
test-e2e: ## The browser suite: a sandbox only
	$(MAKE) build-hook
	$(MAKE) build-holder-release
	cd tests/e2e && node ../../scripts/capped.ts --memory 10G --time 30m -- node_modules/.bin/playwright test $(value ARGS)
