// Six linked charts; below 760 px a single axis with tabs (plan §5.8).

import { useEffect } from "preact/hooks";
import { useSignal } from "@preact/signals";
import { ChartPanel } from "./ChartPanel";
import { store } from "../state/store";

const AXES = [0, 1, 2] as const;

export function ChartGrid() {
  const compact = useSignal(!window.matchMedia("(min-width: 760px)").matches);
  const axisTab = useSignal<0 | 1 | 2>(0);

  useEffect(() => {
    const query = window.matchMedia("(min-width: 760px)");
    const onChange = (event: MediaQueryListEvent) => {
      compact.value = !event.matches;
    };
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  const visibleAxes = compact.value ? [axisTab.value] : [...AXES];

  return (
    <section class="chart-grid-wrap" aria-label="Vibration charts">
      <div class="chart-grid-bar">
        {compact.value && (
          <div class="axis-tabs" role="tablist" aria-label="Axis selector">
            {AXES.map((axis) => (
              <button
                key={axis}
                role="tab"
                aria-selected={axisTab.value === axis}
                class={`axis-tab ${axisTab.value === axis ? "axis-tab-active" : ""}`}
                onClick={() => {
                  axisTab.value = axis;
                }}
              >
                {["X", "Y", "Z"][axis]}
              </button>
            ))}
          </div>
        )}
        {store.paused.value ? (
          <button class="btn btn-small" onClick={() => (store.paused.value = false)}>
            Resume live
          </button>
        ) : (
          store.sourceKind.peek() !== "file" && (
            <button class="btn btn-small" onClick={() => (store.paused.value = true)}>
              Freeze
            </button>
          )
        )}
      </div>
      <div class={`chart-grid ${compact.value ? "chart-grid-compact" : ""}`}>
        {visibleAxes.map((axis) => (
          <ChartPanel key={`t-${axis}`} axis={axis} kind="time" />
        ))}
        {visibleAxes.map((axis) => (
          <ChartPanel key={`f-${axis}`} axis={axis} kind="fft" />
        ))}
      </div>
    </section>
  );
}
