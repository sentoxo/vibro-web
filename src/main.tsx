// Entry point: mount the app and register the service worker.

import { render } from "preact";
import { App } from "./app";
import { registerPwa } from "./pwa";
import { store } from "./state/store";
import "uplot/dist/uPlot.min.css";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/layout.css";
import "./styles/components.css";

const root = document.getElementById("app");
if (root) render(<App />, root);
registerPwa();

// E2E builds (VITE_E2E=1) expose the store for assertions; production builds do not.
if (import.meta.env.VITE_E2E) {
  (window as unknown as { __store: typeof store }).__store = store;
}
