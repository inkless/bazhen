import { tmpdir } from "node:os";
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
});
