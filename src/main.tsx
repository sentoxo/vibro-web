// Entry point: mount the app and register the service worker.

import { render } from "preact";
import { App } from "./app";
import { registerPwa } from "./pwa";
import { store } from "./state/store";
import { composeDashboardPng } from "./charts/export-png";
import "uplot/dist/uPlot.min.css";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/layout.css";
import "./styles/components.css";

const root = document.getElementById("app");
if (root) render(<App />, root);
registerPwa();

// E2E builds (VITE_E2E=1) expose the store and the PNG composer for
// assertions; production builds do not.
if (import.meta.env.VITE_E2E) {
  const e2eWindow = window as unknown as {
    __store: typeof store;
    __composeDashboardPng: typeof composeDashboardPng;
  };
  e2eWindow.__store = store;
  e2eWindow.__composeDashboardPng = composeDashboardPng;
}
