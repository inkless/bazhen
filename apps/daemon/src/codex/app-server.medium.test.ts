import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { closeFakeServers, tempCodexHome as home, fakeServer } from "../testing/fake-app-server.ts";
import { AppServer, AppServerError, WrongCodexHome } from "./app-server.ts";

afterEach(closeFakeServers);

describe("app-server connection", () => {
  it("reads the server's version from initialize, and returns each request's result", async () => {
    const { codexHome, socket } = home();
    await fakeServer(socket, codexHome, (method) => ({ result: { echoed: method } }), "0.167.2");
    const server = await AppServer.connect(socket, codexHome);
    expect([server.version, await server.request("thread/start", {})]).toEqual([
      "0.167.2",
      { echoed: "thread/start" },
    ]);
    server.close();
  });

  it("refuses a server that answers for a different Codex home", async () => {
    const { codexHome, socket } = home();
    await fakeServer(socket, tmpdir());
    await expect(AppServer.connect(socket, codexHome)).rejects.toThrow(WrongCodexHome);
  });

  it("rejects a request the server answers with an error, with the server's code", async () => {
    const { codexHome, socket } = home();
    await fakeServer(socket, codexHome, () => ({
      error: { code: -32600, message: "Server is draining" },
    }));
    const server = await AppServer.connect(socket, codexHome);
    await expect(server.request("turn/start", {})).rejects.toEqual(
      expect.objectContaining({ code: -32600 }),
    );
    await expect(server.request("turn/start", {})).rejects.toBeInstanceOf(AppServerError);
    server.close();
  });

  it("fails a request in flight when the socket ends without a close frame", async () => {
    const { codexHome, socket } = home();
    await fakeServer(socket, codexHome, () => null);
    const server = await AppServer.connect(socket, codexHome);
    await expect(server.request("thread/start", {})).rejects.toThrow("ended");
    expect(server.open).toBe(false);
  });

  it("hands the server's own requests and notifications to its listener, and answers on the same connection", async () => {
    const { codexHome, socket } = home();
    const { wss, replies } = await fakeServer(socket, codexHome);
    const server = await AppServer.connect(socket, codexHome);
    const heard: unknown[] = [];
    server.listen({
      request: (method, params, id, respond) => {
        heard.push([method, params, id]);
        respond({ decision: "accept" });
      },
      notification: (method, params) => heard.push([method, params]),
    });
    for (const ws of wss.clients) {
      ws.send(
        JSON.stringify({
          id: 5,
          method: "item/commandExecution/requestApproval",
          params: { a: 1 },
        }),
      );
      ws.send(JSON.stringify({ method: "serverRequest/resolved", params: { requestId: 5 } }));
    }
    await expect.poll(() => replies).toEqual([{ id: 5, result: { decision: "accept" } }]);
    expect(heard).toEqual([
      ["item/commandExecution/requestApproval", { a: 1 }, 5],
      ["serverRequest/resolved", { requestId: 5 }],
    ]);
    server.close();
  });
});

/** How a Node process run with `args` ended: its exit code, and what it printed. */
const runNode = (args: string[]) =>
  new Promise<{ code: number | null; out: string; err: string }>((done) => {
    execFile(process.execPath, args, { encoding: "utf8" }, (error, out, err) =>
      done({ code: error === null ? 0 : Number(error.code), out, err }),
    );
  });

describe("an app-server that accepts the connection and never answers it", () => {
  it("is refused when the open times out, and its socket's error ends nothing", async () => {
    const { codexHome, socket } = home();
    // In a process of its own, since an unheard socket error ends the process it happens in.
    const caller = `
      import { createServer } from "node:net";
      import { AppServer } from ${JSON.stringify(fileURLToPath(new URL("app-server.ts", import.meta.url)))};
      const [socket, codexHome] = process.argv.slice(1);
      const held = [];
      createServer((c) => held.push(c)).listen(socket, async () => {
        await AppServer.connect(socket, codexHome, 50).catch(() => console.log("refused"));
        setTimeout(() => { console.log("lived"); process.exit(0); }, 200);
      });
    `;
    const ran = await runNode(["--input-type=module", "-e", caller, socket, codexHome]);
    expect(ran).toMatchObject({ code: 0, out: "refused\nlived\n" });
  });
});
