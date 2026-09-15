import ReactDOM from "react-dom/client";
import "../src/renderer/index.css";
import { LiveMicrophoneOffBanner } from "../src/renderer/LiveScreen.js";

function LiveChrome(props: { muted: boolean; title: string }) {
  return (
    <div className="w-[520px] bg-neutral-950 p-4 text-neutral-100">
      <div className="mb-2 text-sm font-semibold uppercase tracking-wide text-neutral-500">{props.title}</div>
      <div className="flex items-center justify-between rounded-md bg-neutral-900 px-4 py-3">
        <div className="flex items-start gap-2">
          <span className="mt-1 text-lg leading-none text-red-500">●</span>
          <div className="text-lg font-semibold">LIVE 12:04</div>
        </div>
        <span className="text-sm text-neutral-400">Setup</span>
      </div>
      <div className="mt-4">
        <LiveMicrophoneOffBanner muted={props.muted} />
      </div>
      <div className="mt-4 grid grid-cols-2 gap-3">
        {["ME", "TABLE", "BOTH", "BREAK"].map((key) => (
          <div key={key} className="flex h-24 items-center justify-center rounded-md bg-neutral-900 text-xl font-semibold">
            {key}
          </div>
        ))}
      </div>
      <div className="mt-4 rounded-md bg-neutral-900 p-3 text-sm text-neutral-400">Clips panel is below — banner stays up top</div>
    </div>
  );
}

function Shot() {
  return (
    <div id="contact-sheet" className="flex min-h-screen gap-8 bg-neutral-950 p-8">
      <LiveChrome muted={false} title="Unmuted" />
      <LiveChrome muted={true} title="Muted" />
    </div>
  );
}

const root = document.getElementById("root");
if (root) ReactDOM.createRoot(root).render(<Shot />);
