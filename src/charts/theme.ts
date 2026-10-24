// uPlot theme built from the CSS design tokens (plan §5.5).

const cssVar = (name: string, fallback: string): string => {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value.length > 0 ? value : fallback;
};

export interface ChartTheme {
  text: string;
  muted: string;
  grid: string;
  gridStrong: string;
  border: string;
  axisX: string;
  axisY: string;
  axisZ: string;
  accent: string;
  danger: string;
  warning: string;
  surface: string;
}

let cached: ChartTheme | null = null;

export function chartTheme(): ChartTheme {
  if (cached) return cached;
  cached = {
    text: cssVar("--text", "#e6edf3"),
    muted: cssVar("--text-muted", "#8b9bb0"),
    grid: cssVar("--grid", "rgba(255,255,255,0.06)"),
    gridStrong: cssVar("--grid-strong", "rgba(255,255,255,0.12)"),
    border: cssVar("--border", "#1f2a37"),
    axisX: cssVar("--axis-x", "#22d3ee"),
    axisY: cssVar("--axis-y", "#fbbf24"),
    axisZ: cssVar("--axis-z", "#e879f9"),
    accent: cssVar("--accent", "#22d3ee"),
    danger: cssVar("--danger", "#fb7185"),
    warning: cssVar("--warning", "#fbbf24"),
    surface: cssVar("--surface", "#0d131b"),
  };
  return cached;
}

export function axisColorFor(axis: number, theme = chartTheme()): string {
  return [theme.axisX, theme.axisY, theme.axisZ][axis];
}

export function withAlpha(color: string, alpha: number): string {
  // Accepts #rgb/#rrggbb tokens; charts need translucent fills.
  const hex = color.replace("#", "");
  const full =
    hex.length === 3
      ? hex
          .split("")
          .map((c) => c + c)
          .join("")
      : hex.padEnd(6, "0").slice(0, 6);
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function fmtHz(value: number): string {
  if (Math.abs(value) >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return `${Math.round(value * 10) / 10}`;
}

export function fmtSeconds(value: number): string {
  return `${value.toFixed(value % 1 === 0 ? 0 : 1)}s`;
}

export function fmtMs2(value: number): string {
  return value.toFixed(2);
}
