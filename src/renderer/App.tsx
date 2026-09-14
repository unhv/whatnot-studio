import { useEffect } from "react";
import { useAppStore } from "../state/store.js";
import SetupScreen from "./SetupScreen.js";
import LiveScreen from "./LiveScreen.js";

/** One window, one store, no router — the brief's words. Which of the two
 * screens is visible is just `screen` in the Zustand store. */
export default function App() {
  const screen = useAppStore((s) => s.screen);
  const dispatchItemBar = useAppStore((s) => s.dispatchItemBar);
  const setActiveScene = useAppStore((s) => s.setActiveScene);

  // F1-F4 switch scenes, F5 is SOLD — global because focus usually lives in
  // the seller's browser tab, not this window. Registered once for the
  // whole app's lifetime, not per-screen, so a stray keypress on the Setup
  // screen is a no-op rather than a crash.
  useEffect(() => {
    const unsubscribe = window.whatnotStudio.onHotkey((key) => {
      if (screen !== "live") return;
      switch (key) {
        case "F1":
          setActiveScene("ME");
          break;
        case "F2":
          setActiveScene("TABLE");
          break;
        case "F3":
          setActiveScene("BOTH");
          break;
        case "F4":
          setActiveScene("BREAK");
          break;
        case "F5":
          dispatchItemBar({ type: "SOLD", now: Date.now() });
          break;
      }
    });
    return unsubscribe;
  }, [screen, setActiveScene, dispatchItemBar]);

  return screen === "setup" ? <SetupScreen /> : <LiveScreen />;
}
