// Large RMS readout with 10 s sparkline and avg/min/max (plan §5.6).

import { store } from "../state/store";
import { formatFixed } from "../core/units";

function sparklinePath(values: number[], width: number, height: number): string {
  if (values.length < 2) return "";
  const max = Math.max(...values, 0.1);
  const min = Math.min(...values, 0);
  const span = Math.max(max - min, 0.01);
  return values
    .map((value, i) => {
      const x = (i / (values.length - 1)) * width;
      const y = height - ((value - min) / span) * (height - 2) - 1;
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

export function StatHero() {
  const rms = store.rms.value;
  const spark = store.spark.value;
  const staticMode = store.staticMode.value;
  const esc = store.esc.value;
  // Motor RPM in front of the RMS number (same source as the FFT 1×/2× marker
  // lines: MSP motor channel, or the FETtec RPM source setting).
  const rpm = Math.round(store.motorRpmHz * 60);
  return (
    <section class="stat-hero" aria-label="Vibration statistics">
      <div class="stat-primary">
        {esc.connected && rpm > 0 && (
          <span class="stat-rpm tabular" title="Motor RPM (FFT marker source)">
            {rpm}
            <span class="stat-rpm-unit">rpm</span>
          </span>
        )}
        <span class="stat-value tabular">{formatFixed(rms.current, 2)}</span>
        <span class="stat-unit">m/s²</span>
        <span class="stat-caption">{staticMode ? "Burst RMS" : "RMS vibration"}</span>
      </div>
      <svg class="stat-spark" viewBox="0 0 160 32" preserveAspectRatio="none" aria-label="Last 10 seconds RMS trend">
        <path d={sparklinePath(spark, 160, 32)} fill="none" stroke="var(--accent)" stroke-width="1.4" />
      </svg>
      <div class="stat-secondary tabular">
        <span>
          avg <b>{formatFixed(rms.avg, 2)}</b>
        </span>
        <span>
          min <b>{formatFixed(rms.min, 2)}</b>
        </span>
        <span>
          max <b>{formatFixed(rms.max, 2)}</b>
        </span>
      </div>
    </section>
  );
}
