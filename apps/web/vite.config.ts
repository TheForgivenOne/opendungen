import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [tailwindcss()],
  server: {
    // IPv4 loopback: the default `localhost` host resolves to ::1 here,
    // leaving 127.0.0.1 unbound (same class of issue as the worker's
    // [dev] ip in apps/api/wrangler.toml). Verified 2026-10-12.
    host: "127.0.0.1",
    port: 5173,
    // Allow Cloudflare quick-tunnel hosts (local dev sharing only;
    // production serves the built bundle, never this dev server).
    allowedHosts: [".trycloudflare.com"],
    proxy: {
      // IPv4 loopback to match the worker's [dev] ip (see apps/api/wrangler.toml).
      "/api": {
        target: "http://127.0.0.1:8787",
        changeOrigin: true,
        // The browser's request is same-origin to the dev server, but
        // the proxy forwards its `Origin: http://127.0.0.1:5173` while
        // the API sees its own origin (8787) — which the API's CSRF
        // check would reject. Present the proxied request as
        // same-origin to the API (dev only; production serves
        // frontend and API from one origin, split deployments use
        // CORS_ORIGINS which the API trusts for CSRF).
        configure: (proxy) => {
          proxy.on("proxyReq", (proxyReq) => {
            proxyReq.setHeader("origin", "http://127.0.0.1:8787");
          });
        },
      },
    },
  },
});
