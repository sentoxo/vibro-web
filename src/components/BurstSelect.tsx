// Burst list with sequence summary (plan §5.6).

import { store } from "../state/store";

export function BurstSelect() {
  const bursts = store.bursts.value;
  const selected = store.selectedBurst.value;
  if (bursts.length === 0) return null;
  return (
    <div class="burst-select">
      <div class="section-label">Bursts</div>
      <select
        class="input"
        value={selected}
        onChange={(event) => store.selectBurst(Number((event.target as HTMLSelectElement).value))}
        aria-label="Select burst"
      >
        {bursts.map((burst, index) => (
          <option value={index} key={index}>
            Burst {index + 1} (seq {burst.sequence.toString()})
          </option>
        ))}
      </select>
      {selected >= 0 && bursts[selected] && (
        <div class="burst-meta">
          <div>
            Burst {selected + 1}/{bursts.length} · samples: {bursts[selected].sampleCount} ·{" "}
            {bursts[selected].sampleRate} Hz
          </div>
          <div>
            timestamp:{" "}
            {(() => {
              const ns = bursts[selected].timestampNs;
              const ms = Number(ns / 1_000_000n);
              const sub = Number(ns % 1_000_000n);
              const d = new Date(ms);
              const pad = (n: number, w = 2) => String(n).padStart(w, "0");
              return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(Math.floor(sub / 1000), 3)}`;
            })()}
          </div>
          <div>sequence: {bursts[selected].sequence.toString()}</div>
        </div>
      )}
    </div>
  );
}
