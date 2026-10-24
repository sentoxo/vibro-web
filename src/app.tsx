// AppShell + screen state (plan §5.6, §6.2 app.tsx).

import { useEffect } from "preact/hooks";
import { useSignal } from "@preact/signals";
import { store } from "./state/store";
import { Header } from "./components/Header";
import { StatusStrip } from "./components/StatusStrip";
import { ToastStack } from "./components/ToastStack";
import { UpdatePrompt } from "./components/UpdatePrompt";
import { SettingsDrawer } from "./components/SettingsDrawer";
import { ConnectDialog } from "./components/ConnectDialog";
import { AboutDialog } from "./components/AboutDialog";
import { LostPacketsDialog } from "./components/LostPacketsDialog";
import { Landing } from "./components/Landing";
import { ChartGrid } from "./components/ChartGrid";
import { PeakCards } from "./components/PeakCards";
import { StatHero } from "./components/StatHero";

export function App() {
  const settingsOpen = useSignal(typeof window !== "undefined" && window.matchMedia("(min-width: 1440px)").matches);
  const connectOpen = useSignal(false);
  const aboutOpen = useSignal(false);

  useEffect(() => {
    const onToggleSettings = () => {
      settingsOpen.value = !settingsOpen.value;
    };
    const onConnect = () => {
      connectOpen.value = true;
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        connectOpen.value = false;
        aboutOpen.value = false;
      }
    };
    window.addEventListener("vibro:toggle-settings", onToggleSettings);
    window.addEventListener("vibro:connect", onConnect);
    window.addEventListener("keydown", onKey);
    store.scheduleLandingDemo();
    return () => {
      window.removeEventListener("vibro:toggle-settings", onToggleSettings);
      window.removeEventListener("vibro:connect", onConnect);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  const screen = store.screen.value;

  return (
    <div class="app-shell">
      <Header
        onConnect={() => {
          connectOpen.value = true;
        }}
        onSettings={() => {
          settingsOpen.value = true;
        }}
        onAbout={() => {
          aboutOpen.value = true;
        }}
      />
      <main class="app-main">
        {screen === "landing" ? (
          <Landing
            onConnect={() => {
              connectOpen.value = true;
            }}
            onAbout={() => {
              aboutOpen.value = true;
            }}
          />
        ) : (
          <div class="dashboard">
            <div class="dashboard-main">
              <StatHero />
              <PeakCards />
              <ChartGrid />
            </div>
            <SettingsDrawer open={settingsOpen.value} onClose={() => (settingsOpen.value = false)} />
          </div>
        )}
      </main>
      {screen === "dashboard" && <StatusStrip />}
      <ToastStack />
      <UpdatePrompt />
      {connectOpen.value && <ConnectDialog onClose={() => (connectOpen.value = false)} />}
      {aboutOpen.value && <AboutDialog onClose={() => (aboutOpen.value = false)} />}
      {store.lostPacketWarning.value && <LostPacketsDialog onClose={() => (store.lostPacketWarning.value = false)} />}
    </div>
  );
}
