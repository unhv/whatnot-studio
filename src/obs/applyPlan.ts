/**
 * Reads OBS's actual current state over the websocket and applies a
 * compiled scene plan. This is the only place `compileScenePlan`'s ops
 * turn into real `ObsClient.call` requests — kept separate from
 * sceneCompiler.ts so the compiler itself stays pure and unit-testable
 * without OBS.
 */
import type { ObsClient } from "./client.js";
import {
  applyOpsToState,
  compileScenePlan,
  type CurrentInput,
  type CurrentObsState,
  type CurrentScene,
  type DesiredScene,
} from "./sceneCompiler.js";

interface GetSceneListResponse {
  scenes: { sceneName: string }[];
}
interface GetInputListResponse {
  inputs: { inputName: string; inputKind: string }[];
}
interface GetSceneItemListResponse {
  sceneItems: { sourceName: string; sceneItemEnabled: boolean; sceneItemTransform?: Record<string, number> }[];
}

/** Read the parts of OBS's current state the scene compiler cares about. */
export async function readCurrentObsState(obs: ObsClient): Promise<CurrentObsState> {
  const sceneList = await obs.call<GetSceneListResponse>("GetSceneList");
  const inputList = await obs.call<GetInputListResponse>("GetInputList");

  const inputs: CurrentInput[] = inputList.inputs.map((i) => ({ name: i.inputName, kind: i.inputKind }));

  const scenes: CurrentScene[] = [];
  for (const s of sceneList.scenes) {
    let items: GetSceneItemListResponse["sceneItems"] = [];
    try {
      const res = await obs.call<GetSceneItemListResponse>("GetSceneItemList", { sceneName: s.sceneName });
      items = res.sceneItems;
    } catch {
      items = [];
    }
    scenes.push({
      name: s.sceneName,
      items: items.map((it) => ({
        sourceName: it.sourceName,
        enabled: it.sceneItemEnabled,
        transform: it.sceneItemTransform
          ? {
              positionX: it.sceneItemTransform.positionX,
              positionY: it.sceneItemTransform.positionY,
              scaleX: it.sceneItemTransform.scaleX,
              scaleY: it.sceneItemTransform.scaleY,
              cropLeft: it.sceneItemTransform.cropLeft,
              cropRight: it.sceneItemTransform.cropRight,
              cropTop: it.sceneItemTransform.cropTop,
              cropBottom: it.sceneItemTransform.cropBottom,
            }
          : undefined,
      })),
    });
  }

  return { scenes, inputs };
}

/** Compile and apply a plan against OBS's real, freshly-read state.
 * Running this twice in a row issues zero requests the second time. */
export async function syncScenes(obs: ObsClient, desired: DesiredScene[]): Promise<void> {
  const current = await readCurrentObsState(obs);
  const ops = compileScenePlan(desired, current);

  // Applied sequentially and in the order compiled — a create must land
  // before the transform/enable ops that depend on it existing.
  for (const op of ops) {
    switch (op.type) {
      case "CreateInput":
        await obs.call("CreateInput", {
          sceneName: desired[0]?.sceneName, // OBS requires a scene target; first desired scene is a safe default holder
          inputName: op.inputName,
          inputKind: op.inputKind,
          inputSettings: op.inputSettings ?? {},
        });
        break;
      case "CreateScene":
        await obs.call("CreateScene", { sceneName: op.sceneName });
        break;
      case "CreateSceneItem":
        await obs.call("CreateSceneItem", { sceneName: op.sceneName, sourceName: op.sourceName });
        break;
      case "SetSceneItemTransform": {
        const itemId = await resolveSceneItemId(obs, op.sceneName, op.sourceName);
        await obs.call("SetSceneItemTransform", {
          sceneName: op.sceneName,
          sceneItemId: itemId,
          sceneItemTransform: op.transform,
        });
        break;
      }
      case "SetSceneItemEnabled": {
        const itemId = await resolveSceneItemId(obs, op.sceneName, op.sourceName);
        await obs.call("SetSceneItemEnabled", {
          sceneName: op.sceneName,
          sceneItemId: itemId,
          sceneItemEnabled: op.enabled,
        });
        break;
      }
    }
  }

  // Sanity check only in dev — never trusted, OBS's own state always wins.
  applyOpsToState(current, ops);
}

interface GetSceneItemListWithIdsResponse {
  sceneItems: { sourceName: string; sceneItemId: number }[];
}

async function resolveSceneItemId(obs: ObsClient, sceneName: string, sourceName: string): Promise<number> {
  const res = await obs.call<GetSceneItemListWithIdsResponse>("GetSceneItemList", { sceneName });
  const item = res.sceneItems.find((i) => i.sourceName === sourceName);
  if (!item) throw new Error(`scene item "${sourceName}" not found in scene "${sceneName}" after create`);
  return item.sceneItemId;
}
