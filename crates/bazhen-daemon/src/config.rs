//! Where everything lives and how the daemon is configured, as the TypeScript daemon reads it
//! (`apps/daemon/src/config/config.ts`): each setting from the environment, then `config.toml`,
//! then the default. The file is strict: a key it doesn't know, or a value it doesn't take, refuses
//! to start, naming the file and the key, with the words the TypeScript daemon uses.
//! `packages/protocol/fixtures/config/` holds what that daemon makes of each case, and this one is
//! held to it.

mod js;
pub mod ranges;
mod schema;
mod sizes;

#[cfg(test)]
mod fixture;

use bazhen_client::paths::{self, Inputs, Paths};
use bazhen_protocol::text::{is_origin, is_plain_remote};

/// Everything the daemon starts from: where it lives, how it is configured, and which file said so.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Settings {
    pub paths: Paths,
    pub config: Config,
    pub config_file: ConfigFile,
}

/// The config file read, and whether it was there.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigFile {
    pub path: String,
    pub found: bool,
}

/// How the daemon is configured, once the environment, the file and the defaults are resolved.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Config {
    pub port: u16,
    /// `bank.path`, from the file only; [`paths::resolve`] ranks it below the flag and
    /// `BAZHEN_BANK`.
    pub bank: Option<String>,
    pub env_rules: EnvRules,
    /// With `agents.shell = "login"`, the shell every agent starts through; otherwise none.
    pub login_shell: Option<String>,
    /// Origins the user's own route to the daemon presents, such as a tunnel's domain, which join
    /// the Host and Origin allowlists.
    pub external_origins: Vec<String>,
    /// Where they came from, for the start-up log and `bazhen doctor`; none when there are none.
    pub external_origins_from: Option<OriginsFrom>,
    /// Whether plain HTTP to another host may be among them.
    pub allow_insecure_origins: bool,
    /// Whether what needs the human is shown on the host's desktop when no dashboard is.
    pub desktop_notifications: bool,
    /// Whether shells report each line they run, for a restart to type the last one back. Off
    /// unless the user turns it on: a line can hold a secret.
    pub retype_last_command: bool,
    pub pairing: PairingMode,
    /// Whether every browser must pair, on loopback too. With an external origin it always must,
    /// since a proxy in front can present any request as loopback's.
    pub pairing_required: bool,
    pub launch_limits: LaunchLimits,
    /// `agents.start_deadline_seconds`, in ms: how long a harness has to come up.
    pub start_deadline_ms: u64,
    /// `terminals.max_open`: past it, a new agent or shell is refused.
    pub max_open_terminals: u64,
    /// `terminals.history_lines`: the history each new terminal keeps.
    pub history_lines: u32,
    /// `runtime.default`: the runtime new terminals are created on.
    pub default_runtime: RuntimeKind,
    pub terminal_caps: TerminalCaps,
}

/// `agents.env`: the variables kept from agents, and those let through.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct EnvRules {
    pub deny: Vec<String>,
    pub passthrough: Vec<String>,
}

/// How far agents may launch agents to delegate to: at once, and down a chain.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LaunchLimits {
    pub max_launched: u64,
    pub max_depth: u64,
}

/// The memory caps terminals get, as systemd's `MemoryMax=` and `MemorySwapMax=` take them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TerminalCaps {
    /// `terminals.memory_max`: each terminal's.
    pub terminal: String,
    /// `terminals.total_memory_max`: all terminals' together.
    pub total: String,
    /// `terminals.swap_max`: each terminal's swap.
    pub swap: String,
}

/// Where the external origins came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OriginsFrom {
    /// `BAZHEN_EXTERNAL_ORIGINS`.
    Environment,
    /// `web.external_origins`.
    Config,
}

/// `web.pairing`: "always", or "auto", which pairs only once an external origin is set.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PairingMode {
    Auto,
    Always,
}

/// `agents.shell`: whether agents start directly, or through the user's login shell.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Shell {
    Direct,
    Login,
}

/// `runtime.default`: what new terminals run on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuntimeKind {
    Tmux,
    Holder,
}

/// `web.listen`: loopback only, or the LAN too.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Listen {
    Loopback,
    Lan,
}

/// What `config.toml` says, key by key; `None` where it says nothing.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct FileConfig {
    /// `daemon.port`.
    pub port: Option<u16>,
    /// `bank.path`, absolute.
    pub bank: Option<String>,
    /// `notifications.desktop`.
    pub desktop_notifications: Option<bool>,
    /// `shells.retype_last_command`.
    pub retype_last_command: Option<bool>,
    /// `agents.shell`.
    pub shell: Option<Shell>,
    /// `agents.max_launched`.
    pub max_launched: Option<u64>,
    /// `agents.max_launch_depth`.
    pub max_launch_depth: Option<u64>,
    /// `agents.start_deadline_seconds`.
    pub start_deadline_seconds: Option<u64>,
    /// `agents.env.deny`.
    pub env_deny: Option<Vec<String>>,
    /// `agents.env.passthrough`.
    pub env_passthrough: Option<Vec<String>>,
    /// `terminals.max_open`.
    pub max_open: Option<u64>,
    /// `terminals.memory_max`.
    pub memory_max: Option<String>,
    /// `terminals.total_memory_max`.
    pub total_memory_max: Option<String>,
    /// `terminals.swap_max`.
    pub swap_max: Option<String>,
    /// `terminals.history_lines`.
    pub history_lines: Option<u32>,
    /// `runtime.default`.
    pub default_runtime: Option<RuntimeKind>,
    /// `web.external_origins`, each an origin.
    pub external_origins: Option<Vec<String>>,
    /// `web.allow_insecure_origins`.
    pub allow_insecure_origins: Option<bool>,
    /// `web.pairing`.
    pub pairing: Option<PairingMode>,
    /// `web.listen`.
    pub listen: Option<Listen>,
    /// `web.lan_port`.
    pub lan_port: Option<u16>,
    /// `web.lan_allow`, each a range [`ranges::parse_range`] takes.
    pub lan_allow: Option<Vec<String>>,
}

/// A configuration the daemon can't start with; the message names the file or variable, and the
/// key.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct InvalidConfig(pub String);

/// The port the daemon serves on when neither `BAZHEN_PORT` nor `daemon.port` says.
pub const DEFAULT_PORT: u16 = 7900;
// Twenty-odd agents with a shell or two each, well under macOS's 511 PTYs.
const DEFAULT_MAX_OPEN_TERMINALS: u64 = 100;
// One agent's build may need half the machine; all of them together must leave the rest of it.
const DEFAULT_TERMINAL_MEMORY: &str = "50%";
const DEFAULT_TOTAL_MEMORY: &str = "80%";
// A runaway at its memory cap would otherwise go on into swap, stalling every terminal before the
// kernel killed it.
const DEFAULT_TERMINAL_SWAP: &str = "0";
const DEFAULT_MAX_LAUNCHED: u64 = 5;
const DEFAULT_MAX_LAUNCH_DEPTH: u64 = 3;
const DEFAULT_START_DEADLINE_SECONDS: u64 = 60;
/// The history each new terminal keeps by default, as `HISTORY_LINES` in packages/protocol.
const HISTORY_LINES: u32 = 10_000;
/// The most history a holder keeps, as `HOLDER_MAX_HISTORY_LINES` in packages/protocol.
const HOLDER_MAX_HISTORY_LINES: u32 = 100_000;
const CONFIG_FILE: &str = "config.toml";

/// Why `web.listen = "lan"` is refused: this daemon has no LAN listener yet. The refusal goes once
/// it has one, and the TypeScript daemon's checks of the LAN's port and ranges come with it.
pub const LAN_REFUSAL: &str = "web.listen: this daemon doesn't serve the LAN yet; use the TypeScript daemon for web.listen = \"lan\"";

/// The settings a config file's bytes hold, read as the TypeScript daemon reads them: as UTF-8,
/// with any byte that isn't replaced, then as TOML, then key by key.
///
/// # Errors
///
/// [`InvalidConfig`] naming `file`: for TOML that doesn't parse, an integer JavaScript can't hold,
/// a leap second, a key the file doesn't take, or a value its key doesn't, with the first such key.
pub fn parse_config(file: &str, bytes: &[u8]) -> Result<FileConfig, InvalidConfig> {
    let text = String::from_utf8_lossy(bytes);
    let (table, errors) = toml::de::DeTable::parse_recoverable(&text);
    if let Some(err) = errors.iter().find(|err| !schema::rolls_over(&text, err)) {
        return Err(InvalidConfig(format!(
            "{file}: Invalid TOML document: {err}"
        )));
    }
    schema::file_config(table.get_ref()).map_err(|issue| InvalidConfig(format!("{file}: {issue}")))
}

/// The file's settings, or `None` when there is no file.
fn read_config_file(file: &str) -> Result<Option<FileConfig>, InvalidConfig> {
    match std::fs::read(file) {
        Ok(bytes) => parse_config(file, &bytes).map(Some),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(InvalidConfig(format!("{file}: {err}"))),
    }
}

/// The variable `name` read by `parse`, or `None` when it is unset or empty.
fn from_env<T>(
    env: &dyn Fn(&str) -> Option<String>,
    name: &str,
    parse: impl Fn(&str) -> Result<T, String>,
) -> Result<Option<T>, InvalidConfig> {
    match env(name) {
        None => Ok(None),
        Some(raw) if raw.is_empty() => Ok(None),
        Some(raw) => parse(&raw)
            .map(Some)
            .map_err(|message| InvalidConfig(format!("{name}={raw}: {message}"))),
    }
}

/// Each setting from the environment, then the file, then the default. CLI flags reach it as the
/// environment (`bazhen --port` sets `BAZHEN_PORT`).
///
/// # Errors
///
/// [`InvalidConfig`] for a variable that holds a value its setting doesn't take, a login shell
/// with no absolute `SHELL`, an external origin that isn't one or is plain HTTP to another host
/// without leave, or `web.listen = "lan"`, checked in that order with the port first.
pub fn resolve_config(
    file: &FileConfig,
    env: &dyn Fn(&str) -> Option<String>,
) -> Result<Config, InvalidConfig> {
    let port = from_env(env, "BAZHEN_PORT", |raw| {
        schema::port_number(js::number(raw))
    })?
    .or(file.port)
    .unwrap_or(DEFAULT_PORT);
    let listen = from_env(env, "BAZHEN_WEB_LISTEN", schema::listen)?
        .or(file.listen)
        .unwrap_or(Listen::Loopback);
    // Removed with the LAN listener, which takes over `web.lan_port`, `web.lan_allow` and
    // BAZHEN_LAN_PORT as the TypeScript daemon reads them.
    if listen == Listen::Lan {
        return Err(InvalidConfig(LAN_REFUSAL.to_owned()));
    }
    let shell = from_env(env, "BAZHEN_AGENTS_SHELL", schema::shell)?
        .or(file.shell)
        .unwrap_or(Shell::Direct);
    let login_shell = login_shell(shell, env("SHELL"))?;
    let origins = external_origins(file, env)?;
    let pairing = from_env(env, "BAZHEN_PAIRING", schema::pairing)?
        .or(file.pairing)
        .unwrap_or(PairingMode::Auto);
    Ok(Config {
        port,
        bank: file.bank.clone(),
        env_rules: EnvRules {
            deny: file.env_deny.clone().unwrap_or_default(),
            passthrough: file.env_passthrough.clone().unwrap_or_default(),
        },
        login_shell,
        desktop_notifications: file.desktop_notifications.unwrap_or(true),
        retype_last_command: file.retype_last_command.unwrap_or(false),
        launch_limits: LaunchLimits {
            max_launched: file.max_launched.unwrap_or(DEFAULT_MAX_LAUNCHED),
            max_depth: file.max_launch_depth.unwrap_or(DEFAULT_MAX_LAUNCH_DEPTH),
        },
        start_deadline_ms: file
            .start_deadline_seconds
            .unwrap_or(DEFAULT_START_DEADLINE_SECONDS)
            .saturating_mul(1000),
        max_open_terminals: file.max_open.unwrap_or(DEFAULT_MAX_OPEN_TERMINALS),
        history_lines: file.history_lines.unwrap_or(HISTORY_LINES),
        default_runtime: file.default_runtime.unwrap_or(RuntimeKind::Holder),
        terminal_caps: TerminalCaps {
            terminal: file
                .memory_max
                .clone()
                .unwrap_or_else(|| DEFAULT_TERMINAL_MEMORY.to_owned()),
            total: file
                .total_memory_max
                .clone()
                .unwrap_or_else(|| DEFAULT_TOTAL_MEMORY.to_owned()),
            swap: file
                .swap_max
                .clone()
                .unwrap_or_else(|| DEFAULT_TERMINAL_SWAP.to_owned()),
        },
        pairing_required: pairing == PairingMode::Always || !origins.origins.is_empty(),
        pairing,
        external_origins: origins.origins,
        external_origins_from: origins.from,
        allow_insecure_origins: origins.allow_insecure,
    })
}

struct ExternalOrigins {
    origins: Vec<String>,
    from: Option<OriginsFrom>,
    allow_insecure: bool,
}

/// The external origins, from the environment over the file, each checked as the dev server does.
fn external_origins(
    file: &FileConfig,
    env: &dyn Fn(&str) -> Option<String>,
) -> Result<ExternalOrigins, InvalidConfig> {
    let from_variable: Vec<String> = env("BAZHEN_EXTERNAL_ORIGINS")
        .unwrap_or_default()
        .split(',')
        .map(bazhen_protocol::text::trim)
        .filter(|item| !item.is_empty())
        .map(str::to_owned)
        .collect();
    let from_file = file.external_origins.clone().unwrap_or_default();
    let (origins, from) = if !from_variable.is_empty() {
        (from_variable, Some(OriginsFrom::Environment))
    } else if !from_file.is_empty() {
        (from_file, Some(OriginsFrom::Config))
    } else {
        (Vec::new(), None)
    };
    let allow_insecure = from_env(env, "BAZHEN_ALLOW_INSECURE_ORIGINS", schema::flag)?
        .or(file.allow_insecure_origins)
        .unwrap_or(false);
    let named = if from == Some(OriginsFrom::Environment) {
        "BAZHEN_EXTERNAL_ORIGINS"
    } else {
        "web.external_origins"
    };
    if let Some(problem) = origins_problem(&origins, allow_insecure) {
        return Err(InvalidConfig(format!("{named}: {problem}")));
    }
    Ok(ExternalOrigins {
        origins,
        from,
        allow_insecure,
    })
}

/// Why `origins` can't be admitted, or `None` when every one can, as `originsProblem` in
/// packages/protocol says. Plain HTTP to another host needs `allow_insecure`, since a device's
/// credentials would cross the network readable.
fn origins_problem(origins: &[String], allow_insecure: bool) -> Option<String> {
    if let Some(bad) = origins.iter().find(|o| !is_origin(o)) {
        return Some(format!(
            "{bad} must be an origin, such as https://bazhen.example.com"
        ));
    }
    match origins.iter().find(|o| is_plain_remote(o)) {
        Some(plain) if !allow_insecure => Some(format!(
            "{plain} is plain HTTP to another host; use https, or set web.allow_insecure_origins"
        )),
        _ => None,
    }
}

/// The login shell to start agents through, which must be the user's own, by absolute path.
fn login_shell(shell: Shell, user_shell: Option<String>) -> Result<Option<String>, InvalidConfig> {
    match (shell, user_shell) {
        (Shell::Direct, _) => Ok(None),
        (Shell::Login, Some(user)) if user.starts_with('/') => Ok(Some(user)),
        (Shell::Login, user) => Err(InvalidConfig(format!(
            "agents.shell is \"login\", but SHELL is {}",
            user.as_deref().unwrap_or("unset")
        ))),
    }
}

/// Where everything lives and how the daemon is configured. The config file sits in the config
/// directory, which itself never comes from the file; the file can then move the bank.
///
/// # Errors
///
/// [`InvalidConfig`] when `--home` or `BAZHEN_HOME` isn't absolute (with
/// [`paths::RelativeHome`]'s words), when the config file can't be read or holds what
/// [`parse_config`] refuses, or when [`resolve_config`] refuses the result.
pub fn load_settings(
    inputs: &Inputs,
    env: &dyn Fn(&str) -> Option<String>,
) -> Result<Settings, InvalidConfig> {
    let resolve =
        |inputs: &Inputs| paths::resolve(inputs).map_err(|e| InvalidConfig(e.to_string()));
    let located = resolve(inputs)?;
    let path = format!("{}/{CONFIG_FILE}", located.config);
    let file = read_config_file(&path)?;
    let config = resolve_config(file.as_ref().unwrap_or(&FileConfig::default()), env)?;
    let paths = match &config.bank {
        None => located,
        Some(bank) => resolve(&Inputs {
            config_bank: Some(bank.clone()),
            ..inputs.clone()
        })?,
    };
    Ok(Settings {
        paths,
        config,
        config_file: ConfigFile {
            path,
            found: file.is_some(),
        },
    })
}

impl Shell {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Direct => "direct",
            Self::Login => "login",
        }
    }
}

impl RuntimeKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Tmux => "tmux",
            Self::Holder => "holder",
        }
    }
}

impl PairingMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Always => "always",
        }
    }
}

impl OriginsFrom {
    /// Where the origins came from, as the TypeScript daemon names it.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Environment => "BAZHEN_EXTERNAL_ORIGINS",
            Self::Config => "config",
        }
    }
}

#[cfg(test)]
mod tests {
    use bazhen_client::paths::{self, Inputs};

    use super::{InvalidConfig, load_settings};

    /// A directory of the test's own, removed when the test ends, whether or not it passed.
    struct TempDir(std::path::PathBuf);

    impl TempDir {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir()
                .join(format!("bz-daemon-config-{name}-{}", std::process::id()));
            std::fs::create_dir(&dir).unwrap();
            Self(dir)
        }

        fn inputs(&self) -> Inputs {
            Inputs {
                home_flag: Some(self.0.to_str().unwrap().to_owned()),
                home: "/home/u".to_owned(),
                tmp: "/tmp".to_owned(),
                uid: 1000,
                ..Inputs::default()
            }
        }

        /// The config file's place, made ready for one.
        fn config_file(&self) -> std::path::PathBuf {
            let config = paths::resolve(&self.inputs()).unwrap().config;
            std::fs::create_dir_all(&config).unwrap();
            std::path::Path::new(&config).join("config.toml")
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            // A directory left in the temp dir costs nothing a test would see.
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    const NO_ENV: &dyn Fn(&str) -> Option<String> = &|_| None;

    #[test]
    fn with_no_file_the_defaults_hold_and_the_file_is_named_as_missing() {
        let home = TempDir::new("missing");
        let settings = load_settings(&home.inputs(), NO_ENV).unwrap();
        let file = home.config_file();
        assert_eq!(settings.config_file.path, file.to_str().unwrap());
        assert!(!settings.config_file.found);
        assert_eq!(settings.config.port, 7900);
        assert_eq!(settings.paths, paths::resolve(&home.inputs()).unwrap());
    }

    #[test]
    fn the_files_bank_moves_the_bank_and_the_environment_overrides_the_file() {
        let home = TempDir::new("bank");
        let file = home.config_file();
        std::fs::write(&file, "bank.path = \"/srv/bank\"\ndaemon.port = 7901\n").unwrap();
        let env = |name: &str| (name == "BAZHEN_PORT").then(|| "7902".to_owned());
        let settings = load_settings(&home.inputs(), &env).unwrap();
        assert!(settings.config_file.found);
        assert_eq!(settings.paths.bank, "/srv/bank");
        assert_eq!(settings.config.bank.as_deref(), Some("/srv/bank"));
        assert_eq!(settings.config.port, 7902);
    }

    #[test]
    fn a_relative_home_or_a_file_that_cant_be_read_or_taken_is_refused_by_name() {
        let relative = Inputs {
            bazhen_home: Some("rel/home".to_owned()),
            home: "/home/u".to_owned(),
            ..Inputs::default()
        };
        assert_eq!(
            load_settings(&relative, NO_ENV),
            Err(InvalidConfig(
                "BAZHEN_HOME must be an absolute path, not rel/home".to_owned()
            ))
        );
        let home = TempDir::new("unreadable");
        let file = home.config_file();
        let named = format!("{}: ", file.to_str().unwrap());
        std::fs::create_dir(&file).unwrap();
        let unreadable = load_settings(&home.inputs(), NO_ENV).unwrap_err().0;
        assert!(unreadable.starts_with(&named), "{unreadable}");
        std::fs::remove_dir(&file).unwrap();
        std::fs::write(&file, "[daemon]\nport = 0\n").unwrap();
        assert_eq!(
            load_settings(&home.inputs(), NO_ENV),
            Err(InvalidConfig(format!(
                "{named}daemon.port: Too small: expected number to be >=1"
            )))
        );
    }
}
