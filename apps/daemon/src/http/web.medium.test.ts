import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeRuntime } from "@bazhen/core/testing";
import { DeviceAuth } from "../auth/devices.ts";
import { PairingCodes } from "../auth/pairing.ts";
import { Store } from "../store/store.ts";
import { tempDb } from "../testing/fixtures.ts";
import { createApp, type AppDeps } from "./app.ts";
import { BUNDLE, bundled, NOT_BUILT } from "./web.ts";

const host = "127.0.0.1:7900";
const INDEX = "<!doctype html><title>Bazhen</title>";
const SCRIPT = "console.log('app')";
const unused = () => Promise.reject(new Error("not used by these tests"));
const refuse = () => {
  throw new Error("not used by these tests");
};

/** A built bundle as Vite lays one out, with a secret beside it that it must never serve. */
function bundle(): string {
  const dir = mkdtempSync(join(tmpdir(), "bz-web-"));
  const root = join(dir, "dist");
  mkdirSync(join(root, "assets"), { recursive: true });
  writeFileSync(join(root, "index.html"), INDEX);
  writeFileSync(join(root, "assets", "index-abc123.js"), SCRIPT);
  writeFileSync(join(root, ".env"), "SECRET=1");
  writeFileSync(join(dir, "secret.txt"), "SECRET=1");
  symlinkSync(join(dir, "secret.txt"), join(root, "linked.txt"));
  // Names a still-encoded or Windows-style path would land on, were it read literally.
  writeFileSync(join(root, "assets", "up%2fsecret.txt"), "SECRET=1");
  writeFileSync(join(root, "assets", "up\\secret.txt"), "SECRET=1");
  return root;
}

/** The daemon's TCP app over `root`, with no browser paired and pairing required by default. */
function daemon(root: string = bundle(), always = true) {
  const store = Store.open(tempDb());
  const devices = new DeviceAuth(store, { log: () => {} });
  const deps: AppDeps = {
    appVersion: "0.1.0",
    schemaVersion: () => 1,
    runtime: new FakeRuntime(),
    allow: { hosts: [host], origins: [`http://${host}`] },
    state: () => ({
      epoch: "e1",
      eventId: 0,
      environments: [],
      agents: [],
      attention: [],
      messages: [],
      shells: [],
      tasks: [],
      assignments: [],
    }),
    launch: unused,
    answer: refuse,
    close: unused,
    respawn: unused,
    relaunch: unused,
    signal: unused,
    reply: refuse,
    dismiss: refuse,
    resend: refuse,
    openShell: unused,
    closeShell: unused,
    restartShell: unused,
    renameShell: unused,
    unlinkShell: unused,
    tasks: {
      create: refuse,
      show: refuse,
      assign: refuse,
      unassign: refuse,
      finish: refuse,
      delegate: refuse,
      escalate: refuse,
      send: refuse,
    },
    pairing: { codes: new PairingCodes({ log: () => {} }), devices },
    gate: { devices, always },
    web: { root },
  };
  const app = createApp(deps);
  return (path: string, init: { method?: string; headers?: Record<string, string> } = {}) =>
    app.request(path, { method: init.method ?? "GET", headers: { host, ...init.headers } });
}

describe("the daemon serving the built web app", () => {
  it("serves the app to a browser that hasn't paired, and still asks it to pair for the API", async () => {
    const request = daemon();
    const forwarded = { "x-forwarded-for": "192.168.1.30, 127.0.0.1" };
    const page = await request("/", { headers: forwarded });
    const api = await request("/v1/state", { headers: forwarded });
    expect([page.status, await page.text(), api.status]).toEqual([200, INDEX, 401]);
  });

  it("loads the app on a path that names no file, so a reload on any view works", async () => {
    const request = daemon();
    const res = await request("/agents/agent_1");
    expect([res.status, res.headers.get("content-type"), await res.text()]).toEqual([
      200,
      "text/html; charset=utf-8",
      INDEX,
    ]);
  });

  it("caches hashed assets for good and the app's page not at all", async () => {
    const request = daemon();
    const asset = await request("/assets/index-abc123.js");
    const page = await request("/");
    expect({
      asset: [await asset.text(), asset.headers.get("cache-control")],
      type: asset.headers.get("content-type"),
      page: page.headers.get("cache-control"),
    }).toEqual({
      asset: [SCRIPT, "public, max-age=31536000, immutable"],
      type: "text/javascript; charset=utf-8",
      page: "no-cache",
    });
  });

  it("answers a missing file 404 rather than serving the app's page in its place", async () => {
    const request = daemon();
    const statuses = await Promise.all(
      ["/assets/index-gone.js", "/favicon.ico"].map(async (p) => (await request(p)).status),
    );
    expect(statuses).toEqual([404, 404]);
  });

  it("forbids framing and type sniffing on what it serves, built or not", async () => {
    const request = daemon();
    const unbuilt = daemon(join(mkdtempSync(join(tmpdir(), "bz-web-")), "dist"));
    const responses = [await request("/"), await request("/assets/index-abc123.js")];
    responses.push(await unbuilt("/"));
    const headers = responses.map((res) => ({
      csp: res.headers.get("content-security-policy"),
      sniff: res.headers.get("x-content-type-options"),
      referrer: res.headers.get("referrer-policy"),
    }));
    const expected = { csp: "frame-ancestors 'none'", sniff: "nosniff", referrer: "no-referrer" };
    expect(headers).toEqual([expected, expected, expected]);
  });

  it("serves no dotfile, and nothing a symlink leads out of the bundle to", async () => {
    const request = daemon();
    const bodies = await Promise.all(
      ["/.env", "/linked.txt"].map(async (p) => (await request(p)).text()),
    );
    expect(bodies.filter((b) => b.includes("SECRET"))).toEqual([]);
  });

  it("finds no file by a name that still carries an escape or a backslash", async () => {
    const root = bundle();
    const found = await Promise.all(
      ["/assets/up%2fsecret.txt", "/assets/up\\secret.txt"].map((p) => bundled(root, p)),
    );
    expect(found).toEqual([null, null]);
  });

  it("finds no file for a path that climbs out of the bundle, however it is spelled", async () => {
    const root = bundle();
    // Raw, as a request URL can't carry them: the URL parser resolves dot segments first.
    const paths = [
      "/../secret.txt",
      "/assets/../../secret.txt",
      "/%2e%2e/secret.txt",
      "/assets/..%2f..%2fsecret.txt",
      "/assets\\..\\..\\secret.txt",
      "/./index.html",
      "//index.html",
    ];
    const found = await Promise.all(paths.map((p) => bundled(root, p)));
    expect(found).toEqual(paths.map(() => null));
  });

  it("puts every spelling of an API path behind pairing, or reaches no API route", async () => {
    const request = daemon();
    const spellings = [
      "/v1",
      "/v1/state",
      "//v1/state",
      "/v1//state",
      "/v1/./state",
      "/%76%31/state",
      "/V1/state",
      "/v1%2Fstate",
    ];
    const answers = await Promise.all(
      spellings.map(async (p) => {
        const res = await request(p);
        return (await res.text()).includes('"epoch"');
      }),
    );
    expect(answers).toEqual(spellings.map(() => false));
  });

  it("keeps an unknown API path an API 404, never the app's page", async () => {
    const request = daemon(bundle(), false);
    const res = await request("/v1/nothing");
    expect([res.status, (await res.text()).includes(INDEX)]).toEqual([404, false]);
  });

  it("answers only GET and HEAD off the API", async () => {
    const request = daemon();
    const statuses = await Promise.all(
      ["HEAD", "POST", "PUT", "DELETE"].map(
        async (method) => (await request("/", { method })).status,
      ),
    );
    expect(statuses).toEqual([200, 404, 404, 404]);
  });

  it("refuses the page to a Host it doesn't admit, as it refuses the API", async () => {
    const request = daemon();
    const res = await request("/", { headers: { host: "evil.example:7900" } });
    expect(res.status).toBe(421);
  });

  it("looks for the bundle where the web client's build leaves it", () => {
    expect([
      existsSync(join(BUNDLE, "..", "vite.config.ts")),
      existsSync(join(BUNDLE, "..", "index.html")),
      BUNDLE.endsWith(join("apps", "web", "dist")),
    ]).toEqual([true, true, true]);
  });

  it("says to build the app when there is no bundle, and serves the API regardless", async () => {
    const request = daemon(join(mkdtempSync(join(tmpdir(), "bz-web-")), "dist"));
    const page = await request("/");
    const pairing = await request("/v1/pairing", { method: "POST" });
    expect([page.status, await page.text(), pairing.status]).toEqual([404, NOT_BUILT, 403]);
  });
});
