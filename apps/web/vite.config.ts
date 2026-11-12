import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const daemon = `http://127.0.0.1:${process.env.BAZHEN_PORT ?? 7900}`;

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: Number(process.env.BAZHEN_WEB_PORT ?? 5173),
    strictPort: true,
    // The daemon accepts actions only from its own origin, so the dev proxy presents that one.
    proxy: { "/v1": { target: daemon, changeOrigin: true, ws: true, headers: { origin: daemon } } },
  },
});
