// Three peak cards; each shows the peak rank per axis (desktop layout, plan §5.6).

import { store } from "../state/store";

const AXES = ["X", "Y", "Z"] as const;

export function PeakCards() {
  const peaks = store.peaks.value;
  return (
    <section class="peak-cards" aria-label="Dominant FFT peaks">
      {[0, 1, 2].map((rank) => (
        <div class="peak-card" key={rank}>
          <div class="peak-rank">Peak {rank + 1}</div>
          <div class="peak-rows">
            {AXES.map((axis, axisIndex) => {
              const peak = peaks[axisIndex]?.[rank];
              return (
                <div class="peak-row" key={axis}>
                  <span class={`peak-axis peak-axis-${axis.toLowerCase()}`}>{axis}</span>
                  <span class="peak-value tabular">
                    {peak ? `${Math.round(peak.frequency)} Hz · ${peak.amplitude.toFixed(1)} m/s²` : "--"}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </section>
  );
}
