// The modules of a Rust workspace and the type names written in them, resolved from the module a
// name is written in as rustc would, as far as the text settles it. What the text leaves open is
// unresolved, never guessed, so a caller can take an unresolved name for any type of that name.
// It imports nothing but rust-source.ts, so the gate scripts can use it.

import { itemEnd } from "./rust-source.ts";

const ITEM_KINDS = ["struct", "enum", "union", "type", "trait"] as const;

export type ItemKind = (typeof ITEM_KINDS)[number];

const isItemKind = (word: string | undefined): word is ItemKind =>
  (ITEM_KINDS as readonly (string | undefined)[]).includes(word);

/** A type a module defines: a struct, enum, union, type alias or trait. */
export interface Item {
  name: string;
  kind: ItemKind;
  module: Module;
  file: string;
  /** Where its keyword is in the file's code. */
  at: number;
  /** The item, from its keyword to its end. */
  text: string;
}

/** A name a `use` or `extern crate` binds, or the path a glob takes every name from. */
export interface UseBinding {
  /** The name bound, `*` for a glob. */
  name: string;
  /** The path it names; a first segment of `""` is a crate named from the root (`::x`). */
  path: string[];
  /** `Frame as F`, as written, when the binding renames. */
  renamed?: string | undefined;
  /** The whole `use …;`. */
  statement: string;
  /** Where the statement is in the file's code. */
  at: number;
}

interface Bound<T> {
  value: T;
  /** Whether the binding may not hold where a name is used: cfg'd, or inside a block. */
  conditional: boolean;
}

export interface Module {
  id: string;
  file: string;
  crate: string;
  /** The crate root it is in; `undefined` for a file no root declares. */
  root: Module | undefined;
  parent: Module | undefined;
  /** Where the files of the modules it declares out of line are. */
  dir: string;
  /** How many bodies define it: cfg'd twins of an inline module are one module of two. */
  spans: number;
  /**
   * A module declared where its body can't be read (`#[path]`, a file that isn't there): every
   * name in it is unresolved.
   */
  opaque: boolean;
  children: Map<string, Bound<Module>[]>;
  items: Map<string, Bound<Item>[]>;
  uses: Map<string, Bound<UseBinding>[]>;
  globs: Bound<UseBinding>[];
  /** Every binding, globs and `as _` included, in the order they are written. */
  bindings: UseBinding[];
}

/**
 * What a path names: the items and modules it settles on, and the names it couldn't settle,
 * each the last name of a path whose resolution stopped short. Nothing at all is a path into a
 * crate outside the workspace.
 */
export interface Resolution {
  items: Item[];
  modules: Module[];
  unresolved: Set<string>;
}

/** A workspace crate: its directory, the names code calls it by, and the crates it depends on. */
export interface CrateInfo {
  dir: string;
  idents: string[];
  deps: string[];
}

interface Region {
  module: Module;
  start: number;
  end: number;
  inner: Region[];
}

/** An attribute that may leave its item out: `#[cfg(…)]`, or a `cfg_attr` that adds one. */
const CFG = /#\s*\[\s*(?:cfg\s*\(|cfg_attr\s*\([^\]]*\bcfg\s*\()/;

/** An attribute that may move a module's file: `#[path = …]`, or a `cfg_attr` that adds one. */
const PATH = /#\s*\[\s*(?:path\b|cfg_attr\s*\([^\]]*\bpath\s*=)/;

const ALWAYS_EXTERNAL = new Set(["std", "core", "alloc"]);

const ITEM_TOKENS =
  /[{}]|\b(?:(mod)\s+(\w+)\s*(?=[{;])|(struct|enum|trait|type)\s+(\w+)|(union)\s+(\w+)(?=\s*[<{])|(use)\b|extern\s+crate\s+(\w+)(?:\s+as\s+(\w+))?\s*;)/g;

/**
 * The attributes written on the item whose first keyword is at `at`, past its visibility and
 * qualifiers (`#[cfg(unix)] pub(crate) unsafe fn`).
 */
function attributesBefore(code: string, from: number, at: number): string {
  let i = at;
  const space = () => {
    while (i > from && /\s/.test(code[i - 1] ?? "")) i--;
  };
  space();
  for (;;) {
    const word = /\b(?:unsafe|async|const|pub)$/.exec(code.slice(Math.max(from, i - 7), i));
    if (word !== null) {
      i -= word[0].length;
      space();
      continue;
    }
    const open = code[i - 1] === ")" ? code.lastIndexOf("(", i) : -1;
    if (open > from && /\bpub\s*$/.test(code.slice(Math.max(from, open - 5), open))) {
      i = open;
      space();
      continue;
    }
    break;
  }
  const end = i;
  while (code[i - 1] === "]") {
    let j = i - 1;
    for (let depth = 0; j >= from; j--) {
      if (code[j] === "]") depth++;
      else if (code[j] === "[" && --depth === 0) break;
    }
    let k = j;
    while (k > from && /\s/.test(code[k - 1] ?? "")) k--;
    if (code[k - 1] !== "#") break;
    i = k - 1;
    space();
  }
  return code.slice(i, end);
}

const KEYWORDS = new Set(
  (
    "as async await break const continue crate dyn else enum extern false fn for if impl in let " +
    "loop match mod move mut pub ref return self Self static struct super trait true type unsafe " +
    "use where while _"
  ).split(" "),
);

const empty = (): Resolution => ({ items: [], modules: [], unresolved: new Set() });
const unresolved = (name: string): Resolution => ({ ...empty(), unresolved: new Set([name]) });

function merge(into: Resolution, from: Resolution): Resolution {
  for (const item of from.items) if (!into.items.includes(item)) into.items.push(item);
  for (const module of from.modules) if (!into.modules.includes(module)) into.modules.push(module);
  for (const name of from.unresolved) into.unresolved.add(name);
  return into;
}

const isEmpty = (r: Resolution) =>
  r.items.length === 0 && r.modules.length === 0 && r.unresolved.size === 0;

function push<T>(map: Map<string, T[]>, key: string, value: T) {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else list.push(value);
}

/**
 * The bindings of a `use` statement's tree, the text after `use` up to its `;`: each with its
 * name and the path it names, `self` in a group naming the path before it, and a glob as `*`.
 * `x as _` binds no name, so it comes back only as a rename to `_`.
 */
export function useTree(
  tree: string,
): { name: string; path: string[]; renamed?: string | undefined }[] {
  const tokens = [...tree.matchAll(/::|[{},*]|(?:r#)?\w+/g)].map((m) => m[0]);
  const out: { name: string; path: string[]; renamed?: string | undefined }[] = [];
  let i = 0;
  const parse = (prefix: string[]) => {
    const segments: string[] = [];
    if (tokens[i] === "::") {
      if (prefix.length === 0) segments.push("");
      i++;
    }
    for (;;) {
      const token = tokens[i];
      if (token === "{") {
        i++;
        while (i < tokens.length && tokens[i] !== "}") {
          const before = i;
          parse([...prefix, ...segments]);
          if (tokens[i] === ",") i++;
          else if (i === before) i++;
        }
        i++;
        return;
      }
      if (token === "*") {
        i++;
        out.push({ name: "*", path: [...prefix, ...segments] });
        return;
      }
      if (token === undefined || token === "," || token === "}" || token === "::") return;
      segments.push(token.replace(/^r#/, ""));
      i++;
      if (tokens[i] !== "::") break;
      i++;
    }
    let alias: string | undefined;
    if (tokens[i] === "as") {
      alias = tokens[i + 1];
      i += 2;
    }
    const written = segments.at(-1) ?? "";
    let path = [...prefix, ...segments];
    if (path.at(-1) === "self") path = path.slice(0, -1);
    const name = alias ?? path.at(-1);
    if (name === undefined || name === "") return;
    out.push({ name, path, renamed: alias === undefined ? undefined : `${written} as ${alias}` });
  };
  while (i < tokens.length) {
    const before = i;
    parse([]);
    if (i === before) i++;
  }
  return out;
}

/**
 * The path ending at the name at `at` in `text`: the names before it joined by `::`, with `""`
 * first for a path from the root (`::x::Y`). `undefined` when a `>` comes before a `::`
 * (`<T as Trait>::Out`, `a::<T>::B`), which can't be followed.
 */
export function pathBefore(text: string, at: number, name: string): string[] | undefined {
  const segments = [name];
  for (let i = at; ;) {
    let j = i;
    while (j > 0 && /\s/.test(text[j - 1] ?? "")) j--;
    if (text[j - 1] !== ":" || text[j - 2] !== ":") return segments;
    j -= 2;
    while (j > 0 && /\s/.test(text[j - 1] ?? "")) j--;
    let k = j;
    while (k > 0 && /\w/.test(text[k - 1] ?? "")) k--;
    if (k === j) {
      if (text[j - 1] === ">") return undefined;
      segments.unshift("");
      return segments;
    }
    segments.unshift(text.slice(k, j));
    i = k;
  }
}

/**
 * Each path in `text` that ends at a name and isn't a keyword or a lifetime: `Vec<direct::Step>`
 * has `Vec` and `direct::Step`. `path` is `undefined` for one that can't be followed.
 */
export function typePaths(text: string): { name: string; path: string[] | undefined }[] {
  const out: { name: string; path: string[] | undefined }[] = [];
  for (const m of text.matchAll(/(?<!['\w#])[A-Za-z_]\w*/g)) {
    const name = m[0];
    if (KEYWORDS.has(name) || /^\s*::/.test(text.slice(m.index + name.length))) continue;
    out.push({ name, path: pathBefore(text, m.index, name) });
  }
  return out;
}

/**
 * A workspace's modules, built from each crate's roots (`lib.rs`, `main.rs`, `bin/*.rs`) through
 * the modules they declare, out of line or inline, with what each defines and binds. `files` is
 * each product file's code, comments and strings emptied and test code blanked; a file no root
 * declares is a module of its own, whose `crate::` and `super::` can't be followed.
 */
export class ModuleTable {
  readonly items: Item[] = [];
  private readonly modules: Module[] = [];
  private readonly regions = new Map<string, Region[]>();
  private readonly libs = new Map<string, Module>();
  private readonly crates = new Map<string, string[]>();
  private readonly deps = new Map<string, Set<string>>();
  private readonly memo = new Map<string, Resolution>();
  private readonly busy = new Set<string>();

  private readonly files: Map<string, string>;

  constructor(files: Map<string, string>, crates: CrateInfo[]) {
    this.files = files;
    for (const crate of crates) {
      for (const ident of crate.idents) push(this.crates, ident, crate.dir);
      this.deps.set(crate.dir, new Set(crate.deps));
    }
    const reached = new Set<string>();
    for (const crate of crates) {
      const src = `${crate.dir}/src/`;
      const roots = [...files.keys()].filter(
        (f) =>
          f === `${src}lib.rs` ||
          f === `${src}main.rs` ||
          new RegExp(`^${src}bin/(?:[^/]+\\.rs|[^/]+/main\\.rs)$`).test(f),
      );
      for (const file of roots) {
        const root = this.module(file, file, crate.dir, undefined, file.replace(/[^/]+$/, ""));
        root.root = root;
        if (file === `${src}lib.rs`) this.libs.set(crate.dir, root);
        this.visitFile(root, reached);
      }
    }
    for (const file of [...files.keys()].filter((f) => !reached.has(f))) {
      const dir = /(?:^|\/)(?:lib|main|mod)\.rs$/.test(file)
        ? file.replace(/[^/]+$/, "")
        : file.replace(/\.rs$/, "/");
      const crate = /^crates\/[^/]+/.exec(file)?.[0] ?? "";
      this.visitFile(this.module(file, file, crate, undefined, dir), reached);
    }
  }

  /** The modules the code at `at` in `file` is in: one for each crate root that reaches it. */
  modulesAt(file: string, at: number): Module[] {
    return (this.regions.get(file) ?? []).map((region) => {
      let r = region;
      for (let inner = r.inner.find((i) => i.start <= at && at < i.end); inner !== undefined;) {
        r = inner;
        inner = r.inner.find((i) => i.start <= at && at < i.end);
      }
      return r.module;
    });
  }

  /** Every module whose code is in `file`. */
  modulesIn(file: string): Module[] {
    return this.modules.filter((m) => m.file === file);
  }

  /** What `path`, written in `module`, names. */
  resolve(module: Module, path: string[]): Resolution {
    const last = path.at(-1) ?? "";
    const [first = "", ...rest] = path;
    let at: Resolution;
    let tail = rest;
    if (first === "") {
      at = this.externCrate(module, rest[0] ?? "");
      tail = rest.slice(1);
    } else if (first === "crate") {
      at = module.root === undefined ? unresolved(last) : { ...empty(), modules: [module.root] };
    } else if (first === "self") {
      at = { ...empty(), modules: [module] };
    } else if (first === "super") {
      at =
        module.parent === undefined ? unresolved(last) : { ...empty(), modules: [module.parent] };
    } else {
      at = this.name(module, first, true);
    }
    if (tail.length === 0) return at;
    const out = empty();
    if (at.items.length > 0 || at.unresolved.size > 0) out.unresolved.add(last);
    let modules = at.modules;
    tail.forEach((segment, i) => {
      if (segment === "self") return;
      if (segment === "super") {
        if (modules.some((m) => m.parent === undefined)) out.unresolved.add(last);
        modules = modules.flatMap((m) => (m.parent === undefined ? [] : [m.parent]));
        return;
      }
      const found = modules.map((m) => this.name(m, segment, false));
      if (i === tail.length - 1) {
        for (const r of found) merge(out, r);
        return;
      }
      if (found.some((r) => r.items.length > 0 || r.unresolved.size > 0)) out.unresolved.add(last);
      modules = [...new Set(found.flatMap((r) => r.modules))];
    });
    if (tail.at(-1) === "self" || tail.at(-1) === "super") out.modules.push(...modules);
    return out;
  }

  private module(
    id: string,
    file: string,
    crate: string,
    parent: Module | undefined,
    dir: string,
  ): Module {
    const module: Module = {
      id,
      file,
      crate,
      root: parent?.root,
      parent,
      dir,
      spans: 1,
      opaque: false,
      children: new Map(),
      items: new Map(),
      uses: new Map(),
      globs: [],
      bindings: [],
    };
    this.modules.push(module);
    return module;
  }

  private visitFile(module: Module, reached: Set<string>) {
    reached.add(module.file);
    const code = this.files.get(module.file) ?? "";
    const region: Region = { module, start: 0, end: code.length, inner: [] };
    push(this.regions, module.file, region);
    this.visit(module, region, code, 0, code.length, reached);
  }

  /** Reads the items, `use`s and modules of `module`'s body, from `from` to `to` in `code`. */
  private visit(
    module: Module,
    region: Region,
    code: string,
    from: number,
    to: number,
    reached: Set<string>,
  ) {
    const blocks: ("fn" | "assoc" | "macro" | "other")[] = [];
    const tokens = new RegExp(ITEM_TOKENS.source, "g");
    tokens.lastIndex = from;
    for (let m = tokens.exec(code); m !== null && m.index < to; m = tokens.exec(code)) {
      if (m[0] === "{") {
        blocks.push(blockKind(code, from, m.index));
        continue;
      }
      if (m[0] === "}") {
        blocks.pop();
        continue;
      }
      if (code[m.index - 1] === "#") continue;
      const solid = blocks.filter((b) => b !== "macro");
      const attributes = attributesBefore(code, from, m.index);
      const conditional = solid.length > 0 || CFG.test(attributes);
      if (m[1] !== undefined) {
        const name = m[2] ?? "";
        const after = m.index + m[0].length;
        const dir = `${module.dir}${name}/`;
        if (code[after] === "{") {
          const end = itemEnd(code, after);
          const child = this.child(module, name, module.file, dir, conditional);
          const inner: Region = { module: child, start: after + 1, end: end - 1, inner: [] };
          region.inner.push(inner);
          this.visit(child, inner, code, after + 1, end - 1, reached);
          tokens.lastIndex = end;
        } else {
          const file =
            solid.length === 0 && !PATH.test(attributes)
              ? [`${module.dir}${name}.rs`, `${dir}mod.rs`].find((f) => this.files.has(f))
              : undefined;
          const declared = module.children.get(name)?.some((c) => c.value.file === file);
          if (file !== undefined && !reached.has(file)) {
            this.visitFile(this.child(module, name, file, dir, conditional), reached);
          } else if (file !== undefined && declared === true) {
            this.child(module, name, file, dir, conditional);
          } else {
            this.child(module, name, module.file, dir, conditional).opaque = true;
          }
        }
        continue;
      }
      const kind = m[3] ?? m[5];
      if (isItemKind(kind)) {
        if (kind === "type" && solid.at(-1) === "assoc") continue;
        const item: Item = {
          name: m[4] ?? m[6] ?? "",
          kind,
          module,
          file: module.file,
          at: m.index,
          text: code.slice(m.index, itemEnd(code, m.index)),
        };
        this.items.push(item);
        push(module.items, item.name, { value: item, conditional });
        continue;
      }
      const end = m[7] === undefined ? m.index + m[0].length : code.indexOf(";", m.index) + 1;
      const statement = code.slice(m.index, end === 0 ? to : end);
      const bindings =
        m[7] === undefined
          ? m[8] === "self"
            ? []
            : [{ name: m[9] ?? m[8] ?? "", path: ["", m[8] ?? ""], renamed: undefined }]
          : useTree(statement.slice(3, -1));
      for (const b of bindings) {
        const binding: UseBinding = { ...b, statement, at: m.index };
        module.bindings.push(binding);
        if (b.name === "*") module.globs.push({ value: binding, conditional });
        else if (b.name !== "_") push(module.uses, b.name, { value: binding, conditional });
      }
      if (end > 0) tokens.lastIndex = end;
    }
  }

  /**
   * The module `parent` declares as `name`, its body in `file`. A second declaration of it is a
   * cfg'd twin, one module of two bodies; a declaration that may not hold (cfg'd, or in a block)
   * makes the module one that adds to what its name names and shadows nothing.
   */
  private child(
    parent: Module,
    name: string,
    file: string,
    dir: string,
    conditional: boolean,
  ): Module {
    const twin = parent.children.get(name)?.find((c) => c.value.file === file);
    if (twin !== undefined) {
      twin.value.spans++;
      twin.conditional ||= conditional;
      return twin.value;
    }
    const child = this.module(`${parent.id}::${name}`, file, parent.crate, parent, dir);
    push(parent.children, name, { value: child, conditional });
    return child;
  }

  /** A crate named at the root of a path: a workspace crate, one outside it, or unknown. */
  private externCrate(module: Module, name: string): Resolution {
    const crates = this.crates.get(name);
    if (crates !== undefined) {
      const libs = crates.map((c) => this.libs.get(c));
      const found = libs.filter((l): l is Module => l !== undefined);
      return found.length === libs.length ? { ...empty(), modules: found } : unresolved(name);
    }
    if (ALWAYS_EXTERNAL.has(name) || (this.deps.get(module.crate)?.has(name) ?? false)) {
      return empty();
    }
    return unresolved(name);
  }

  /**
   * What `name` names in `module`. Its own items, modules and `use`s shadow its globs, but only
   * those sure to hold wherever the name is used: a cfg'd one, one inside a block, or one of a
   * cfg'd twin may not, so it adds to what the name names and shadows nothing. `first` is a
   * path's first name, which may also be a crate.
   */
  private name(module: Module, name: string, first: boolean): Resolution {
    const key = `${module.id}\0${name}\0${String(first)}`;
    const known = this.memo.get(key);
    if (known !== undefined) return known;
    if (this.busy.has(key) || module.opaque) return unresolved(name);
    this.busy.add(key);
    const sure = empty();
    const maybe = empty();
    let shadows = false;
    const twin = module.spans > 1;
    for (const { value, conditional } of module.items.get(name) ?? []) {
      (conditional || twin ? maybe : sure).items.push(value);
      shadows ||= !conditional && !twin;
    }
    for (const { value, conditional } of module.children.get(name) ?? []) {
      (conditional || twin ? maybe : sure).modules.push(value);
      shadows ||= !conditional && !twin;
    }
    for (const { value, conditional } of module.uses.get(name) ?? []) {
      merge(conditional || twin ? maybe : sure, this.followUse(module, value));
      shadows ||= !conditional && !twin;
    }
    let out: Resolution;
    if (shadows) {
      out = merge(sure, maybe);
    } else {
      const globbed = empty();
      for (const { value } of module.globs) {
        const target = this.resolve(module, value.path);
        if (target.items.length > 0 || target.unresolved.size > 0) globbed.unresolved.add(name);
        for (const m of target.modules) merge(globbed, this.name(m, name, false));
      }
      const found = globbed.items.length > 0 || globbed.modules.length > 0;
      if (first && !found && this.isCrate(module, name)) {
        out = merge(this.externCrate(module, name), maybe);
      } else {
        out = merge(globbed, maybe);
        if (isEmpty(out)) out = first ? this.externCrate(module, name) : unresolved(name);
      }
    }
    this.busy.delete(key);
    this.memo.set(key, out);
    return out;
  }

  private isCrate(module: Module, name: string): boolean {
    return (
      this.crates.has(name) ||
      ALWAYS_EXTERNAL.has(name) ||
      (this.deps.get(module.crate)?.has(name) ?? false)
    );
  }

  /** What a `use` binding names, from the module it is written in. */
  private followUse(module: Module, use: UseBinding): Resolution {
    const [first = "", ...rest] = use.path;
    if (first === use.name && rest.length === 0) return this.externCrate(module, first);
    return this.resolve(module, use.path);
  }
}

/** The kind of block a `{` at `at` opens: a function's body, an impl's or trait's, a macro's. */
function blockKind(code: string, from: number, at: number): "fn" | "assoc" | "macro" | "other" {
  let i = at - 1;
  while (i >= from && !";{}".includes(code[i] ?? "")) i--;
  const head = code.slice(i + 1, at);
  if (/!\s*(?:\w+\s*)?$/.test(head)) return "macro";
  if (/\bfn\b/.test(head)) return "fn";
  if (/\b(?:impl|trait)\b/.test(head)) return "assoc";
  return "other";
}
