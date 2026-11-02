import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const at = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// The moved code still imports its old `@codmir/sdk/...` specifiers; resolve them in the workspace.
export default defineConfig({
  define: { __SDK_VERSION__: JSON.stringify("0.0.0") },
  resolve: {
    alias: [
      { find: "@codmir/sdk/runtime/protocol", replacement: at("./src/runtime/protocol/index.ts") },
      { find: "@codmir/sdk/overseer", replacement: at("../../src/overseer/index.ts") },
      { find: "@codmir/sdk/types", replacement: at("../../src/types.ts") },
      { find: /^@codmir\/sdk$/, replacement: at("../../src/index.ts") },
    ],
  },
});
