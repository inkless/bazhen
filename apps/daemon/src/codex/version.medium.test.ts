import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Store } from "../store/store.ts";
import { register } from "../testing/fixtures.ts";
import { recordCodexVersion } from "./version.ts";

const dbPath = () => join(mkdtempSync(join(tmpdir(), "bz-codex-version-")), "bazhen.db");

const versionEvents = (store: Store) =>
  store
    .events(0)
    .filter((e) => e.type === "environment.harness_version")
    .map((e) => e.payload);

describe("Codex's version", () => {
  it("is recorded the first time, and again only when the server answers on another", () => {
    const store = Store.open(dbPath());
    const { environmentId } = register(store);
    for (const v of ["0.166.0", "0.166.0", "0.167.2", "0.167.2"]) {
      recordCodexVersion(store, environmentId, v);
    }
    expect(versionEvents(store)).toEqual([
      { harness: "codex", version: "0.166.0", previous: null },
      { harness: "codex", version: "0.167.2", previous: "0.166.0" },
    ]);
  });

  it("is not recorded again by a daemon restarted on the same version", () => {
    const path = dbPath();
    const first = Store.open(path);
    const { environmentId } = register(first);
    recordCodexVersion(first, environmentId, "0.167.2");
    first.close();
    const second = Store.open(path);
    recordCodexVersion(second, environmentId, "0.167.2");
    expect(versionEvents(second)).toHaveLength(1);
  });
});
