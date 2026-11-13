import optimizeLocales from "@react-aria/optimize-locales-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { DEV_ORIGINS_HEADER, originList, originsProblem } from "@bazhen/protocol";

const daemon = `http://127.0.0.1:${process.env.BAZHEN_PORT ?? 7900}`;

/**
 * The hosts of the external origins the daemon admits too (BAZHEN_EXTERNAL_ORIGINS), so the dev
 * server answers them and no other host. Checked as the daemon checks them, so a bad list stops
 * both rather than one admitting what the other refuses.
 */
function externalHosts(env: NodeJS.ProcessEnv): string[] {
  const origins = originList(env.BAZHEN_EXTERNAL_ORIGINS);
  const problem = originsProblem(origins, env.BAZHEN_ALLOW_INSECURE_ORIGINS === "true");
  if (problem !== null) throw new Error(`BAZHEN_EXTERNAL_ORIGINS: ${problem}`);
  return origins.map((origin) => new URL(origin).hostname);
}

/**
 * Stops the dev server if it admits an external origin the running daemon doesn't. Its proxy
 * rewrites Host to the daemon's loopback address, so the daemon can't tell such a request from
 * loopback's own by its Host; it still asks a forwarded one to pair, and this keeps the two from
 * disagreeing at all. Every proxied request says which origins this server admits, and the
 * daemon refuses one that names an origin it doesn't; this asks it once at start, waiting for a
 * daemon `pnpm dev` starts alongside.
 */
const sameOriginsAsDaemon = (origins: readonly string[]): Plugin => ({
  name: "bazhen:same-origins-as-daemon",
  apply: "serve",
  configureServer(server) {
    const ask = async (): Promise<void> => {
      for (;;) {
        const status = await fetch(`${daemon}/v1/health`, {
          headers: { [DEV_ORIGINS_HEADER]: origins.join(",") },
        }).then(
          (res) => res.status,
          () => null,
        );
        if (status === MISDIRECTED) {
          server.config.logger.error(
            `bazhen: the daemon doesn't admit all of ${origins.join(", ")}, which this dev ` +
              "server does; start both with the same BAZHEN_EXTERNAL_ORIGINS",
          );
          process.exit(1);
        }
        if (status !== null) return;
        await new Promise((resolve) => setTimeout(resolve, DAEMON_POLL_MS));
      }
    };
    if (origins.length > 0) void ask();
  },
});
const DAEMON_POLL_MS = 1000;
const MISDIRECTED = 421;

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
        () => process.exit(process.exitCode ?? 0),
        () => process.exit(1),
      );
    process.once("SIGINT", close);
    server.httpServer?.once("close", () => process.off("SIGINT", close));
  },
});

export default defineConfig({
  // The UI is written in English, so React Aria's strings for its other locales (the dialog's
  // hidden dismiss button, among others) would only add weight.
  plugins: [
    react(),
    optimizeLocales.vite({ locales: ["en-US"] }),
    closeOnSigint(),
    sameOriginsAsDaemon(originList(process.env.BAZHEN_EXTERNAL_ORIGINS)),
  ],
  server: {
    host: "127.0.0.1",
    port: Number(process.env.BAZHEN_WEB_PORT ?? 7901),
    strictPort: true,
    allowedHosts: externalHosts(process.env),
    // xfwd passes on the chain of who the request came from, which the daemon reads to ask a
    // request from another machine to pair (foundation-design §9.2).
    proxy: {
      "/v1": {
        target: daemon,
        changeOrigin: true,
        ws: true,
        xfwd: true,
        headers: {
          [DEV_ORIGINS_HEADER]: originList(process.env.BAZHEN_EXTERNAL_ORIGINS).join(","),
        },
      },
    },
  },
});
