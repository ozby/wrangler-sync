import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: { index: "src/index.ts" },
    format: ["esm"],
    dts: true,
    clean: true,
    outDir: "dist",
  },
  {
    entry: { "bin/wrangler-sync": "bin/wrangler-sync.ts" },
    format: ["esm"],
    dts: false,
    outDir: "dist",
    banner: {
      js: "#!/usr/bin/env node",
    },
  },
]);
