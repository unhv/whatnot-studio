import ReactDOM from "react-dom/client";
import "../src/renderer/index.css";
import { ShowPicker } from "../src/renderer/SetupScreen.js";
import type { PersistedShow } from "../src/state/showStore.js";
import { persistableShowConfig } from "../src/state/store.js";

const shows: PersistedShow[] = [
  {
    name: "Saturday Night Vintage",
    config: persistableShowConfig({
      showName: "Saturday Night Vintage",
      camera: { deviceId: "cam-sat", label: "Elgato Facecam" },
      mic: { deviceId: "mic-sat", label: "Shure MV7" },
      captureCard: { deviceId: "cap-sat", label: "Cam Link 4K" },
      obsPassword: "",
      obsPort: 4455,
    }),
    cameraLayout: null,
    textStyle: null,
  },
  {
    name: "Sneaker Drop",
    config: persistableShowConfig({
      showName: "Sneaker Drop",
      camera: { deviceId: "cam-snk", label: "Logitech Brio" },
      mic: { deviceId: "mic-snk", label: "Rode Wireless" },
      captureCard: null,
      obsPassword: "",
      obsPort: 4455,
    }),
    cameraLayout: null,
    textStyle: null,
  },
];

function Shot() {
  return (
    <div className="min-h-screen w-[520px] bg-neutral-950 p-8 text-neutral-100">
      <h1 className="mb-6 text-2xl font-semibold">Whatnot Studio — Setup</h1>
      <ShowPicker
        shows={shows}
        lastUsedName="Saturday Night Vintage"
        activeName="Saturday Night Vintage"
        onPick={() => {}}
        onStartNew={() => {}}
      />
    </div>
  );
}

const root = document.getElementById("root");
if (root) ReactDOM.createRoot(root).render(<Shot />);
