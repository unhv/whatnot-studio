import { contextBridge, ipcRenderer } from "electron";

export interface FirstRunPaths {
  profileIniPath: string;
  sceneCollectionJsonPath: string;
  streamEncoderJsonPath: string;
}

const api = {
  firstRunPaths: (profileName?: string): Promise<FirstRunPaths> => ipcRenderer.invoke("firstRun:paths", profileName),

  writeFirstRunFiles: (args: {
    profileIniPath?: string;
    sceneCollectionJsonPath?: string;
    profileIni?: string;
    sceneCollectionJson?: string;
    streamEncoderJsonPath?: string;
    streamEncoderJson?: string;
  }): Promise<void> => ipcRenderer.invoke("firstRun:writeFiles", args),

  launchObs: (opts: { port: number; password: string; profileName?: string }): Promise<{
    pid: number;
    reused: boolean;
  }> => ipcRenderer.invoke("obs:launch", opts),

  closeObs: (pid: number): Promise<void> => ipcRenderer.invoke("obs:close", pid),

  openExternal: (url: string): Promise<void> => ipcRenderer.invoke("shell:openExternal", url),

  // Whatnot requires Chrome specifically for Show Tools -- see electron/main.ts.
  openInChrome: (url: string): Promise<void> => ipcRenderer.invoke("shell:openInChrome", url),

  copyToClipboard: (text: string): Promise<void> => ipcRenderer.invoke("clipboard:write", text),

  // Structural result of OBS's own obs-websocket config.json. The password
  // field is only present when OBS wrote one; never log this return value.
  readObsWebsocketConfig: (): Promise<{
    reason: "ok" | "missing-file" | "malformed" | "server-disabled";
    serverEnabled?: boolean;
    serverPort?: number;
    authRequired?: boolean;
    serverPassword?: string;
  }> => ipcRenderer.invoke("obs:websocketConfig"),

  onHotkey: (callback: (key: "F1" | "F2" | "F3" | "F4" | "F5") => void): (() => void) => {
    const listener = (_event: unknown, key: "F1" | "F2" | "F3" | "F4" | "F5") => callback(key);
    ipcRenderer.on("hotkey", listener);
    return () => ipcRenderer.removeListener("hotkey", listener);
  },
};

export type WhatnotStudioApi = typeof api;

contextBridge.exposeInMainWorld("whatnotStudio", api);
