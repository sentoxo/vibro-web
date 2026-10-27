import { defineConfig } from "vitest/config";
import preact from "@preact/preset-vite";
import { VitePWA } from "vite-plugin-pwa";

// GitHub Pages project sites live under /<repo>/. Set VITE_BASE=/<repo>/ at
// build time; local development and root deployments use "/".
const base = process.env.VITE_BASE ?? "/";
const version = process.env.npm_package_version ?? "0.1.1-dev";
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
