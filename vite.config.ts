import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";
import preact from "@preact/preset-vite";
import { VitePWA } from "vite-plugin-pwa";

// GitHub Pages project sites live under /<repo>/. Set VITE_BASE=/<repo>/ at
// build time; local development and root deployments use "/".
const base = process.env.VITE_BASE ?? "/";

/**
 * The repo-root `VERSION` file is the single source of `__APP_VERSION__` (the
 * status strip, About dialog, PNG export and debug-log header). Reading the
 * file instead of `npm_package_version` keeps a bare `vite build` honest:
 * without npm it used to fall back to a hardcoded string that silently went
 * stale. `package.json` mirrors the version for npm metadata;
 * tests/unit/version.test.ts fails when the two drift.
 */
function appVersion(): string {
  const read = (rel: string) => {
    try {
      return readFileSync(new URL(rel, import.meta.url), "utf8");
    } catch {
      return "";
    }
  };
  const fromFile = read("./VERSION").trim();
  if (fromFile) return fromFile;
  const pkg = JSON.parse(read("./package.json") || "{}") as { version?: string };
  return pkg.version ?? "0.0.0";
}

const version = appVersion();
const buildHash = process.env.VITE_BUILD_HASH ?? "dev";

export default defineConfig({
  base,
  define: {
    __APP_VERSION__: JSON.stringify(version),
    __BUILD_HASH__: JSON.stringify(buildHash),
  },
  plugins: [
    preact(),
    VitePWA({
      registerType: "prompt",
      includeAssets: ["favicon.svg", "icons/icon-192.png", "icons/icon-512.png"],
      manifest: {
        name: "Vibro — Vibration Monitor",
        short_name: "Vibro",
        description: "Real-time vibration analysis: live sensor streaming, FFT, RMS and DVB1 burst files.",
        display: "standalone",
        background_color: "#070b10",
        theme_color: "#070b10",
        start_url: ".",
        icons: [
          { src: "icons/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icons/icon-512.png", sizes: "512x512", type: "image/png" },
          {
            src: "icons/icon-512-maskable.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
      workbox: {
        // Precache the app shell only — never runtime-cache serial data or exports.
        globPatterns: ["**/*.{js,css,html,svg,png,ico,woff2}"],
        navigateFallback: "index.html",
        cleanupOutdatedCaches: true,
      },
    }),
  ],
  build: {
    target: "es2022",
    reportCompressedSize: true,
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  test: {
    // Core math/protocol logic runs in Node; component tests use jsdom.
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          environment: "node",
          include: ["tests/unit/**/*.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "dom",
          environment: "jsdom",
          include: ["tests/dom/**/*.test.{ts,tsx}"],
        },
      },
    ],
  },
});
