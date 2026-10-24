// uPlot instance factory: one scrolling time chart or one FFT chart.
// Handles linked axes (sync groups), user-zoom follow pause, dynamic Y and
// crosshair readouts (plan §5.7).

import uPlot from "uplot";
import { axisColorFor, chartTheme, fmtHz, fmtMs2, fmtSeconds, withAlpha } from "./theme";

export interface ChartHandle {
  readonly u: uPlot;
  /** Push new data; the x scale is applied only while following. */
  update(xs: ArrayLike<number>, ys: ArrayLike<number>, xMin: number, xMax: number): void;
  setYRange(min: number, max: number): void;
  setFollow(follow: boolean): void;
  resize(width: number, height: number): void;
  destroy(): void;
}

export interface ChartConfig {
  axis: 0 | 1 | 2;
  kind: "time" | "fft";
  height: number;
  xLabel: string;
  yLabel: string;
  syncGroup: string;
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
  plugins?: uPlot.Plugin[];
  onFollowLost?: () => void;
  /** Crosshair readout for the panel caption (replaces a floating tooltip). */
  onCursor?: (x: number | null, y: number | null) => void;
}

export function createChart(el: HTMLElement, config: ChartConfig): ChartHandle {
  const theme = chartTheme();
  const stroke = axisColorFor(config.axis, theme);
  const fillAlpha = config.kind === "time" ? 0.06 : 0.08;
  const lineWidth = config.kind === "time" ? 1 : 1.2;
  const followState = { follow: true };

  const options: uPlot.Options = {
    width: el.clientWidth || 320,
    height: config.height,
    padding: [6, 8, 4, 4],
    legend: { show: false },
    axes: [
      {
        label: config.xLabel,
        labelSize: 13,
        stroke: theme.muted,
        grid: { stroke: theme.grid, width: 1 },
        ticks: { stroke: theme.border, size: 4, width: 1 },
        font: "10px ui-monospace, SFMono-Regular, monospace",
        values:
          config.kind === "time"
            ? (_u: uPlot, ticks: number[]) => ticks.map(fmtSeconds)
            : (_u: uPlot, ticks: number[]) => ticks.map(fmtHz),
      },
      {
        label: config.yLabel,
        labelSize: 13,
        stroke: theme.muted,
        grid: { stroke: theme.grid, width: 1 },
        ticks: { stroke: theme.border, size: 4, width: 1 },
        font: "10px ui-monospace, SFMono-Regular, monospace",
        size: 46,
        values: (_u: uPlot, ticks: number[]) => ticks.map(fmtMs2),
      },
    ],
    series: [
      { label: "t", show: false, stroke: "transparent" },
      {
        label: "a",
        stroke,
        width: lineWidth,
        fill: withAlpha(stroke, fillAlpha),
        dash: undefined,
      },
    ],
    scales: {
      x: { time: false, min: config.xMin, max: config.xMax },
      y: { min: config.yMin, max: config.yMax },
    },
    cursor: {
      sync: { key: config.syncGroup, setSeries: false },
      focus: { prox: 1e9 },
      drag: { x: true, y: false, dist: 6 },
      points: { show: true, size: 5, width: 1 },
    },
    plugins: config.plugins ?? [],
    hooks: {
      setScale: [
        (self: uPlot) => {
          // A user drag-zoom pauses auto-follow; the "Live" button re-enables it.
          const drag = self.cursor.drag as unknown as { dragging?: boolean; fired?: boolean } | undefined;
          if (drag?.dragging || drag?.fired) {
            if (followState.follow) {
              followState.follow = false;
              config.onFollowLost?.();
            }
          }
        },
      ],
      setCursor: [
        (self: uPlot) => {
          if (!config.onCursor) return;
          const idx = self.cursor.idx;
          if (idx == null || !self.data[0]) return config.onCursor(null, null);
          const x = self.data[0][idx] as number | undefined;
          const y = self.data[1]?.[idx] as number | undefined;
          config.onCursor(x ?? null, y ?? null);
        },
      ],
    },
  };

  const self = new uPlot(options, [[0], [0]] as uPlot.AlignedData, el);

  return {
    get u() {
      return self;
    },
    update(xs, ys, xMin, xMax) {
      self.setData([xs as number[], ys as number[]] as uPlot.AlignedData);
      if (followState.follow) {
        self.setScale("x", { min: xMin, max: xMax });
      }
    },
    setYRange(min, max) {
      self.setScale("y", { min, max });
    },
    setFollow(follow) {
      followState.follow = follow;
    },
    resize(width, height) {
      self.setSize({ width, height });
    },
    destroy() {
      self.destroy();
    },
  };
}

/** Vertical RPM marker lines for FFT charts (1× and 2× motor frequency). */
export function rpmPlugin(getRpmHz: () => number, maxHz = Number.POSITIVE_INFINITY): uPlot.Plugin {
  const theme = chartTheme();
  return {
    hooks: {
      draw: [
        (self: uPlot) => {
          const rpmHz = getRpmHz();
          if (rpmHz <= 0) return;
          const ctx = self.ctx;
          const xMin = self.scales.x.min ?? 0;
          const xMax = self.scales.x.max ?? Number.POSITIVE_INFINITY;
          // Desktop `update_fft_rpm_indicators`: visible only when 0 < f <= maxHz.
          const lines: [number, string][] = [];
          if (rpmHz <= maxHz) lines.push([rpmHz, theme.danger]);
          if (rpmHz * 2 <= maxHz) lines.push([rpmHz * 2, theme.warning]);
          if (lines.length === 0) return;
          ctx.save();
          for (const [freq, color] of lines) {
            if (freq < xMin || freq > xMax) continue;
            const px = self.valToPos(freq, "x", true);
            ctx.strokeStyle = color;
            ctx.lineWidth = 1.5;
            ctx.setLineDash([4, 3]);
            ctx.beginPath();
            ctx.moveTo(px, self.bbox.top);
            ctx.lineTo(px, self.bbox.top + self.bbox.height);
            ctx.stroke();
          }
          ctx.restore();
        },
      ],
    },
  };
}
/** Peak dots and a label for the strongest peak of each FFT chart. */
export function peaksPlugin(getPeaks: () => { frequency: number; amplitude: number }[]): uPlot.Plugin {
  const theme = chartTheme();
  return {
    hooks: {
      draw: [
        (self: uPlot) => {
          const peaks = getPeaks();
          if (peaks.length === 0) return;
          const ctx = self.ctx;
          ctx.save();
          ctx.font = "10px ui-monospace, SFMono-Regular, monospace";
          peaks.forEach((peak, i) => {
            if (
              peak.frequency < (self.scales.x.min ?? 0) ||
              peak.frequency > (self.scales.x.max ?? Number.POSITIVE_INFINITY) ||
              peak.amplitude > (self.scales.y.max ?? Number.POSITIVE_INFINITY)
            ) {
              return;
            }
            const px = self.valToPos(peak.frequency, "x", true);
            const py = self.valToPos(peak.amplitude, "y", true);
            ctx.fillStyle = theme.accent;
            ctx.beginPath();
            ctx.arc(px, py, 3, 0, Math.PI * 2);
            ctx.fill();
            if (i === 0) {
              ctx.fillStyle = theme.text;
              const label = `${Math.round(peak.frequency)} Hz · ${peak.amplitude.toFixed(1)}`;
              const maxX = self.bbox.left + self.bbox.width - 90;
              ctx.fillText(label, Math.min(px + 6, maxX), Math.max(py - 6, self.bbox.top + 10));
            }
          });
          ctx.restore();
        },
      ],
    },
  };
}
