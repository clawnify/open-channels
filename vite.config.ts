import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    // Optional remote preview: VITE_DEV_HOST=<tailscale-ip> pnpm dev binds the
    // UI to that interface only (e.g. the tailnet); default stays localhost.
    host: process.env.VITE_DEV_HOST,
    // Allow previewing the dev server over Tailscale Serve (tailnet-only).
    allowedHosts: [".ts.net"],
    proxy: {
      "/api": {
        target: "http://localhost:8787",
        changeOrigin: true,
        // Local-only stand-in for the platform perimeter, which injects these
        // verified headers in production (and strips client-supplied ones).
        // Without them every org-scoped route correctly returns 401.
        headers: {
          "X-Clawnify-Caller": "user",
          "X-Clawnify-Org-Id": "local-dev-org",
          "X-Clawnify-User-Id": "local-dev-user",
          "X-Clawnify-User-Name": "Local Dev",
        },
      },
    },
  },
});
