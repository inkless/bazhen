import { parse } from "smol-toml";
import { InvalidConfig, parseConfigText, resolveConfig } from "./config.ts";

/** The file every case is read from, as the messages name it. */
const FILE = "/home/u/.config/bazhen/config.toml";

/** A key `config.toml` may hold: its table, its name, and what it takes. */
interface Leaf {
  readonly table: string;
  readonly key: string;
  /** Values, as TOML, it takes. */
  readonly good: readonly string[];
  /** Values, as TOML, it refuses: of the wrong type, out of range, or malformed. */
  readonly bad: readonly string[];
}

/**
 * Datetimes of each kind, and two the parsers once read apart: JavaScript reads a day past its
 * month's end, which the toml crate refuses, and refuses a leap second, which the crate reads.
 */
const DATETIMES = [
  "1979-05-27T07:32:00Z",
  "1979-05-27 07:32:00+01:00",
  "1979-05-27T07:32:00",
  "1979-05-27",
  "07:32:00",
  "2023-02-30",
  "23:59:60",
];
const NOT_SCALARS = ["[1]", "{}", "{ a = 1 }", ...DATETIMES];
const NUMBERS_BAD = ['"1"', "true", "1.5", "nan", "-nan", "inf", "+inf", "-inf", "1e300", "-1e300"];
const STRINGS_BAD = ["1", "1.5", "true", "nan", "inf", "-inf", ...NOT_SCALARS];
const port = (table: string, key: string): Leaf => ({
  table,
  key,
  good: ["7901", "1", "65535", "65_535", "0x1EDD", "0o17", "0b1", "7901.0", "+7901", "7.901e3"],
  bad: ["0", "-1", "65536", "-0.0", "9007199254740991", "9007199254740992.0", ...NUMBERS_BAD],
});
const count = (table: string, key: string, min: number, max?: number): Leaf => ({
  table,
  key,
  good: [
    String(min),
    String(min + 1),
    `${min}.0`,
    "1e2",
    max === undefined ? "9007199254740991" : String(max),
  ],
  bad: [
    String(min - 1),
    "-1e20",
    max === undefined ? "9007199254740992.0" : String(max + 1),
    ...NUMBERS_BAD,
    ...NOT_SCALARS,
  ],
});
const flag = (table: string, key: string): Leaf => ({
  table,
  key,
  good: ["true", "false"],
  bad: ['"true"', "1", "0", ...NOT_SCALARS],
});
const choice = (table: string, key: string, options: readonly string[]): Leaf => ({
  table,
  key,
  good: options.map((o) => JSON.stringify(o)),
  bad: [
    '"x"',
    '""',
    JSON.stringify(options[0]?.toUpperCase()),
    `[${JSON.stringify(options[0])}]`,
    ...STRINGS_BAD,
  ],
});
const strings = (
  table: string,
  key: string,
  good: readonly string[],
  bad: readonly string[],
): Leaf => ({
  table,
  key,
  good: good.map((g) => `[${g}]`),
  bad: [
    ...bad.map((b) => `[${b}]`),
    '"A"',
    "1",
    "[1]",
    '["A", 1]',
    "[[]]",
    '[["A"]]',
    "[1979-05-27]",
    '["A", 2023-02-30]',
    "[23:59:60]",
    "{}",
    "1979-05-27",
    "2023-02-30",
  ],
});
const text = (
  table: string,
  key: string,
  good: readonly string[],
  bad: readonly string[],
): Leaf => ({
  table,
  key,
  good,
  bad: [...bad, ...STRINGS_BAD],
});

const MEMORY_GOOD = [
  '"64M"',
  '"0064M"',
  '"67108864"',
  '"65536K"',
  '"1G"',
  '"1T"',
  '"infinity"',
  '"1%"',
  '"50%"',
  '"100%"',
  '"9007199254740991"',
  '"8796093022207K"',
  '"8589934591M"',
  '"8388607G"',
  '"8191T"',
];
const MEMORY_BAD = [
  '"63M"',
  '"67108863"',
  '"0"',
  '"0%"',
  '"101%"',
  '"1000%"',
  '"5.5G"',
  '"1g"',
  '"1GB"',
  '""',
  '" 1G"',
  '"Infinity"',
  '"-1G"',
  '"9007199254740992"',
  '"8796093022208K"',
  '"8589934592M"',
  '"8388608G"',
  '"8192T"',
  '"99999999999999999999999T"',
];
const RANGES_GOOD = [
  '"192.168.1.0/24"',
  '"192.168.1.7/24"',
  '"10.0.0.0/8"',
  '"192.168.1.7/32"',
  '"0.0.0.0/1"',
  '"fdeb:9f4b:2183:4c5b::/64"',
  '"FDEB:9F4B::/32"',
  '"::/1"',
  '"::1.2.3.4/128"',
  '"::ffff:0:0/95"',
  '"1:2:3:4:5:6:7:8/128"',
  '"1::/16"',
  '"abcd::/16"',
  '"fe80::/10%eno1"',
  '"fe80::1/64%wlan0"',
  '"fe80::/10%en_0.1-a"',
  '"febf::/16%eth0"',
];
const RANGES_BAD = [
  '"192.168.1.0"',
  '"192.168.1.0/"',
  '"/24"',
  '"192.168.1.0/33"',
  '"::/129"',
  '"192.168.1.0/999"',
  '"192.168.1.0/1000"',
  '"192.168.1.0/024"',
  '"192.168.1.0/0"',
  '"::/0"',
  '"1.2.3/24"',
  '"256.1.1.1/8"',
  '"01.2.3.4/8"',
  '"1.2.3.4.5/8"',
  '"1.2.3.-1/8"',
  '"::ffff:192.168.1.0/120"',
  '"::ffff:0:0/96"',
  '"0:0:0:0:0:ffff:0:0/128"',
  '"fe80::/10"',
  '"fe80::1/64"',
  '"fe80::/10%1"',
  '"fe80::/10%"',
  '"fe80::/10%eth 0"',
  '"fe80::/10%eth0%1"',
  '"fe80::1%eth0/64"',
  '"fe00::/9"',
  '"fe80::/9"',
  '"8000::/1"',
  '"192.168.1.0/24%eth0"',
  '"fd00::/8%eth0"',
  '"1:2:3:4:5:6:7:8:9/64"',
  '"1:2:3:4:5:6:7/64"',
  '"1::2::3/64"',
  '"12345::/16"',
  '"1.2.3.4::/64"',
  '"::1.2.3/128"',
  '"::1.2.3.4:5/128"',
  '"g::/16"',
  '":/16"',
  '":::/16"',
  '"1:/16"',
  '" 10.0.0.0/8"',
  '"10.0.0.0/8 "',
  '"10.0.0.0/+8"',
  '"１０.0.0.0/8"',
];
const ORIGINS_GOOD = [
  '"https://bazhen.example.com"',
  '"http://localhost:7901"',
  '"http://127.0.0.1:7900"',
  '"http://[::1]:7900"',
  '"https://box.tail1234.ts.net:8443"',
  '"https://[fd00::1]"',
  '"https://10.0.0.1"',
];
const ORIGINS_BAD = [
  '"https://bazhen.example.com/"',
  '"https://Bazhen.example.com"',
  '"HTTPS://bazhen.example.com"',
  '"https://bazhen.example.com:443"',
  '"http://localhost:80"',
  '"https://bazhen.example.com/app"',
  '"https://bazhen.example.com?a=1"',
  '"https://bazhen.example.com#top"',
  '"https://user@bazhen.example.com"',
  '"ftp://bazhen.example.com"',
  '"bazhen.example.com"',
  '""',
  '"https://"',
  '"https://bazhen.example.com:99999"',
  '"https://bazhen.example.com:07901"',
  '"https://[::1%25eth0]"',
  '"https://[0:0:0:0:0:0:0:1]"',
  '"https://010.0.0.1"',
  '"https://bücher.example"',
];
const RULES_GOOD = ['"A"', '"_"', '"A*"', '"a_1*"', '"AWS_*", "TOKEN"', ""];
const RULES_BAD = ['"1A"', '"A**"', '"*"', '"A-B"', '""', '"A *"', '"A", "B-"', '"Ä"'];

/** Every key the file takes, with what it takes and refuses. */
export const LEAVES: readonly Leaf[] = [
  port("daemon", "port"),
  text("bank", "path", ['"/srv/bank"', '"/"', '"/a b/ü"'], ['"srv/bank"', '""', '"~/bank"']),
  flag("notifications", "desktop"),
  flag("shells", "retype_last_command"),
  choice("agents", "shell", ["direct", "login"]),
  count("agents", "max_launched", 0),
  count("agents", "max_launch_depth", 1),
  count("agents", "start_deadline_seconds", 1),
  strings("agents.env", "deny", RULES_GOOD, RULES_BAD),
  strings("agents.env", "passthrough", RULES_GOOD, RULES_BAD),
  count("terminals", "max_open", 1),
  text("terminals", "memory_max", MEMORY_GOOD, MEMORY_BAD),
  text("terminals", "total_memory_max", MEMORY_GOOD, MEMORY_BAD),
  text(
    "terminals",
    "swap_max",
    ['"0"', '"1"', '"1K"', '"64M"', '"infinity"', '"8191T"'],
    ['"50%"', '"-1"', '"1k"', '"inf"', '""', '"8192T"'],
  ),
  count("terminals", "history_lines", 0, 100_000),
  text(
    "attach",
    "detach_keys",
    ['"ctrl-],ctrl-]"', '"CTRL-P,Ctrl-q"', '"x"', '"ctrl-@,ctrl-\\\\,a,~"', '"a,b,c,d,e,f,g,h"'],
    ['""', '"ctrl-[,x"', '"ctrl-1"', '","', '"a,,b"', '"ctrl-]  "', '"a,b,c,d,e,f,g,h,i"', '"é"'],
  ),
  choice("runtime", "default", ["tmux", "holder"]),
  strings("web", "external_origins", ORIGINS_GOOD, ORIGINS_BAD),
  flag("web", "allow_insecure_origins"),
  choice("web", "pairing", ["auto", "always"]),
  choice("web", "listen", ["loopback", "lan"]),
  port("web", "lan_port"),
  strings("web", "lan_allow", RANGES_GOOD, RANGES_BAD),
];

interface Case {
  readonly name: string;
  readonly toml: string;
  readonly env?: Readonly<Record<string, string>>;
}

const leafCases = (leaf: Leaf): Case[] =>
  [
    ...leaf.good.map((value) => ({ name: `${leaf.table}.${leaf.key} takes ${value}`, value })),
    ...leaf.bad.map((value) => ({ name: `${leaf.table}.${leaf.key} refuses ${value}`, value })),
  ].map(({ name, value }) => ({ name, toml: `[${leaf.table}]\n${leaf.key} = ${value}\n` }));

const TABLES = [
  "daemon",
  "bank",
  "notifications",
  "shells",
  "agents",
  "agents.env",
  "terminals",
  "attach",
  "runtime",
  "web",
];

/** Each table as something else, and with a key it doesn't know. */
const tableCases = (table: string): Case[] => {
  const [parent, child] = table.includes(".") ? table.split(".") : [undefined, table];
  const under = (line: string) => (parent === undefined ? line : `[${parent}]\n${line}`);
  return [
    ...["1", '"x"', "[]", "[{}]", "true", ...DATETIMES, "{}", "nan"].map((value) => ({
      name: `${table} as ${value}`,
      toml: `${under(`${child} = ${value}`)}\n`,
    })),
    { name: `${table} as an array of tables`, toml: `[[${table}]]\n` },
    { name: `${table} with an unknown key`, toml: `[${table}]\nnope = 1\n` },
    { name: `${table} with two unknown keys`, toml: `[${table}]\nzeta = 1\nalpha = "a"\n` },
    { name: `${table} with an unknown table`, toml: `[${table}.nope]\n` },
  ];
};

const EVERY_KEY = `
[daemon]
port = 7901
[bank]
path = "/srv/bank"
[notifications]
desktop = false
[shells]
retype_last_command = true
[agents]
shell = "direct"
max_launched = 0
max_launch_depth = 1
start_deadline_seconds = 1
[agents.env]
deny = ["AWS_*", "TOKEN"]
passthrough = ["PATH", "_X*"]
[terminals]
max_open = 1
memory_max = "64M"
total_memory_max = "100%"
swap_max = "infinity"
history_lines = 0
[attach]
detach_keys = "ctrl-p,ctrl-q"
[runtime]
default = "tmux"
[web]
external_origins = ["https://bazhen.example.com", "http://localhost:7901"]
allow_insecure_origins = false
pairing = "always"
listen = "loopback"
lan_port = 7942
lan_allow = ["192.168.1.0/24", "fe80::/10%eno1"]
`;

const SHAPES: Case[] = [
  { name: "an empty file", toml: "" },
  { name: "comments only", toml: "# nothing\n\n" },
  { name: "every key", toml: EVERY_KEY },
  {
    name: "every key, inline",
    toml: EVERY_KEY.replace("[daemon]\nport = 7901", "daemon = { port = 7901 }"),
  },
  {
    name: "dotted keys",
    toml: 'daemon.port = 8000\nweb.pairing = "always"\nagents.env.deny = ["A"]\n',
  },
  { name: "an unknown top-level key", toml: "nope = 1\n" },
  { name: "an unknown top-level table", toml: "[nope]\n" },
  {
    name: "unknown keys, in the order JavaScript lists them",
    toml: 'b = 1\na = 1\n"10" = 1\n"2" = 1\n"01" = 1\n"4294967294" = 1\n"4294967295" = 1\n"-1" = 1\n',
  },
  { name: "an unknown key before a bad one", toml: 'zz = 1\n[daemon]\nport = "x"\n' },
  {
    name: "a later table's bad value after an earlier one's unknown key",
    toml: '[web]\nnope = 1\n[daemon]\nport = "x"\n',
  },
  {
    name: "an earlier table's unknown key before a later one's bad value",
    toml: "[daemon]\nnope = 1\n[bank]\npath = 1\n",
  },
  {
    name: "a bad value before an unknown key in one table",
    toml: '[web]\nnope = 1\npairing = "x"\n',
  },
  {
    name: "the first of two bad values in schema order",
    toml: '[web]\npairing = "x"\nexternal_origins = 1\n',
  },
  {
    name: "a nested table's unknown key before its parent's bad value",
    toml: '[agents]\nshell = "x"\n[agents.env]\nnope = 1\n',
  },
  { name: "unknown keys at two levels", toml: "top = 1\n[agents.env]\nnope = 1\n" },
  {
    name: "unknown keys in the order a table first appears",
    toml: "[web.zz]\n[aa]\n[web]\nyy = 1\n",
  },
  { name: "a key with a dot, quoted", toml: '"daemon.port" = 1\n' },
  { name: "a key with a quote in it", toml: "'a\"b' = 1\n" },
  { name: "a key that is empty", toml: '"" = 1\n' },
  { name: "a key that isn't ASCII", toml: '"ключ" = 1\n' },
  { name: "the second bad element of a list", toml: '[agents.env]\ndeny = ["A", 1, "1A"]\n' },
  { name: "an unknown key holding a day past its month's end", toml: "nope = 2023-04-31\n" },
  { name: "an unknown key holding a leap second", toml: "nope = 1979-05-27T23:59:60Z\n" },
  {
    name: "days past their months' ends, in a list and a table",
    toml: "nope = [2023-02-29, 2023-02-31T07:32:00Z]\n[daemon]\nport = 2024-02-30 07:32:00\n",
  },
  { name: "a day past its month's end, at a leap second", toml: "nope = 2023-02-30T23:59:60\n" },
  { name: "a day past its month's end, at hour 24", toml: "nope = 2023-02-30T24:00:00\n" },
  { name: "a day past its month's end, then bad syntax", toml: "nope = 2023-02-30\nport =\n" },
  { name: "day 32", toml: "nope = 2023-01-32\n" },
  { name: "a leap day", toml: "[daemon]\nport = 2024-02-29\n" },
  { name: "a datetime in a string", toml: '[bank]\npath = "2023-02-30"\n' },
  { name: "a byte order mark", toml: "﻿[daemon]\nport = 7901\n" },
  { name: "CRLF line ends", toml: "[daemon]\r\nport = 7901\r\n" },
  { name: "a literal string", toml: "[bank]\npath = '/srv/bank'\n" },
  { name: "a multi-line string", toml: '[bank]\npath = """\n/srv/bank"""\n' },
  { name: "an escape in a string", toml: '[bank]\npath = "/srv/\\u00fc"\n' },
];

const SYNTAX: Case[] = [
  { name: "a key with no value", toml: "port =\n" },
  { name: "an unclosed table header", toml: "[daemon\nport = 1\n" },
  { name: "a key set twice", toml: "[daemon]\nport = 1\nport = 2\n" },
  { name: "a table defined twice", toml: "[daemon]\n[daemon]\n" },
  { name: "an unterminated string", toml: '[bank]\npath = "/srv\n' },
  {
    name: "an integer past JavaScript's safe integers",
    toml: "[daemon]\nport = 9007199254740992\n",
  },
  {
    name: "a negative integer past JavaScript's safe integers",
    toml: "nope = -9007199254740992\n",
  },
  { name: "an integer past 64 bits", toml: "nope = 99999999999999999999999\n" },
  { name: "a bare word", toml: "[daemon]\nport = abc\n" },
  { name: "a leading zero", toml: "[daemon]\nport = 07901\n" },
];

const MULTI_LINE_ORIGINS = 'external_origins = ["https://a.example", "https://b.example"]';

const ENV: Case[] = [
  { name: "the defaults", toml: "", env: {} },
  ...[
    "7000",
    "1",
    "65535",
    "0",
    "-1",
    "65536",
    "abc",
    "1.5",
    "7000.0",
    "0x1F90",
    "0X1f90",
    "0b1",
    "0o17",
    "-0x10",
    "0x",
    " 7000 ",
    "\t\n7000  ﻿",
    "+7000",
    "-0",
    "1e3",
    ".5e1",
    "5.",
    "e5",
    "1e",
    "--1",
    "1_000",
    "00012",
    "Infinity",
    "+Infinity",
    "-Infinity",
    "infinity",
    "inf",
    "NaN",
    "1e400",
    "9007199254740991",
    "9007199254740993",
    "-9007199254740993",
    "١٢",
    "7000\u0085",
    " ",
  ].map((value) => ({
    name: `BAZHEN_PORT=${JSON.stringify(value)}`,
    toml: "[daemon]\nport = 7901\n",
    env: { BAZHEN_PORT: value },
  })),
  { name: "BAZHEN_PORT empty is unset", toml: "[daemon]\nport = 7901\n", env: { BAZHEN_PORT: "" } },
  {
    name: "BAZHEN_AGENTS_SHELL=login over the file's direct",
    toml: '[agents]\nshell = "direct"\n',
    env: { BAZHEN_AGENTS_SHELL: "login", SHELL: "/bin/zsh" },
  },
  {
    name: "BAZHEN_AGENTS_SHELL=direct over the file's login",
    toml: '[agents]\nshell = "login"\n',
    env: { BAZHEN_AGENTS_SHELL: "direct" },
  },
  { name: "BAZHEN_AGENTS_SHELL=sh", toml: "", env: { BAZHEN_AGENTS_SHELL: "sh" } },
  {
    name: "BAZHEN_AGENTS_SHELL empty is unset",
    toml: '[agents]\nshell = "login"\n',
    env: { BAZHEN_AGENTS_SHELL: "", SHELL: "/bin/bash" },
  },
  { name: "a login shell with SHELL unset", toml: '[agents]\nshell = "login"\n', env: {} },
  {
    name: "a login shell with SHELL empty",
    toml: '[agents]\nshell = "login"\n',
    env: { SHELL: "" },
  },
  {
    name: "a login shell with SHELL relative",
    toml: '[agents]\nshell = "login"\n',
    env: { SHELL: "bash" },
  },
  {
    name: "a login shell with SHELL absolute",
    toml: '[agents]\nshell = "login"\n',
    env: { SHELL: "/bin/bash" },
  },
  {
    name: "a direct shell ignores SHELL",
    toml: '[agents]\nshell = "direct"\n',
    env: { SHELL: "bash" },
  },
  {
    name: "BAZHEN_PAIRING=always over the file's auto",
    toml: '[web]\npairing = "auto"\n',
    env: { BAZHEN_PAIRING: "always" },
  },
  {
    name: "BAZHEN_PAIRING=auto over the file's always",
    toml: '[web]\npairing = "always"\n',
    env: { BAZHEN_PAIRING: "auto" },
  },
  { name: "BAZHEN_PAIRING=never", toml: "", env: { BAZHEN_PAIRING: "never" } },
  {
    name: "BAZHEN_PAIRING empty is unset",
    toml: '[web]\npairing = "always"\n',
    env: { BAZHEN_PAIRING: "" },
  },
  { name: "pairing auto with no origin", toml: '[web]\npairing = "auto"\n', env: {} },
  {
    name: "pairing auto with an origin",
    toml: `[web]\npairing = "auto"\n${MULTI_LINE_ORIGINS}\n`,
    env: {},
  },
  {
    name: "pairing auto with an origin from the environment",
    toml: "",
    env: { BAZHEN_EXTERNAL_ORIGINS: "https://a.example" },
  },
  { name: "pairing always with no origin", toml: '[web]\npairing = "always"\n', env: {} },
  {
    name: "BAZHEN_EXTERNAL_ORIGINS over the file's",
    toml: `[web]\n${MULTI_LINE_ORIGINS}\n`,
    env: { BAZHEN_EXTERNAL_ORIGINS: "https://c.example" },
  },
  {
    name: "BAZHEN_EXTERNAL_ORIGINS listed with spaces and empty items",
    toml: "",
    env: { BAZHEN_EXTERNAL_ORIGINS: " https://a.example ,, https://b.example:8443,\t" },
  },
  {
    name: "BAZHEN_EXTERNAL_ORIGINS of only commas and spaces leaves the file's",
    toml: `[web]\n${MULTI_LINE_ORIGINS}\n`,
    env: { BAZHEN_EXTERNAL_ORIGINS: " , ," },
  },
  {
    name: "BAZHEN_EXTERNAL_ORIGINS empty leaves the file's",
    toml: `[web]\n${MULTI_LINE_ORIGINS}\n`,
    env: { BAZHEN_EXTERNAL_ORIGINS: "" },
  },
  ...[
    "https://a.example/",
    "HTTPS://a.example",
    "https://A.example",
    "https://a.example:443",
    "http://a.example:80",
    "https://a.example/x",
    "https://a.example?x",
    "https://u@a.example",
    "a.example",
    "https://a.example https://b.example",
  ].map((value) => ({
    name: `BAZHEN_EXTERNAL_ORIGINS=${value}`,
    toml: "",
    env: { BAZHEN_EXTERNAL_ORIGINS: `https://ok.example,${value}` },
  })),
  {
    name: "plain HTTP to another host",
    toml: '[web]\nexternal_origins = ["http://box.lan"]\n',
    env: {},
  },
  {
    name: "plain HTTP to another host, allowed in the file",
    toml: '[web]\nexternal_origins = ["http://box.lan"]\nallow_insecure_origins = true\n',
    env: {},
  },
  {
    name: "plain HTTP to another host, allowed by the environment",
    toml: '[web]\nexternal_origins = ["http://box.lan"]\n',
    env: { BAZHEN_ALLOW_INSECURE_ORIGINS: "true" },
  },
  {
    name: "plain HTTP to another host, refused by the environment over the file",
    toml: '[web]\nexternal_origins = ["http://box.lan"]\nallow_insecure_origins = true\n',
    env: { BAZHEN_ALLOW_INSECURE_ORIGINS: "false" },
  },
  {
    name: "plain HTTP to another host from the environment",
    toml: "",
    env: { BAZHEN_EXTERNAL_ORIGINS: "https://a.example,http://192.168.1.5:7900" },
  },
  {
    name: "plain HTTP to loopback",
    toml: "",
    env: { BAZHEN_EXTERNAL_ORIGINS: "http://localhost:7901,http://127.0.0.1,http://[::1]:8000" },
  },
  {
    name: "plain HTTP to another loopback address",
    toml: "",
    env: { BAZHEN_EXTERNAL_ORIGINS: "http://127.0.0.2" },
  },
  {
    name: "BAZHEN_ALLOW_INSECURE_ORIGINS=yes",
    toml: "",
    env: { BAZHEN_ALLOW_INSECURE_ORIGINS: "yes" },
  },
  {
    name: "BAZHEN_ALLOW_INSECURE_ORIGINS=TRUE",
    toml: "",
    env: { BAZHEN_ALLOW_INSECURE_ORIGINS: "TRUE" },
  },
  {
    name: "BAZHEN_ALLOW_INSECURE_ORIGINS empty is unset",
    toml: "[web]\nallow_insecure_origins = true\n",
    env: { BAZHEN_ALLOW_INSECURE_ORIGINS: "" },
  },
  {
    name: "BAZHEN_ALLOW_INSECURE_ORIGINS without origins",
    toml: "",
    env: { BAZHEN_ALLOW_INSECURE_ORIGINS: "true" },
  },
  { name: "BAZHEN_WEB_LISTEN=wan", toml: "", env: { BAZHEN_WEB_LISTEN: "wan" } },
  { name: "BAZHEN_WEB_LISTEN=LAN", toml: "", env: { BAZHEN_WEB_LISTEN: "LAN" } },
  {
    name: "BAZHEN_WEB_LISTEN=loopback over the file's lan",
    toml: '[web]\nlisten = "lan"\nlan_allow = ["10.0.0.0/8"]\n',
    env: { BAZHEN_WEB_LISTEN: "loopback" },
  },
  { name: "BAZHEN_WEB_LISTEN empty is unset", toml: "", env: { BAZHEN_WEB_LISTEN: "" } },
  { name: "BAZHEN_LAN_PORT is unread on loopback", toml: "", env: { BAZHEN_LAN_PORT: "abc" } },
  {
    name: "BAZHEN_LAN_PORT is unread on loopback, from the file too",
    toml: '[web]\nlisten = "loopback"\n',
    env: { BAZHEN_LAN_PORT: "7942" },
  },
  {
    name: "the first of two bad variables: BAZHEN_PORT",
    toml: "",
    env: {
      BAZHEN_PORT: "x",
      BAZHEN_PAIRING: "x",
      BAZHEN_AGENTS_SHELL: "x",
      BAZHEN_WEB_LISTEN: "x",
    },
  },
  {
    name: "the first of two bad variables: BAZHEN_WEB_LISTEN",
    toml: "",
    env: { BAZHEN_PAIRING: "x", BAZHEN_AGENTS_SHELL: "x", BAZHEN_WEB_LISTEN: "x" },
  },
  {
    name: "the first of two bad variables: BAZHEN_AGENTS_SHELL",
    toml: "",
    env: { BAZHEN_PAIRING: "x", BAZHEN_AGENTS_SHELL: "x", BAZHEN_ALLOW_INSECURE_ORIGINS: "x" },
  },
  {
    name: "a login shell's SHELL before a bad origin",
    toml: '[agents]\nshell = "login"\n',
    env: { BAZHEN_EXTERNAL_ORIGINS: "x" },
  },
  {
    name: "a bad BAZHEN_ALLOW_INSECURE_ORIGINS before a bad origin",
    toml: "",
    env: { BAZHEN_EXTERNAL_ORIGINS: "x", BAZHEN_ALLOW_INSECURE_ORIGINS: "x" },
  },
  {
    name: "a bad origin before a bad BAZHEN_PAIRING",
    toml: "",
    env: { BAZHEN_EXTERNAL_ORIGINS: "x", BAZHEN_PAIRING: "x" },
  },
  {
    name: "a bad BAZHEN_PORT before the LAN",
    toml: '[web]\nlisten = "lan"\n',
    env: { BAZHEN_PORT: "x" },
  },
];

/** Cases the TypeScript daemon serves the LAN for, or refuses on the way to it. */
const LAN: Case[] = [
  { name: "the LAN with no ranges", toml: '[web]\nlisten = "lan"\n', env: {} },
  {
    name: "the LAN with ranges",
    toml: '[web]\nlisten = "lan"\nlan_allow = ["10.0.0.0/8"]\n',
    env: {},
  },
  {
    name: "the LAN from BAZHEN_WEB_LISTEN",
    toml: '[web]\nlan_allow = ["10.0.0.0/8"]\n',
    env: { BAZHEN_WEB_LISTEN: "lan" },
  },
  {
    name: "the LAN on the daemon's own port",
    toml: '[daemon]\nport = 7942\n[web]\nlisten = "lan"\nlan_allow = ["10.0.0.0/8"]\n',
    env: {},
  },
  {
    name: "the LAN on 443",
    toml: '[web]\nlisten = "lan"\nlan_port = 443\nlan_allow = ["10.0.0.0/8"]\n',
    env: {},
  },
  {
    name: "the LAN with a bad BAZHEN_LAN_PORT",
    toml: '[web]\nlisten = "lan"\nlan_allow = ["10.0.0.0/8"]\n',
    env: { BAZHEN_LAN_PORT: "abc" },
  },
  {
    name: "the LAN before a login shell's SHELL",
    toml: '[agents]\nshell = "login"\n[web]\nlisten = "lan"\nlan_allow = ["10.0.0.0/8"]\n',
    env: {},
  },
  {
    name: "the LAN with pairing auto",
    toml: '[web]\nlisten = "lan"\npairing = "auto"\nlan_allow = ["10.0.0.0/8"]\n',
    env: {},
  },
];

const CASES: readonly Case[] = [
  ...SHAPES,
  ...SYNTAX,
  ...TABLES.flatMap(tableCases),
  ...LEAVES.flatMap(leafCases),
  ...ENV,
  ...LAN,
];

type Outcome =
  | { readonly error: string; readonly syntax?: true }
  | { readonly config: Record<string, unknown> };

/** What the TypeScript daemon makes of one case, and whether it went on to the LAN listener. */
function outcome(c: Case): { lan: boolean; outcome: Outcome } {
  let file;
  try {
    file = parseConfigText(FILE, c.toml);
  } catch (err) {
    if (!(err instanceof InvalidConfig)) throw err;
    let syntax = false;
    try {
      parse(c.toml);
    } catch {
      syntax = true;
    }
    return {
      lan: false,
      outcome: syntax ? { error: err.message, syntax } : { error: err.message },
    };
  }
  const read = new Set<string>();
  const env = new Proxy<Record<string, string | undefined>>(
    { ...c.env },
    {
      get: (target, name) => {
        if (typeof name === "string") read.add(name);
        return Reflect.get(target, name);
      },
    },
  );
  // The LAN listener reads BAZHEN_LAN_PORT first, and only it does.
  const lan = () => read.has("BAZHEN_LAN_PORT");
  try {
    const { lan: _listener, ...config } = resolveConfig(file, env);
    return {
      lan: lan(),
      outcome: {
        config: { ...config, bank: config.bank ?? null, loginShell: config.loginShell ?? null },
      },
    };
  } catch (err) {
    if (!(err instanceof InvalidConfig)) throw err;
    return { lan: lan(), outcome: { error: err.message } };
  }
}

/**
 * What the Rust daemon's config is held to: each case's file and environment, and what this
 * daemon makes of them. A case that reaches the LAN listener is marked, since the Rust daemon
 * refuses `web.listen = "lan"` until it has one.
 */
export function configFixture(): Record<string, string> {
  const names = new Set<string>();
  const cases = CASES.map((c) => {
    if (names.has(c.name)) throw new Error(`two config fixture cases are named ${c.name}`);
    names.add(c.name);
    return { name: c.name, toml: c.toml, env: c.env ?? {}, ...outcome(c) };
  });
  return { "typescript.json": `${JSON.stringify({ file: FILE, cases }, null, 2)}\n` };
}
