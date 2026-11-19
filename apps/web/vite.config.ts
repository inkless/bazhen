import optimizeLocales from "@react-aria/optimize-locales-plugin";
import react from "@vitejs/plugin-react";
import { protocolId } from "@bazhen/protocol/id";
import { defineConfig, type Plugin, type ViteDevServer } from "vite";
import { answer, refuseUpgrade, servesHere } from "./src/dev/loopback.ts";
import { isClosedSocketError } from "./src/dev/proxy-log.ts";

const daemon = `http://127.0.0.1:${process.env.BAZHEN_PORT ?? 7900}`;
const port = Number(process.env.BAZHEN_WEB_PORT ?? 7901);

/**
 * Serves this machine's own browser only (`servesHere`), WebSocket upgrades included: Vite's HMR
 * socket answers module requests too. Its middleware runs before other plugins', after Vite's own
host and CORS checks.
 */
const loopbackOnly = (): Plugin => ({
  name: "bazhen:loopback-only",
  apply: "serve",
  enforce: "pre",
  configureServer(server) {
    server.httpServer?.prependListener("upgrade", (req, socket) => {
      if (!servesHere(req.headers, port)) refuseUpgrade(req, socket);
    });
    server.middlewares.use((req, res, next) => answer(req.headers, res, port, next));
  },
});

/**
 * Vite's CLI closes the dev server on SIGTERM only, so Ctrl-C killed it and `moon run :dev`
 * reported it failed. This closes it the same way on SIGINT. A restarted server adds its own
 * handler, so each one removes its handler when it closes.
 */
const closeOnSigint = (): Plugin => ({
  name: "bazhen:close-on-sigint",
  apply: "serve",
  configureServer(server) {
    const close = () =>
      void server.close().then(
        () => {
          console.log("bazhen web dev server stopped");
          process.exit(process.exitCode ?? 0);
        },
        () => process.exit(1),
      );
    process.once("SIGINT", close);
    server.httpServer?.once("close", () => process.off("SIGINT", close));
  },
});

/**
 * Drops the two stack traces Vite's proxy prints when a terminal stream ends mid-write
 * (`isClosedSocketError`). It filters Vite's own logger in place: a `customLogger` would replace
 * it, and with it `logLevel` and `clearScreen`.
 */
const quietClosedSockets = (): Plugin => ({
  name: "bazhen:quiet-closed-sockets",
  apply: "serve",
  configResolved({ logger }) {
    const error = logger.error.bind(logger);
    logger.error = (msg, options) => {
      if (!isClosedSocketError(msg, options)) error(msg, options);
    };
  },
});

const PROTOCOL_ID = "virtual:bazhen/protocol-id";
const isReader = (f: unknown): f is typeof protocolId => typeof f === "function";

/**
 * `virtual:bazhen/protocol-id`: the protocol id of the schema the page is built against. The dev
 * server reads it through its own module graph, which drops the protocol's modules when their
 * source changes; Node's cache would keep the id the server started with, and the page would ask
 * to reload for ever once the daemon restarted on an edit.
 */
const protocolIdentity = (): Plugin => {
  const resolved = `\0${PROTOCOL_ID}`;
  let server: ViteDevServer | undefined;
  return {
    name: "bazhen:protocol-id",
    configureServer(dev) {
      server = dev;
      dev.watcher.on("change", (file) => {
        if (!file.includes("/packages/protocol/src/")) return;
        const page = dev.moduleGraph.getModuleById(resolved);
        if (page !== undefined) dev.reloadModule(page).catch(() => undefined);
      });
    },
    resolveId: (id) => (id === PROTOCOL_ID ? resolved : undefined),
    async load(id) {
      if (id !== resolved) return undefined;
      const fresh = await server?.ssrLoadModule("@bazhen/protocol/id");
      const read: unknown = fresh === undefined ? protocolId : fresh["protocolId"];
      if (!isReader(read)) throw new Error("@bazhen/protocol/id has no protocolId");
      return `export default ${JSON.stringify(await read())};`;
    },
  };
};

export default defineConfig({
  // The UI is written in English, so React Aria's strings for its other locales (the dialog's
  // hidden dismiss button, among others) would only add weight.
  plugins: [
    react(),
    optimizeLocales.vite({ locales: ["en-US"] }),
    closeOnSigint(),
    loopbackOnly(),
    quietClosedSockets(),
    protocolIdentity(),
  ],
  server: {
    host: "127.0.0.1",
    port,
    strictPort: true,
    // xfwd passes on the chain of who a request came from, which the daemon reads to ask one from
    // another machine to pair (§9.2), should anything ever reach it past loopbackOnly.
    proxy: {
      "/v1": {
        target: daemon,
        changeOrigin: true,
        ws: true,
        xfwd: true,
      },
    },
  },
});
