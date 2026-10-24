// One chart: header, uPlot canvas, empty state, follow controls (plan §5.6).

import { useEffect, useRef } from "preact/hooks";
import { useSignal } from "@preact/signals";
import { createChart, peaksPlugin, rpmPlugin, type ChartHandle } from "../charts/chart";
import { store, type FftFrame, type TimeFrame } from "../state/store";
import { formatFixed } from "../core/units";
import { MIN_SAMPLES_FOR_RENDER, RPM_MARKER_MAX_HZ, WINDOW_SECONDS } from "../core/constants";

const AXIS_NAMES = ["X", "Y", "Z"] as const;

export interface ChartPanelProps {
  axis: 0 | 1 | 2;
  kind: "time" | "fft";
}

export function ChartPanel({ axis, kind }: ChartPanelProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<ChartHandle | null>(null);
  const caption = useSignal<string>("");
  const cursor = useSignal<string>("");
  const empty = useSignal(true);
  const follow = useSignal(true);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const getPeaks = () => store.peaks.peek()[axis];
    const handle = createChart(host, {
      axis,
      kind,
      height: host.clientHeight || 200,
      xLabel: kind === "time" ? "time [s]" : "frequency [Hz]",
      yLabel: "m/s²",
      syncGroup: kind === "time" ? "vibro-time" : "vibro-fft",
      xMin: kind === "time" ? 0 : 4,
      xMax: kind === "time" ? WINDOW_SECONDS : 800,
      yMin: kind === "time" ? -1 : 0,
      yMax: kind === "time" ? 1 : 2,
      plugins: kind === "fft" ? [rpmPlugin(() => store.motorRpmHz, RPM_MARKER_MAX_HZ), peaksPlugin(getPeaks)] : [],
      onFollowLost: () => {
        if (kind === "time") store.followTime.value = false;
        else store.followFft.value = false;
      },
      onCursor: (x, y) => {
        if (x == null || y == null) {
          cursor.value = "";
          return;
        }
        cursor.value =
          kind === "time"
            ? `${x.toFixed(2)} s · ${formatFixed(y, 3)} m/s²`
            : `${Math.round(x)} Hz · ${formatFixed(y, 3)} m/s²`;
      },
    });
    chartRef.current = handle;

    const unsubscribe =
      kind === "time"
        ? store.onTimeFrame((frame: TimeFrame) => {
            const ys = axis === 0 ? frame.x : axis === 1 ? frame.y : frame.z;
            let maxAbs = 0;
            for (let i = 0; i < frame.n; i++) {
              const v = ys[i];
              if (v > maxAbs) maxAbs = v;
              else if (-v > maxAbs) maxAbs = -v;
            }
            const limit = Math.max(1.0, maxAbs * 1.1);
            // Desktop x-range: live 0..time_window_seconds; burst 0..burst length.
            const xMax = frame.mode === "file" ? frame.durationSeconds : store.settings.peek().windowSeconds;
            handle.update(frame.t, ys, 0, xMax);
            handle.setYRange(-limit, limit);
            empty.value = frame.n < MIN_SAMPLES_FOR_RENDER;
            const suffix = frame.mode === "file" ? "avg" : "rms";
            caption.value = `${formatFixed(frame.axisRms[axis], 2)} m/s² ${suffix}`;
          })
        : store.onFftFrame((frame: FftFrame) => {
            if (frame.axis !== axis) return;
            handle.update(frame.freqs, frame.amps, frame.minHz, frame.maxHz);
            handle.setYRange(0, frame.yMax);
            empty.value = frame.freqs.length === 0;
            const top = getPeaks()[0];
            caption.value = top ? `peak ${Math.round(top.frequency)} Hz` : "";
          });

    const observer = new ResizeObserver((entries) => {
      const rect = entries[0].contentRect;
      if (rect.width > 0 && rect.height > 0) {
        handle.resize(Math.floor(rect.width), Math.floor(rect.height));
      }
    });
    observer.observe(host);

    return () => {
      observer.disconnect();
      unsubscribe();
      handle.destroy();
      chartRef.current = null;
    };
  }, [axis, kind]);

  // React to follow toggles (chart drag-zoom pauses; "Live" resumes).
  useEffect(() => {
    const signalValue = kind === "time" ? store.followTime : store.followFft;
    const check = () => {
      follow.value = signalValue.value;
      chartRef.current?.setFollow(signalValue.value);
    };
    check();
    const unsub = signalValue.subscribe(check);
    return unsub;
  }, [kind]);

  const resumeFollow = () => {
    if (kind === "time") store.followTime.value = true;
    else store.followFft.value = true;
  };

  return (
    <div class={`chart-panel chart-${kind}`}>
      <div class="chart-header">
        <span
          class={`chart-dot chart-dot-${kind === "time" ? AXIS_NAMES[axis].toLowerCase() : AXIS_NAMES[axis].toLowerCase()}`}
        />
        <span class="chart-title">
          {kind === "time" ? "Time" : "FFT"} — {AXIS_NAMES[axis]} axis
        </span>
        <span class="chart-caption tabular">{cursor.value || caption.value}</span>
        {!follow.value && (
          <button class="btn btn-small btn-accent" onClick={resumeFollow}>
            Live
          </button>
        )}
      </div>
      <div
        class="chart-host"
        ref={hostRef}
        role="img"
        aria-label={`${kind} chart, ${AXIS_NAMES[axis]} axis, ${caption.value}`}
      />
      {empty.value && <div class="chart-empty">Waiting for {MIN_SAMPLES_FOR_RENDER} samples…</div>}
    </div>
  );
}
