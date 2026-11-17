import { describe, expect, it } from "vitest";
import {
  type CrateInfo,
  type Module,
  ModuleTable,
  type Resolution,
  typePaths,
  useTree,
} from "./rust-modules.ts";

const A: CrateInfo = { dir: "crates/a", idents: ["a"], deps: ["serde"] };

const tableOf = (files: Record<string, string>, crates: CrateInfo[] = [A]) =>
  new ModuleTable(new Map(Object.entries(files)), crates);

/** The module `id` names, by the id the table gives it. */
function moduleOf(table: ModuleTable, file: string, id = file): Module {
  const module = table.modulesIn(file).find((m) => m.id === id);
  if (module === undefined) throw new Error(`no module ${id} in ${file}`);
  return module;
}

/** What a path resolves to, as `module::Name` ids and the names left unresolved. */
const named = (r: Resolution) => ({
  items: r.items.map((i) => `${i.module.id}::${i.name}`).toSorted(),
  unresolved: [...r.unresolved].toSorted(),
});

const resolve = (table: ModuleTable, module: Module, path: string) =>
  named(table.resolve(module, path.split("::")));

const LIB = "crates/a/src/lib.rs";

describe("useTree", () => {
  it("binds each name of a tree to its path, through groups, renames and self", () => {
    expect(useTree("a::b::{c, d::{e as f, self}, g::*}")).toEqual([
      { name: "c", path: ["a", "b", "c"] },
      { name: "f", path: ["a", "b", "d", "e"], renamed: "e as f" },
      { name: "d", path: ["a", "b", "d"] },
      { name: "*", path: ["a", "b", "g"] },
    ]);
  });

  it("binds a path from the root, a raw name, and nothing for `as _`", () => {
    expect(useTree("::q::Frame")).toEqual([{ name: "Frame", path: ["", "q", "Frame"] }]);
    expect(useTree("crate::r#type::Kind")).toEqual([
      { name: "Kind", path: ["crate", "type", "Kind"] },
    ]);
    expect(useTree("std::io::Read as _")).toEqual([
      { name: "_", path: ["std", "io", "Read"], renamed: "Read as _" },
    ]);
    expect(useTree("q::{self as hq}")).toEqual([
      { name: "hq", path: ["q"], renamed: "self as hq" },
    ]);
  });
});

describe("typePaths", () => {
  it("finds each path ending at a name, skipping keywords and lifetimes", () => {
    expect(typePaths("&'a mut Vec<direct::Step<T>>, ::q::Frame")).toEqual([
      { name: "Vec", path: ["Vec"] },
      { name: "Step", path: ["direct", "Step"] },
      { name: "T", path: ["T"] },
      { name: "Frame", path: ["", "q", "Frame"] },
    ]);
  });

  it("can't follow a path after a qualified type or generic arguments", () => {
    expect(typePaths("<T as Tr>::Out")).toEqual([
      { name: "T", path: ["T"] },
      { name: "Tr", path: ["Tr"] },
      { name: "Out", path: undefined },
    ]);
  });
});

describe("ModuleTable.resolve", () => {
  const steps = {
    [LIB]: "pub mod tasks;\npub mod attach;\npub mod uses;\n",
    "crates/a/src/tasks.rs": "pub type Step<T> = Result<T, Stop>;\npub struct Stop;\n",
    "crates/a/src/attach/mod.rs": "pub mod direct;\npub use direct::Step;\n",
    "crates/a/src/attach/direct.rs": "pub enum Step { Show(Vec<u8>) }\n",
    "crates/a/src/uses.rs": [
      "use crate::tasks::Step;",
      "use crate::attach::{direct, Step as Byte};",
      "use super::tasks;",
    ].join("\n"),
  };

  it("settles a name on the type its module brings in, not another of that name", () => {
    const table = tableOf(steps);
    const uses = moduleOf(table, "crates/a/src/uses.rs", `${LIB}::uses`);
    const alias = { items: [`${LIB}::tasks::Step`], unresolved: [] };
    const byte = { items: [`${LIB}::attach::direct::Step`], unresolved: [] };
    expect(resolve(table, uses, "Step")).toEqual(alias);
    expect(resolve(table, uses, "tasks::Step")).toEqual(alias);
    expect(resolve(table, uses, "Byte")).toEqual(byte);
    expect(resolve(table, uses, "direct::Step")).toEqual(byte);
    expect(resolve(table, uses, "crate::attach::Step")).toEqual(byte);
    expect(resolve(table, uses, "super::attach::direct::Step")).toEqual(byte);
    expect(resolve(table, uses, "self::Byte")).toEqual(byte);
  });

  it("takes an item or a sure `use` over a glob, and a glob where nothing else binds the name", () => {
    const table = tableOf({
      [LIB]: "pub mod tasks;\npub mod attach;\npub mod one;\npub mod two;\n",
      "crates/a/src/tasks.rs": steps["crates/a/src/tasks.rs"],
      "crates/a/src/attach/mod.rs": steps["crates/a/src/attach/mod.rs"],
      "crates/a/src/attach/direct.rs": steps["crates/a/src/attach/direct.rs"],
      "crates/a/src/one.rs": "use crate::attach::*;\nuse crate::tasks::Step;\n",
      "crates/a/src/two.rs": "use crate::attach::*;\nuse crate::tasks::*;\n",
    });
    const one = moduleOf(table, "crates/a/src/one.rs", `${LIB}::one`);
    const two = moduleOf(table, "crates/a/src/two.rs", `${LIB}::two`);
    expect(resolve(table, one, "Step").items).toEqual([`${LIB}::tasks::Step`]);
    expect(resolve(table, two, "Step").items).toEqual([
      `${LIB}::attach::direct::Step`,
      `${LIB}::tasks::Step`,
    ]);
  });

  it("adds a cfg'd or block-scoped binding to the name and lets it shadow nothing", () => {
    const table = tableOf({
      [LIB]: [
        "pub mod tasks;",
        "pub mod attach;",
        "use attach::*;",
        "#[cfg(unix)]",
        "use tasks::Step;",
        "fn f() {",
        "    use crate::tasks::Stop;",
        "}",
        "pub struct Stop;",
      ].join("\n"),
      "crates/a/src/tasks.rs": steps["crates/a/src/tasks.rs"],
      "crates/a/src/attach/mod.rs": steps["crates/a/src/attach/mod.rs"],
      "crates/a/src/attach/direct.rs": steps["crates/a/src/attach/direct.rs"],
    });
    const root = moduleOf(table, LIB);
    expect(resolve(table, root, "Step").items).toEqual([
      `${LIB}::attach::direct::Step`,
      `${LIB}::tasks::Step`,
    ]);
    expect(resolve(table, root, "Stop").items).toEqual([`${LIB}::Stop`, `${LIB}::tasks::Stop`]);
  });

  it("unions cfg'd twins of an inline module, whichever of them defines the name", () => {
    const table = tableOf({
      [LIB]: [
        '#[cfg(target_os = "linux")]',
        "mod os {",
        "    pub struct Frame { b: Vec<u8> }",
        "}",
        '#[cfg(target_os = "macos")]',
        "mod os {",
        "    pub use crate::other::*;",
        "}",
        "mod other {",
        "    pub struct Frame;",
        "}",
      ].join("\n"),
    });
    const root = moduleOf(table, LIB);
    expect(resolve(table, root, "os::Frame").items).toEqual([
      `${LIB}::os::Frame`,
      `${LIB}::other::Frame`,
    ]);
  });

  it("adds a cfg'd or block-scoped module to its name and lets it shadow nothing", () => {
    const local = "    pub struct Step;\n";
    const table = tableOf({
      [LIB]: "pub mod attach;\npub mod a;\npub mod b;\npub mod c;\npub mod d;\n",
      "crates/a/src/attach/mod.rs": "pub mod direct;\n",
      "crates/a/src/attach/direct.rs": steps["crates/a/src/attach/direct.rs"],
      "crates/a/src/a.rs": `use crate::attach::*;\n#[cfg(windows)]\nmod direct {\n${local}}\n`,
      "crates/a/src/b.rs": "use crate::attach::*;\n#[cfg(windows)]\nmod direct;\n",
      "crates/a/src/b/direct.rs": "pub struct Step;\n",
      "crates/a/src/c.rs": `use crate::attach::*;\nfn g() {\n    mod direct {\n    ${local}    }\n}\n`,
      "crates/a/src/d.rs": `use crate::attach::*;\nmod direct {\n${local}}\n`,
    });
    const byte = `${LIB}::attach::direct::Step`;
    const step = (m: string) =>
      resolve(table, moduleOf(table, `crates/a/src/${m}.rs`, `${LIB}::${m}`), "direct::Step").items;
    expect(step("a")).toEqual([`${LIB}::a::direct::Step`, byte]);
    expect(step("b")).toEqual([byte, `${LIB}::b::direct::Step`]);
    expect(step("c")).toEqual([byte, `${LIB}::c::direct::Step`]);
    expect(step("d")).toEqual([`${LIB}::d::direct::Step`]);
  });

  it("takes a module whose file it can't read for one naming nothing it can settle", () => {
    const table = tableOf(
      {
        [LIB]: [
          '#[path = "x.rs"]',
          "mod log;",
          '#[cfg_attr(unix, path = "real.rs")]',
          "mod os;",
          "mod serde;",
        ].join("\n"),
        "crates/a/src/x.rs": "pub struct Step;\n",
        "crates/a/src/os.rs": "pub struct Frame;\n",
      },
      [{ ...A, deps: ["serde", "log"] }],
    );
    const root = moduleOf(table, LIB);
    expect(resolve(table, root, "log::Step")).toEqual({ items: [], unresolved: ["Step"] });
    expect(resolve(table, root, "os::Frame")).toEqual({ items: [], unresolved: ["Frame"] });
    expect(resolve(table, root, "serde::Value")).toEqual({ items: [], unresolved: ["Value"] });
  });

  it("finds the module code is in, an inline one's body included", () => {
    const code = "mod inner {\n    pub struct X;\n}\npub struct Y;\n";
    const table = tableOf({ [LIB]: code });
    expect(table.modulesAt(LIB, code.indexOf("X")).map((m) => m.id)).toEqual([`${LIB}::inner`]);
    expect(table.modulesAt(LIB, code.indexOf("Y")).map((m) => m.id)).toEqual([LIB]);
  });

  it("follows a workspace crate by any of its names, and a re-export through it", () => {
    const table = tableOf(
      {
        "crates/q/src/lib.rs": "pub mod frame;\npub use frame::Frame;\n",
        "crates/q/src/frame.rs": "pub struct Frame { b: Vec<u8> }\n",
        [LIB]: "use q as proto;\nextern crate q as eq;\nuse ::queue::frame;\n",
      },
      [A, { dir: "crates/q", idents: ["queue", "q"], deps: [] }],
    );
    const root = moduleOf(table, LIB);
    const frame = { items: ["crates/q/src/lib.rs::frame::Frame"], unresolved: [] };
    for (const path of ["proto::Frame", "eq::Frame", "frame::Frame", "q::frame::Frame"]) {
      expect(resolve(table, root, path)).toEqual(frame);
    }
  });

  it("takes a path into std or a declared dependency for one outside the workspace", () => {
    const table = tableOf({ [LIB]: "use std::io::Cursor;\nuse serde::Serialize;\n" });
    const root = moduleOf(table, LIB);
    const outside = { items: [], unresolved: [] };
    expect(resolve(table, root, "Cursor")).toEqual(outside);
    expect(resolve(table, root, "Serialize")).toEqual(outside);
    expect(resolve(table, root, "core::cell::Cell")).toEqual(outside);
    expect(resolve(table, root, "serde::de::Visitor")).toEqual(outside);
  });

  it("leaves unresolved what it can't follow, never taking it for a crate outside", () => {
    const table = tableOf(
      {
        "crates/q/src/frame.rs": "pub struct Frame { b: Vec<u8> }\n",
        [LIB]: [
          "pub mod gone;",
          '#[path = "elsewhere.rs"]',
          "mod moved;",
          "use mystery::Frame;",
          "use q::frame::Frame as Q;",
        ].join("\n"),
        "crates/a/src/moved.rs": "pub struct Moved;\n",
        "crates/a/src/detached.rs": "pub struct D;\n",
      },
      [A, { dir: "crates/q", idents: ["q"], deps: [] }],
    );
    const root = moduleOf(table, LIB);
    expect(resolve(table, root, "Frame")).toEqual({ items: [], unresolved: ["Frame"] });
    expect(resolve(table, root, "Q")).toEqual({ items: [], unresolved: ["Frame"] });
    expect(resolve(table, root, "gone::X")).toEqual({ items: [], unresolved: ["X"] });
    expect(resolve(table, root, "moved::Moved")).toEqual({ items: [], unresolved: ["Moved"] });
    expect(resolve(table, root, "String")).toEqual({ items: [], unresolved: ["String"] });
    expect(resolve(table, root, "crate::Nothing")).toEqual({ items: [], unresolved: ["Nothing"] });
    const detached = moduleOf(table, "crates/a/src/detached.rs");
    expect(resolve(table, detached, "crate::moved::Moved").unresolved).toEqual(["Moved"]);
    expect(resolve(table, detached, "D").items).toEqual(["crates/a/src/detached.rs::D"]);
  });

  it("gives main.rs and lib.rs crate roots of their own", () => {
    const table = tableOf({
      [LIB]: "pub struct Frame { b: Vec<u8> }\n",
      "crates/a/src/main.rs": "mod cli;\npub struct Frame;\n",
      "crates/a/src/cli.rs": "use crate::Frame;\nuse a::Frame as Lib;\n",
    });
    const cli = moduleOf(table, "crates/a/src/cli.rs", "crates/a/src/main.rs::cli");
    expect(resolve(table, cli, "Frame").items).toEqual(["crates/a/src/main.rs::Frame"]);
    expect(resolve(table, cli, "Lib").items).toEqual([`${LIB}::Frame`]);
  });

  it("ends a cycle of globs as unresolved, beside what the globs do find", () => {
    const table = tableOf({
      [LIB]: "pub mod x;\npub mod w;\npub mod z;\npub use x::*;\npub use z::*;\n",
      "crates/a/src/x.rs": "pub use super::*;\npub use crate::w::*;\n",
      "crates/a/src/w.rs": "pub struct Frame;\n",
      "crates/a/src/z.rs": "pub struct Frame;\n",
    });
    expect(resolve(table, moduleOf(table, LIB), "Frame")).toEqual({
      items: [`${LIB}::w::Frame`, `${LIB}::z::Frame`],
      unresolved: ["Frame"],
    });
  });
});
