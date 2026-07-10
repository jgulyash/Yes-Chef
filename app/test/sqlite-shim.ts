// Test-only shim. Vite/Vitest can't bundle node:sqlite (it's experimental and absent
// from module.builtinModules), so under test we alias "node:sqlite" to this file, which
// pulls the real built-in through createRequire — Node resolves it natively.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const sqlite = require("node:sqlite");
export const DatabaseSync = sqlite.DatabaseSync;
