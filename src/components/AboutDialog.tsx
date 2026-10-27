// About / Help modal: version, browser support, protocol notes, privacy.

import { serialSupported } from "../sources/serial";

export function AboutDialog({ onClose }: { onClose: () => void }) {
  return (
    <div class="modal-backdrop" role="dialog" aria-modal="true" aria-label="About Vibro">
      <div class="modal" onClick={(event) => event.target === event.currentTarget && onClose()}>
        <div class="modal-title">About Vibro</div>
        <div class="modal-body">
          <p>
            Vibro is a real-time vibration monitor: live sensor streaming over Web Serial, time-domain and FFT analysis,
            RMS statistics and DVB1 burst files. It is the web port of the desktop Vibro app.
          </p>
          <dl class="about-list">
            <dt>Version</dt>
            <dd>
              {__APP_VERSION__} (build {__BUILD_HASH__})
            </dd>
            <dt>Live hardware</dt>
            <dd>
              {serialSupported()
                ? "Supported in this browser (CH340, 921600 baud, Web Serial)."
                : "Not supported in this browser — use Chrome or Edge. Demo and file mode work here."}
            </dd>
            <dt>Protocol</dt>
            <dd>
              S&lt;sid&gt;,&lt;seq&gt;,&lt;x&gt;,&lt;y&gt;,&lt;z&gt; lines; DVB1 bursts; MSP v1 and FETtec OneWire
              (Betaflight passthrough) for FC/ESC.
            </dd>
            <dt>Bandwidth</dt>
            <dd>The text protocol fits ~2500 Hz at 921600 baud. 2000 Hz is the recommended maximum.</dd>
            <dt>Privacy</dt>
            <dd>This app never uploads your data. No network calls after load.</dd>
          </dl>
          <div class="modal-actions">
            <button class="btn btn-accent" onClick={onClose}>
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
