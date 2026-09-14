import type { WhatnotStudioApi } from "../../electron/preload.js";

declare global {
  interface Window {
    whatnotStudio: WhatnotStudioApi;
  }
}

export {};
