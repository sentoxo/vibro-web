// Dashboard PNG export composed from chart data on an offscreen canvas at
// 1920 px (plan §6.14). No DOM screenshot: curves are re-rendered crisply.

import { axisColorFor, chartTheme, fmtHz, fmtSeconds } from "./theme";
import { store } from "../state/store";
import { formatDataRate, formatFixed } from "../core/units";

const WIDTH = 1920;
const HEIGHT = 1080;
const MARGIN = 32;
const GAP = 24;

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

function niceTicks(min: number, max: number, count: number): number[] {
  const span = max - min;
  if (span <= 0) return [min];
  const step0 = span / count;
  const magnitude = 10 ** Math.floor(Math.log10(step0));
  const norm = step0 / magnitude;
  const step = (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * magnitude;
  const ticks: number[] = [];
  for (let t = Math.ceil(min / step) * step; t <= max + 1e-9; t += step) ticks.push(t);
  return ticks;
}

interface PanelData {
  title: string;
  xs: ArrayLike<number>;
  ys: ArrayLike<number>;
  n: number;
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
  xLabel: string;
  yLabel: string;
  color: string;
}

function drawPanel(
  ctx: CanvasRenderingContext2D,
  theme: ReturnType<typeof chartTheme>,
  x: number,
  y: number,
  w: number,
  h: number,
  panel: PanelData,
): void {
  ctx.fillStyle = theme.surface;
  roundRect(ctx, x, y, w, h, 10);
  ctx.fill();
  ctx.strokeStyle = theme.border;
  ctx.lineWidth = 1;
  ctx.stroke();

  // Every panel starts from a known text state: previous panels end with
  // right/center-aligned tick labels and a rotated axis label.
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = theme.text;
  ctx.font = "600 18px system-ui, sans-serif";
  ctx.fillText(panel.title, x + 16, y + 28);

  const pad = { top: 44, right: 20, bottom: 40, left: 64 };
  const plotX = x + pad.left;
  const plotY = y + pad.top;
  const plotW = w - pad.left - pad.right;
  const plotH = h - pad.top - pad.bottom;

  // Grid + tick labels.
  ctx.font = "12px ui-monospace, monospace";
  ctx.fillStyle = theme.muted;
  ctx.strokeStyle = theme.grid;
  for (const tick of niceTicks(panel.xMin, panel.xMax, 8)) {
    const px = plotX + ((tick - panel.xMin) / (panel.xMax - panel.xMin)) * plotW;
    ctx.beginPath();
    ctx.moveTo(px, plotY);
    ctx.lineTo(px, plotY + plotH);
    ctx.stroke();
    ctx.textAlign = "center";
    ctx.fillText(panel.xLabel === "Hz" ? fmtHz(tick) : fmtSeconds(tick), px, y + h - 14);
  }
  for (const tick of niceTicks(panel.yMin, panel.yMax, 5)) {
    const py = plotY + plotH - ((tick - panel.yMin) / (panel.yMax - panel.yMin)) * plotH;
    ctx.beginPath();
    ctx.moveTo(plotX, py);
    ctx.lineTo(plotX + plotW, py);
    ctx.stroke();
    ctx.textAlign = "right";
    ctx.fillText(tick.toFixed(Math.abs(tick) >= 10 ? 0 : 1), plotX - 8, py + 4);
  }

  // Axis labels.
  ctx.fillStyle = theme.muted;
  ctx.font = "12px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(`[${panel.xLabel}]`, plotX + plotW / 2, y + h - 2);
  ctx.save();
  ctx.translate(x + 14, plotY + plotH / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText(`[${panel.yLabel}]`, 0, 0);
  ctx.restore();

  // Curve.
  ctx.save();
  ctx.beginPath();
  ctx.rect(plotX, plotY, plotW, plotH);
  ctx.clip();
  ctx.strokeStyle = panel.color;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  let started = false;
  for (let i = 0; i < panel.n; i++) {
    const px = plotX + ((panel.xs[i] - panel.xMin) / (panel.xMax - panel.xMin)) * plotW;
    const py = plotY + plotH - ((panel.ys[i] - panel.yMin) / (panel.yMax - panel.yMin)) * plotH;
    if (!started) {
      ctx.moveTo(px, py);
      started = true;
    } else {
      ctx.lineTo(px, py);
    }
  }
  ctx.stroke();
  ctx.restore();
}

/** Compose the full dashboard image; resolves with a PNG blob. */
export async function composeDashboardPng(): Promise<Blob> {
  const theme = chartTheme();
  const canvas = document.createElement("canvas");
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D unavailable");

  const settings = store.settings.peek();
  const rms = store.rms.peek();
  const peaks = store.peaks.peek();
  const diag = store.diagnostics.peek();
  const timeFrame = store.getTimeFrame();
  const axisNames = ["X", "Y", "Z"];

  ctx.fillStyle = "#070b10";
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  // Header.
  ctx.fillStyle = theme.accent;
  ctx.font = "700 28px system-ui, sans-serif";
  ctx.textAlign = "left";
  ctx.fillText("VIBRO", MARGIN, 48);
  ctx.fillStyle = theme.text;
  ctx.font = "16px system-ui, sans-serif";
  const sourceLabel =
    store.sourceKind.peek().toUpperCase() + (store.deviceLabel.peek() ? ` · ${store.deviceLabel.peek()}` : "");
  ctx.fillText(sourceLabel, MARGIN + 110, 46);
  ctx.fillStyle = theme.muted;
  ctx.textAlign = "right";
  ctx.fillText(new Date().toLocaleString("en-US"), WIDTH - MARGIN, 46);
  ctx.fillText(`v${__APP_VERSION__}`, WIDTH - MARGIN, 66);

  // Stats strip.
  ctx.textAlign = "left";
  ctx.fillStyle = theme.text;
  ctx.font = "600 34px ui-monospace, monospace";
  ctx.fillText(`${formatFixed(rms.current, 2)} m/s²`, MARGIN, 104);
  ctx.font = "15px ui-monospace, monospace";
  ctx.fillStyle = theme.muted;
  ctx.fillText(
    `avg ${formatFixed(rms.avg, 2)} · min ${formatFixed(rms.min, 2)} · max ${formatFixed(rms.max, 2)} m/s²`,
    MARGIN + 220,
    102,
  );
  ctx.fillText(
    `IMU ${settings.imuHz} Hz · FFT ≤ ${settings.fftMaxHz} Hz · ${settings.lsbPerG} LSB/g`,
    MARGIN + 620,
    102,
  );
  ctx.font = "14px ui-monospace, monospace";
  for (let p = 0; p < 3; p++) {
    const parts = axisNames.map((axis, a) => {
      const peak = peaks[a]?.[p];
      return `${axis}: ${peak ? `${Math.round(peak.frequency)} Hz ${peak.amplitude.toFixed(1)} m/s²` : "--"}`;
    });
    ctx.fillText(`Peak ${p + 1}  ${parts.join("  |  ")}`, MARGIN, 138 + p * 22);
  }

  // Chart grid 3 × 2.
  const gridTop = 210;
  const panelW = (WIDTH - MARGIN * 2 - GAP) / 2;
  const panelH = (HEIGHT - gridTop - MARGIN - GAP * 2) / 3;
  const empty = new Float64Array(0);
  for (let axis = 0; axis < 3; axis++) {
    const color = axisColorFor(axis as 0 | 1 | 2, theme);
    const y = gridTop + axis * (panelH + GAP);

    // Time panel. Always drawn (even before data arrives) so a snapshot never
    // leaves a blank hole in the dashboard.
    const ys = timeFrame ? (timeFrame[axis === 0 ? "x" : axis === 1 ? "y" : "z"] as Float64Array) : empty;
    const sampleCount = timeFrame?.n ?? 0;
    let maxAbs = 1;
    for (let i = 0; i < sampleCount; i++) maxAbs = Math.max(maxAbs, Math.abs(ys[i]));
    const limit = maxAbs * 1.1;
    const timeMax = timeFrame?.mode === "file" ? timeFrame.durationSeconds : settings.windowSeconds;
    drawPanel(ctx, theme, MARGIN, y, panelW, panelH, {
      title: `Time — ${axisNames[axis]} axis — ${(timeFrame?.axisRms[axis] ?? 0).toFixed(2)} m/s² RMS`,
      xs: timeFrame?.t ?? empty,
      ys,
      n: sampleCount,
      // Charts use 0..duration in both modes (desktop rule); the data array is
      // oldest-first and would be clipped away by a -duration..0 range.
      xMin: 0,
      xMax: timeMax > 0 ? timeMax : settings.windowSeconds,
      yMin: -limit,
      yMax: limit,
      xLabel: "s",
      yLabel: "m/s²",
      color,
    });

    // FFT panel.
    const { freqs, amps } = store.getSpectrum(axis);
    const liveMaxHz = settings.fftMaxHz;
    const displayMaxHz = timeFrame?.mode === "file" ? Math.min(settings.fftMaxHz, timeFrame.imuHz / 2) : liveMaxHz;
    let peakAmp = 0;
    for (let i = 0; i < amps.length; i++) peakAmp = Math.max(peakAmp, amps[i]);
    drawPanel(ctx, theme, MARGIN + panelW + GAP, y, panelW, panelH, {
      title: `FFT — ${axisNames[axis]} axis`,
      xs: freqs,
      ys: amps,
      n: freqs.length,
      xMin: 4,
      xMax: displayMaxHz,
      yMin: 0,
      yMax: Math.max(2, peakAmp * 1.05),
      xLabel: "Hz",
      yLabel: "m/s²",
      color,
    });
  }

  // Footer.
  ctx.fillStyle = theme.muted;
  ctx.font = "12px ui-monospace, monospace";
  ctx.textAlign = "left";
  ctx.fillText(
    `packets ${diag.packetRate} Hz · lost ${diag.lostPackets} · malformed ${diag.malformedLines} · ` +
      `wire ${formatDataRate(diag.wireBytesPerSecond)} · ${__APP_VERSION__} (${__BUILD_HASH__})`,
    MARGIN,
    HEIGHT - 12,
  );

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("PNG encoding failed"))), "image/png");
  });
}
