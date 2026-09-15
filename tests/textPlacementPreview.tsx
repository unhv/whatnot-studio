import { useState } from "react";
import ReactDOM from "react-dom/client";
import "../src/renderer/index.css";
import TextPlacementControl from "../src/renderer/TextPlacementControl.js";
import { initialTextStyleState, textStyleReducer, type TextStyleAction } from "../src/state/textStyle.js";

function Preview() {
  const [state, setState] = useState(initialTextStyleState);
  const dispatch = (action: TextStyleAction) => setState((s) => textStyleReducer(s, action));
  return (
    <div className="w-[520px] p-4">
      <TextPlacementControl
        state={state}
        dispatch={dispatch}
        onRestore={() => {}}
        itemPreview="Vintage Mug — $12"
      />
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(<Preview />);
