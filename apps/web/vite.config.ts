import optimizeLocales from "@react-aria/optimize-locales-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { answer, refuseUpgrade, servesHere } from "./src/dev/loopback.ts";

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
 * Vite's CLI closes the dev server on SIGTERM only, so Ctrl-C killed it and `pnpm dev` reported
 * it failed. This closes it the same way on SIGINT. A restarted server adds its own handler, so
 * each one removes its handler when it closes.
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

export default defineConfig({
  // The UI is written in English, so React Aria's strings for its other locales (the dialog's
  // hidden dismiss button, among others) would only add weight.
  plugins: [react(), optimizeLocales.vite({ locales: ["en-US"] }), closeOnSigint(), loopbackOnly()],
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
