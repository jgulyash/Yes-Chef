import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// node:sqlite is experimental and (deliberately) absent from module.builtinModules,
// so Vite tries to bundle it and fails. Under test we alias it to a shim that pulls
// the real built-in via createRequire (Node resolves it natively). Production code
// (tsx/Node) imports node:sqlite directly and is unaffected by this config.
export default defineConfig({
  test: {
    environment: "node",
    alias: {
      "node:sqlite": fileURLToPath(new URL("./test/sqlite-shim.ts", import.meta.url)),
    },
  },
});
