import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
  main: string;
  scripts: Record<string, string>;
  build: {
    appId: string;
    productName: string;
    directories: { output: string };
    files: Array<string | { from: string; to: string }>;
    win: { icon: string; target: unknown; signAndEditExecutable?: boolean };
    nsis: {
      oneClick: boolean;
      perMachine: boolean;
      allowToChangeInstallationDirectory: boolean;
    };
  };
  devDependencies: Record<string, string>;
};

describe("windows installer packaging", () => {
  it("has a dist script and electron-builder, not a second config file", () => {
    expect(pkg.scripts.dist).toMatch(/electron-builder/);
    expect(pkg.devDependencies["electron-builder"]).toBeTruthy();
    expect(pkg.devDependencies["electron-updater"]).toBeUndefined();
    expect(existsSync(path.join(root, "electron-builder.yml"))).toBe(false);
    expect(existsSync(path.join(root, "electron-builder.yaml"))).toBe(false);
  });

  it("builds a per-user NSIS installer named Whatnot Studio", () => {
    expect(pkg.build.appId).toBe("com.whatnotstudio.app");
    expect(pkg.build.productName).toBe("Whatnot Studio");
    expect(pkg.build.directories.output).toBe("release");
    expect(pkg.build.win.icon).toBe("build/icon.ico");
    expect(JSON.stringify(pkg.build.win.target)).toMatch(/nsis/);
    expect(pkg.build.nsis.oneClick).toBe(false);
    expect(pkg.build.nsis.perMachine).toBe(false);
    expect(pkg.build.nsis.allowToChangeInstallationDirectory).toBe(true);
    expect(existsSync(path.join(root, "build", "icon.ico"))).toBe(true);
  });

  it("maps the vite renderer to the path electron/main.ts loadFile uses", () => {
    // electron/tsconfig emits main at dist-electron/electron/main.js (package.json "main").
    // createWindow does: loadFile(path.join(__dirname, "..", "dist", "index.html"))
    // so the packaged tree must contain dist-electron/dist/index.html, not repo-root dist/.
    expect(pkg.main.replaceAll("\\", "/")).toBe("dist-electron/electron/main.js");
    const mapped = pkg.build.files.find(
      (entry): entry is { from: string; to: string } =>
        typeof entry === "object" && entry.from === "dist"
    );
    expect(mapped?.to.replaceAll("\\", "/")).toBe("dist-electron/dist");

    const loadPath = path.join("dist-electron", "electron", "..", "dist", "index.html");
    expect(path.normalize(loadPath)).toBe(path.normalize("dist-electron/dist/index.html"));
  });

  it("emits the sandboxed preload as CommonJS, not ESM", () => {
    const electronTsconfig = JSON.parse(
      readFileSync(path.join(root, "electron", "tsconfig.json"), "utf8")
    ) as { include: string[] };
    const preloadTsconfig = JSON.parse(
      readFileSync(path.join(root, "electron", "tsconfig.preload.json"), "utf8")
    ) as { compilerOptions: { module: string }; include: string[] };

    expect(electronTsconfig.include).not.toContain("preload.ts");
    expect(preloadTsconfig.include).toContain("preload.ts");
    expect(preloadTsconfig.compilerOptions.module.toLowerCase()).toBe("commonjs");
    expect(pkg.scripts["build:electron"]).toMatch(/tsconfig\.preload\.json/);
  });

  it("does not disable win.signAndEditExecutable", () => {
    expect(pkg.build.win.signAndEditExecutable).toBeUndefined();
  });

  it("keeps sandbox and contextIsolation on", () => {
    const main = readFileSync(path.join(root, "electron", "main.ts"), "utf8");
    expect(main).toMatch(/sandbox:\s*true/);
    expect(main).toMatch(/contextIsolation:\s*true/);
    expect(main).toMatch(/preload:\s*path\.join\(__dirname,\s*"preload\.js"\)/);
  });
});
