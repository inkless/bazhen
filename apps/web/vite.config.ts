import optimizeLocales from "@react-aria/optimize-locales-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const daemon = `http://127.0.0.1:${process.env.BAZHEN_PORT ?? 7900}`;

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
  plugins: [react(), optimizeLocales.vite({ locales: ["en-US"] }), closeOnSigint()],
  server: {
    host: "127.0.0.1",
    port: Number(process.env.BAZHEN_WEB_PORT ?? 5173),
    strictPort: true,
    proxy: { "/v1": { target: daemon, changeOrigin: true, ws: true } },
  },
});
