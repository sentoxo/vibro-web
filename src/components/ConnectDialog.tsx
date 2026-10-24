// Connect dialog: granted ports, requestPort with CH340 filter, "show all",
// permission/busy error help (plan §5.2, §6.6).

import { useEffect, useState } from "preact/compat";
import { SENSOR_FILTERS } from "../core/constants";
import { store } from "../state/store";
import { getGrantedPorts, requestNewPort, serialSupported, type PortSummary } from "../sources/serial";

export function ConnectDialog({ onClose }: { onClose: () => void }) {
  const [ports, setPorts] = useState<PortSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = () => {
    void getGrantedPorts().then(setPorts);
  };

  useEffect(() => {
    refresh();
  }, []);

  const connect = async (port: SerialPort) => {
    setBusy(true);
    setError(null);
    try {
      await store.connectSerial(port);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  const grant = async (useFilters: boolean) => {
    setError(null);
    setBusy(true);
    try {
      const port = await requestNewPort(useFilters ? SENSOR_FILTERS : undefined);
      await connect(port);
    } catch (err) {
      setBusy(false);
      if (err instanceof DOMException && err.name === "NotFoundError") {
        setError("No sensor found. Plug in the sensor (STM32 VCP or CH340), then try again.");
      } else if (err instanceof DOMException && err.name === "NotAllowedError") {
        setError("Port selection was cancelled or denied. Grant access to connect.");
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    }
  };

  return (
    <div class="modal-backdrop" role="dialog" aria-modal="true" aria-label="Connect sensor">
      <div class="modal">
        <div class="modal-title">Connect sensor</div>
        {!serialSupported() ? (
          <div class="modal-body">
            <p>Live hardware requires Chrome or Edge. Demo and file analysis work everywhere.</p>
            <div class="modal-actions">
              <button
                class="btn btn-accent"
                onClick={() => {
                  void store.startDemo();
                  onClose();
                }}
              >
                Explore demo
              </button>
              <button class="btn" onClick={onClose}>
                Close
              </button>
            </div>
          </div>
        ) : (
          <div class="modal-body">
            {ports.length > 0 && (
              <div class="connect-ports">
                <div class="section-label">Granted ports</div>
                {ports.map((summary, index) => (
                  <button
                    class="connect-port-row"
                    key={index}
                    disabled={busy}
                    onClick={() => void connect(summary.port)}
                  >
                    <span class="connect-port-label">
                      {summary.label}
                      {ports.length > 1 ? ` #${index + 1}` : ""}
                    </span>
                    <span class="connect-port-action">Reconnect</span>
                  </button>
                ))}
              </div>
            )}
            <p class="modal-note">
              Sensor over USB CDC (STM32 VCP or CH340) at 921600 baud line coding. Close the Python app and make sure
              your user has serial permissions (uucp/dialout group).
            </p>
            {error && <div class="modal-error">{error}</div>}
            <div class="modal-actions">
              <button class="btn btn-accent" disabled={busy} onClick={() => void grant(true)}>
                Select sensor port
              </button>
              <button class="btn" disabled={busy} onClick={() => void grant(false)}>
                Show all serial devices
              </button>
              <button class="btn" onClick={onClose}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
