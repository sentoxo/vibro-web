// Landing screen: hero, primary actions, browser note and the auto-running
// demo strip (plan §5.4). The GitHub Pages first impression.

import { store } from "../state/store";
import { serialSupported } from "../sources/serial";
import { ChartGrid } from "./ChartGrid";
import { FileDropZone } from "./FileDropZone";
import { PeakCards } from "./PeakCards";
import { StatHero } from "./StatHero";

export function Landing({ onConnect, onAbout }: { onConnect: () => void; onAbout: () => void }) {
  const demoRunning = store.sourceKind.value === "demo" && !store.staticMode.value;
  return (
    <div class="landing">
      <section class="landing-hero">
        <h1 class="landing-title">VIBRO</h1>
        <p class="landing-subtitle">Real-time vibration analysis, in your browser.</p>
        <div class="landing-actions">
          <button
            class="btn btn-accent"
            onClick={onConnect}
            disabled={!serialSupported()}
            title={serialSupported() ? "Connect the CH340 sensor" : "Live hardware requires Chrome or Edge"}
          >
            Connect sensor
          </button>
          <span class="landing-file">
            <FileDropZone compact />
          </span>
          <button class="btn" onClick={() => void store.startDemo()}>
            Explore demo
          </button>
        </div>
        <p class="landing-note">
          Live hardware requires Chrome or Edge.
          <br />
          Demo and file analysis work in every modern browser.
        </p>
      </section>

      {demoRunning && (
        <section class="landing-demo" aria-label="Live demo">
          <div class="demo-badge-row">
            <span class="badge badge-demo">Demo data — not a real device</span>
          </div>
          <StatHero />
          <PeakCards />
          <ChartGrid />
        </section>
      )}

      <footer class="landing-footer">
        <button class="linklike" onClick={onAbout}>
          Why Vibro
        </button>
        <span>·</span>
        <button class="linklike" onClick={onAbout}>
          Data formats
        </button>
        <span>·</span>
        <button class="linklike" onClick={onAbout}>
          Privacy
        </button>
        <span>·</span>
        <a class="linklike" href="https://github.com/sentoxo/vibro" target="_blank" rel="noreferrer">
          GitHub
        </a>
      </footer>
    </div>
  );
}
